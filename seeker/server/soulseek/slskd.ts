import { config } from '../config.ts'
import { logger } from '../log.ts'

const log = logger('slskd')

export class SlskdError extends Error {
  // 0 when slskd didn't answer at all.
  status: number
  // slskd was reached but didn't answer in time, as happens while it scans a big share.
  timedOut: boolean
  constructor(message: string, status: number, timedOut = false) {
    super(message)
    this.status = status
    this.timedOut = timedOut
  }
}

export interface SlskdSearch {
  id: string
  searchText: string
  state: string
  isComplete: boolean
  responseCount: number
  fileCount: number
  lockedFileCount?: number
}

export interface SlskdFile {
  filename: string
  size: number
  extension?: string
  bitRate?: number
  bitDepth?: number
  sampleRate?: number
  length?: number
  isVariableBitRate?: boolean
  isLocked?: boolean
}

export interface SlskdResponse {
  username: string
  hasFreeUploadSlot: boolean
  uploadSpeed: number
  queueLength: number
  fileCount: number
  files: SlskdFile[]
}

export interface SlskdTransfer {
  id: string
  batchId?: string
  username: string
  filename: string
  size: number
  state: string
  bytesTransferred: number
  averageSpeed: number
  percentComplete: number
  placeInQueue?: number | null
  exception?: string | null
  attempts?: number
  removed?: boolean
}

interface TransferListing {
  username: string
  directories: { directory: string; files: SlskdTransfer[] }[]
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  if (!config.slskdApiKey) throw new SlskdError('SLSKD_API_KEY is not set', 0)
  let response: Response
  try {
    response = await fetch(`${config.slskdUrl}/api/v0/${path}`, {
      method,
      headers: {
        'X-API-Key': config.slskdApiKey,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError'
    throw new SlskdError(`slskd unreachable at ${config.slskdUrl}: ${(error as Error).message}`, 0, timedOut)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new SlskdError(text.slice(0, 300) || `slskd returned HTTP ${response.status}`, response.status)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const slskd = {
  application: () =>
    request<{
      version?: { current?: string }
      server?: { state?: string; isConnected?: boolean; isLoggedIn?: boolean }
      shares?: { scanning?: boolean; directories?: number; files?: number }
    }>('GET', 'application', undefined, 8000),

  connect: () => request<void>('PUT', 'server', undefined, 15_000),

  // Starts a rescan of slskd's shared folders and returns at once; slskd scans in the background.
  // Throws a 409 SlskdError when a scan is already running (see server/shares.ts).
  rescanShares: () => request<void>('PUT', 'shares', undefined, 15_000),

  options: () =>
    request<{ soulseek?: { username?: string }; directories?: { downloads?: string } }>('GET', 'options', undefined, 8000),

  startSearch: (body: {
    id: string
    searchText: string
    searchTimeout: number
    responseLimit: number
    fileLimit: number
    filterResponses: boolean
    minimumResponseFileCount: number
  }) => request<SlskdSearch>('POST', 'searches', body),

  getSearch: (id: string) => request<SlskdSearch>('GET', `searches/${id}`),
  searchResponses: (id: string) => request<SlskdResponse[]>('GET', `searches/${id}/responses`, undefined, 60_000),
  stopSearch: (id: string) => request<void>('PUT', `searches/${id}`),
  deleteSearch: (id: string) => request<void>('DELETE', `searches/${id}`),

  enqueue: (username: string, files: { filename: string; size: number }[], destination: string) =>
    request<{
      batch?: { id: string; transfers?: SlskdTransfer[] }
      failures?: { filename: string; message: string }[]
    }>('POST', 'transfers/downloads/batches', { username, files, options: { destination } }, 60_000),

  async downloads(): Promise<SlskdTransfer[]> {
    const listing = await request<TransferListing[]>('GET', 'transfers/downloads')
    const transfers: SlskdTransfer[] = []
    for (const user of listing ?? []) {
      for (const directory of user.directories ?? []) transfers.push(...(directory.files ?? []))
    }
    return transfers
  },

  cancel: async (username: string, id: string, remove = true) => {
    const path = `transfers/downloads/${encodeURIComponent(username)}/${id}`
    try {
      await request<void>('DELETE', `${path}?remove=${remove}`)
    } catch (error) {
      if (error instanceof SlskdError && error.status === 404) return
      log.warn(`Could not cancel transfer ${id}`, error)
    }
    // A transfer that was still queued only finishes cancelling after the call returns, and
    // slskd won't remove it from its list until then; ask again shortly.
    if (remove) {
      setTimeout(() => void request<void>('DELETE', `${path}?remove=true`).catch(() => {}), 5000).unref()
    }
  },

  // Asks the remote user where this download is in their queue. slskd only knows when asked.
  placeInQueue: async (username: string, id: string): Promise<number | null> => {
    try {
      const place = await request<number>('GET', `transfers/downloads/${encodeURIComponent(username)}/${id}/position`, undefined, 20_000)
      return typeof place === 'number' && place > 0 ? place : null
    } catch {
      return null
    }
  },

  browseDirectory: (username: string, directory: string) =>
    request<{ name: string; files: SlskdFile[] }[] | { name: string; files: SlskdFile[] }>(
      'POST',
      `users/${encodeURIComponent(username)}/directory`,
      { directory },
      45_000,
    ),
}

// slskd transfer states are comma-joined flags, e.g. "Completed, Succeeded" or "Queued, Remotely".
export type TransferVerdict = 'succeeded' | 'failed' | 'queued' | 'active' | 'pending'

export function classifyTransfer(state: string | undefined): TransferVerdict {
  const flags = new Set((state ?? '').split(',').map((flag) => flag.trim().toLowerCase()))
  if (flags.has('completed')) return flags.has('succeeded') ? 'succeeded' : 'failed'
  if (['errored', 'rejected', 'timedout', 'cancelled', 'aborted'].some((flag) => flags.has(flag))) return 'failed'
  if (flags.has('inprogress') || flags.has('initializing')) return 'active'
  if (flags.has('queued')) return 'queued'
  return 'pending'
}
