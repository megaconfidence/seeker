import { randomUUID } from 'node:crypto'
import { config } from '../config.ts'
import { logger } from '../log.ts'
import { sleep } from '../util.ts'
import { slskd, SlskdError, type SlskdResponse } from './slskd.ts'

const log = logger('search')

// The Soulseek server bans clients for 30 minutes after roughly 34 searches in 220 seconds.
const WINDOW_MS = 220_000
const MAX_PER_WINDOW = 32
const MIN_GAP_MS = config.timing.searchGapMs

let stamps: number[] = []
let cooldownUntil = 0
let busy = false
const waiting: { interactive: boolean; resolve: () => void }[] = []

function release() {
  busy = false
  const nextIndex = waiting.findIndex((entry) => entry.interactive)
  const next = waiting.splice(nextIndex >= 0 ? nextIndex : 0, 1)[0]
  if (next) {
    busy = true
    next.resolve()
  }
}

async function acquire(interactive: boolean): Promise<void> {
  if (!busy) {
    busy = true
  } else {
    await new Promise<void>((resolve) => waiting.push({ interactive, resolve }))
  }
  for (;;) {
    const now = Date.now()
    stamps = stamps.filter((stamp) => now - stamp < WINDOW_MS)
    let at = Math.max(now, cooldownUntil)
    const last = stamps[stamps.length - 1]
    if (last !== undefined) at = Math.max(at, last + MIN_GAP_MS)
    if (stamps.length >= MAX_PER_WINDOW) at = Math.max(at, stamps[0]! + WINDOW_MS)
    if (at <= now) {
      stamps.push(now)
      return
    }
    await sleep(Math.min(at - now, 5000))
  }
}

export function searchQueueLength() {
  return waiting.length + (busy ? 1 : 0)
}

// How many searches are left in the current ban-avoidance window.
export function searchBudget() {
  const now = Date.now()
  const used = stamps.filter((stamp) => now - stamp < WINDOW_MS).length
  return { used, limit: MAX_PER_WINDOW, waiting: waiting.length }
}

export interface SearchProgress {
  state: string
  responses: number
  files: number
}

export interface SearchOptions {
  interactive?: boolean
  idleTimeoutMs?: number
  deadlineMs?: number
  onStart?: (id: string) => void
  onProgress?: (progress: SearchProgress) => void
}

export interface SearchOutcome {
  id: string
  query: string
  state: string
  responses: SlskdResponse[]
}

export async function searchSoulseek(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
  const searchText = query.replace(/\s+/g, ' ').trim()
  if (!searchText) throw new Error('Empty search')
  await acquire(!!options.interactive)
  const id = randomUUID()
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await slskd.startSearch({
          id,
          searchText,
          searchTimeout: options.idleTimeoutMs ?? config.timing.searchIdleMs,
          responseLimit: 250,
          fileLimit: 25_000,
          filterResponses: true,
          minimumResponseFileCount: 1,
        })
        break
      } catch (error) {
        if (error instanceof SlskdError && error.status === 429 && attempt < 5) {
          // Another client is starting a search on the same slskd; wait our turn.
          await sleep(3000 * (attempt + 1))
          continue
        }
        if (error instanceof SlskdError && error.status === 409) {
          throw new Error('slskd is not connected to the Soulseek network')
        }
        throw error
      }
    }
    options.onStart?.(id)
    log.debug(`Searching "${searchText}"`)

    const deadline = Date.now() + (options.deadlineMs ?? 45_000)
    let stopped = false
    let state = 'Requested'
    let expected = 0
    for (;;) {
      await sleep(1000)
      let search
      try {
        search = await slskd.getSearch(id)
      } catch (error) {
        log.warn(`Polling search failed`, error)
        if (Date.now() > deadline + 15_000) throw error
        continue
      }
      state = search.state
      expected = search.responseCount
      options.onProgress?.({ state, responses: search.responseCount, files: search.fileCount })
      if (search.isComplete) break
      if (!stopped && Date.now() > deadline) {
        stopped = true
        await slskd.stopSearch(id).catch(() => {})
      } else if (stopped && Date.now() > deadline + 15_000) {
        // slskd can occasionally leave a search hanging; give up on it.
        break
      }
    }
    // slskd flags the search complete a moment before it has stored the responses, so a large
    // result set can briefly read as empty.
    const fetchResponses = () =>
      slskd.searchResponses(id).catch((error) => {
        log.warn('Could not fetch search responses', error)
        return [] as SlskdResponse[]
      })
    let responses = await fetchResponses()
    for (let attempt = 0; responses.length === 0 && expected > 0 && attempt < 15; attempt++) {
      await sleep(1000)
      responses = await fetchResponses()
    }
    log.debug(`"${searchText}": ${responses.length} responses (${state})`)
    return { id, query: searchText, state, responses }
  } finally {
    release()
    slskd.deleteSearch(id).catch(() => {})
  }
}
