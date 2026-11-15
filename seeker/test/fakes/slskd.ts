import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

// An in-process stand-in for slskd's HTTP API (/api/v0) covering what Seeker calls: status, options,
// share rescans, searches, browsing a peer's folder and download transfers. Tests decide which peers
// exist, what they share and what happens to each requested file.

export type Behaviour =
  // Progresses for a couple of polls, then completes and the file appears in the downloads folder.
  | 'succeed'
  // Sits in the peer's queue ("Queued, Remotely") forever.
  | 'stall'
  // Starts, then ends "Completed, Errored".
  | 'fail'
  // Ends "Completed, Rejected" on the first poll.
  | 'reject'
  // Drops out of slskd's transfer list after the first poll, as if slskd had restarted.
  | 'vanish'

export interface SharedFile {
  // Full remote path as Soulseek reports it, e.g. "@@alice\\Music\\Artist\\Album\\01 - Song.flac".
  filename: string
  // Local audio file copied into the downloads folder when a transfer of this file succeeds.
  fixture: string
  size: number
  length?: number
  bitRate?: number
  bitDepth?: number
  sampleRate?: number
  behaviour?: Behaviour
}

export interface PeerOptions {
  username: string
  files: SharedFile[]
  freeSlot?: boolean
  uploadSpeed?: number
  queueLength?: number
}

interface Peer {
  username: string
  files: SharedFile[]
  freeSlot: boolean
  uploadSpeed: number
  queueLength: number
}

export interface FakeTransfer {
  id: string
  batchId: string
  username: string
  filename: string
  size: number
  state: string
  bytesTransferred: number
  averageSpeed: number
  placeInQueue: number | null
  exception: string | null
  requestedAt: string
  destination: string
  behaviour: Behaviour
  fixture: string
  polls: number
  removed: boolean
  // Where the file was written when the transfer succeeded.
  deliveredTo: string | null
}

interface SearchFile {
  filename: string
  size: number
  extension: string
  length?: number
  bitRate?: number
  bitDepth?: number
  sampleRate?: number
  isLocked: boolean
}

interface SearchResponse {
  username: string
  token: number
  hasFreeUploadSlot: boolean
  uploadSpeed: number
  queueLength: number
  fileCount: number
  lockedFileCount: number
  files: SearchFile[]
  lockedFiles: SearchFile[]
}

export interface FakeSearch {
  id: string
  searchText: string
  polls: number
  stopped: boolean
  deleted: boolean
  responses: SearchResponse[]
}

export interface Batch {
  id: string
  username: string
  destination: string
  files: { filename: string; size: number }[]
}

export interface Cancellation {
  username: string
  id: string
  remove: boolean
  found: boolean
  stateBefore: string | null
  destination: string | null
}

export interface RequestRecord {
  method: string
  path: string
  status: number
}

type Send = (status: number, payload?: unknown) => void

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

function remoteDir(filename: string): string {
  const index = Math.max(filename.lastIndexOf('\\'), filename.lastIndexOf('/'))
  return index >= 0 ? filename.slice(0, index) : ''
}

function remoteBasename(filename: string): string {
  return filename.slice(Math.max(filename.lastIndexOf('\\'), filename.lastIndexOf('/')) + 1)
}

// slskd renames a download whose name is taken to "<stem>_<.NET ticks><ext>".
const dotnetTicks = () => (BigInt(Date.now()) * 10_000n + 621_355_968_000_000_000n).toString()

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function fileView(file: SharedFile, filename: string): SearchFile {
  const name = remoteBasename(file.filename)
  const dot = name.lastIndexOf('.')
  return {
    filename,
    size: file.size,
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    length: file.length,
    bitRate: file.bitRate,
    bitDepth: file.bitDepth,
    sampleRate: file.sampleRate,
    isLocked: false,
  }
}

function transferView(transfer: FakeTransfer) {
  return {
    id: transfer.id,
    username: transfer.username,
    direction: 'Download',
    filename: transfer.filename,
    size: transfer.size,
    startOffset: 0,
    state: transfer.state,
    requestedAt: transfer.requestedAt,
    bytesTransferred: transfer.bytesTransferred,
    bytesRemaining: transfer.size - transfer.bytesTransferred,
    averageSpeed: transfer.averageSpeed,
    percentComplete: transfer.size ? (transfer.bytesTransferred / transfer.size) * 100 : 0,
    placeInQueue: transfer.placeInQueue,
    exception: transfer.exception,
  }
}

export class FakeSlskd {
  readonly apiKey: string
  readonly downloadsDir: string
  url = ''
  // Polls of GET searches/{id} that report "InProgress" before the search completes.
  searchPollsInProgress = 1
  // Polls of GET transfers/downloads a succeeding transfer spends "InProgress" before it completes.
  transferPollsInProgress = 2
  readonly peers = new Map<string, Peer>()
  readonly searches: FakeSearch[] = []
  readonly transfers: FakeTransfer[] = []
  readonly batches: Batch[] = []
  readonly browses: { username: string; directory: string }[] = []
  readonly cancellations: Cancellation[] = []
  readonly requests: RequestRecord[] = []
  // Share scans started by PUT /shares, and PUTs refused with 409 because one was running.
  shareRescans = 0
  shareRescanConflicts = 0
  // How long a share scan takes. While one runs, GET application reports shares.scanning.
  shareScanMs = 0
  // What GET application says slskd shares.
  sharedFiles = 42
  #scanningUntil = 0
  #server: http.Server
  #lock: Promise<unknown> = Promise.resolve()
  #token = 1

  constructor(options: { apiKey: string; downloadsDir: string }) {
    this.apiKey = options.apiKey
    this.downloadsDir = options.downloadsDir
    this.#server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(String(error))
      })
    })
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(0, '127.0.0.1', () => resolve())
    })
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
    return this
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  addPeer(options: PeerOptions) {
    this.peers.set(options.username, {
      username: options.username,
      files: options.files,
      freeSlot: options.freeSlot ?? true,
      uploadSpeed: options.uploadSpeed ?? 5_000_000,
      queueLength: options.queueLength ?? 0,
    })
  }

  searchTexts(): string[] {
    return this.searches.map((search) => search.searchText)
  }

  // Transfers Seeker started for one job (it downloads into "seeker/<jobId>").
  transfersFor(jobId: string): FakeTransfer[] {
    return this.transfers.filter((transfer) => transfer.destination === `seeker/${jobId}`)
  }

  batchesFor(jobId: string): Batch[] {
    return this.batches.filter((batch) => batch.destination === `seeker/${jobId}`)
  }

  // Successful cancel calls that hit a transfer which hadn't finished yet.
  cancelledWhileActive(jobId: string): Cancellation[] {
    return this.cancellations.filter(
      (call) => call.found && call.destination === `seeker/${jobId}` && !call.stateBefore?.startsWith('Completed'),
    )
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake-slskd')
    const method = req.method ?? 'GET'
    const raw = await readBody(req)
    let body: unknown
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      body = raw
    }
    const send: Send = (status, payload) => {
      this.requests.push({ method, path: url.pathname + url.search, status })
      if (payload === undefined) {
        res.writeHead(status)
        res.end()
        return
      }
      const json = typeof payload !== 'string'
      res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain' })
      res.end(json ? JSON.stringify(payload) : payload)
    }

    if (req.headers['x-api-key'] !== this.apiKey) return send(401, 'Unauthorized')
    const prefix = '/api/v0/'
    if (!url.pathname.startsWith(prefix)) return send(404, 'Not found')
    const [resource, a, b, c] = url.pathname
      .slice(prefix.length)
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))

    if (method === 'GET' && resource === 'application' && !a) return send(200, this.#application())
    if (method === 'PUT' && resource === 'server' && !a) return send(200)
    if (method === 'GET' && resource === 'options' && !a) {
      return send(200, { soulseek: { username: 'tester' }, directories: { downloads: this.downloadsDir } })
    }
    if (method === 'PUT' && resource === 'shares' && !a) {
      if (this.scanningShares) {
        this.shareRescanConflicts++
        return send(409, 'A share scan is already in progress')
      }
      this.shareRescans++
      this.startShareScan(this.shareScanMs)
      return send(204)
    }
    if (resource === 'searches') return this.#searches(method, a, b, body, send)
    if (resource === 'transfers' && a === 'downloads') {
      return this.#exclusive(() => this.#transfers(method, b, c, url, body, send))
    }
    if (method === 'POST' && resource === 'users' && a && b === 'directory' && !c) return this.#browse(a, body, send)
    return send(404, 'Not found')
  }

  #application() {
    return {
      version: { current: '0.0.0-fake' },
      server: {
        address: 'server.slsknet.invalid:2271',
        state: 'Connected, LoggedIn',
        isConnected: true,
        isLoggedIn: true,
        isTransitioning: false,
      },
      shares: { scanning: this.scanningShares, directories: 1, files: this.sharedFiles },
    }
  }

  // A share scan, as if started from slskd's own interface or its rescan schedule.
  startShareScan(ms: number) {
    this.#scanningUntil = Math.max(this.#scanningUntil, Date.now() + ms)
  }

  get scanningShares(): boolean {
    return Date.now() < this.#scanningUntil
  }

  // ---------- searches ----------

  #searches(method: string, id: string | undefined, sub: string | undefined, body: unknown, send: Send) {
    if (method === 'POST' && !id) {
      const input = body as { id?: unknown; searchText?: unknown } | undefined
      if (typeof input?.id !== 'string' || typeof input.searchText !== 'string' || !input.searchText.trim()) {
        return send(400, 'id and searchText are required')
      }
      if (this.searches.some((search) => search.id === input.id)) return send(409, 'A search with this id already exists')
      const search: FakeSearch = {
        id: input.id,
        searchText: input.searchText,
        polls: 0,
        stopped: false,
        deleted: false,
        responses: this.#respond(input.searchText),
      }
      this.searches.push(search)
      return send(200, this.#searchView(search))
    }
    const search = this.searches.find((item) => item.id === id && !item.deleted)
    if (!search) return send(404, 'Search not found')
    if (method === 'GET' && !sub) {
      search.polls++
      return send(200, this.#searchView(search))
    }
    // Like slskd, responses only become available once the search has completed.
    if (method === 'GET' && sub === 'responses') return send(200, this.#isComplete(search) ? search.responses : [])
    if (method === 'PUT' && !sub) {
      search.stopped = true
      return send(204)
    }
    if (method === 'DELETE' && !sub) {
      search.deleted = true
      return send(204)
    }
    return send(405, 'Method not allowed')
  }

  #isComplete(search: FakeSearch) {
    return search.stopped || search.polls > this.searchPollsInProgress
  }

  #searchView(search: FakeSearch) {
    const complete = this.#isComplete(search)
    return {
      id: search.id,
      searchText: search.searchText,
      state: complete ? (search.stopped ? 'Completed, Cancelled' : 'Completed, TimedOut') : 'InProgress',
      isComplete: complete,
      responseCount: search.responses.length,
      fileCount: search.responses.reduce((sum, response) => sum + response.fileCount, 0),
      lockedFileCount: 0,
    }
  }

  // Peers answer with every shared file whose full path contains all the search words.
  #respond(searchText: string): SearchResponse[] {
    const terms = words(searchText)
    const responses: SearchResponse[] = []
    for (const peer of this.peers.values()) {
      const files = peer.files.filter((file) => {
        const have = new Set(words(file.filename))
        return terms.every((term) => have.has(term))
      })
      if (files.length === 0) continue
      responses.push({
        username: peer.username,
        token: this.#token++,
        hasFreeUploadSlot: peer.freeSlot,
        uploadSpeed: peer.uploadSpeed,
        queueLength: peer.queueLength,
        fileCount: files.length,
        lockedFileCount: 0,
        files: files.map((file) => fileView(file, file.filename)),
        lockedFiles: [],
      })
    }
    return responses
  }

  // ---------- browsing ----------

  #browse(username: string, body: unknown, send: Send) {
    const directory = (body as { directory?: unknown } | undefined)?.directory
    if (typeof directory !== 'string') return send(400, 'directory is required')
    this.browses.push({ username, directory })
    const peer = this.peers.get(username)
    if (!peer) return send(404, `${username} is offline`)
    const files = peer.files.filter((file) => remoteDir(file.filename) === directory)
    // Directory listings carry bare file names; the client prepends the directory.
    return send(200, [
      { name: directory, fileCount: files.length, files: files.map((file) => fileView(file, remoteBasename(file.filename))) },
    ])
  }

  // ---------- transfers ----------

  #exclusive(fn: () => Promise<void> | void): Promise<void> {
    const run = this.#lock.then(fn)
    this.#lock = run.catch(() => {})
    return run
  }

  async #transfers(method: string, user: string | undefined, id: string | undefined, url: URL, body: unknown, send: Send) {
    if (method === 'GET' && !user) {
      // Every poll moves each transfer one step along.
      for (const transfer of this.transfers) await this.#advance(transfer)
      return send(200, this.#listing())
    }
    if (method === 'POST' && user === 'batches' && !id) return this.#enqueue(body, send)
    if (method === 'DELETE' && user && id) {
      const remove = url.searchParams.get('remove') === 'true'
      const transfer = this.transfers.find((item) => item.id === id && item.username === user && !item.removed)
      this.cancellations.push({
        username: user,
        id,
        remove,
        found: !!transfer,
        stateBefore: transfer?.state ?? null,
        destination: transfer?.destination ?? null,
      })
      if (!transfer) return send(404, 'Transfer not found')
      if (!transfer.state.startsWith('Completed')) {
        transfer.state = 'Completed, Cancelled'
        transfer.averageSpeed = 0
        transfer.placeInQueue = null
      }
      if (remove) transfer.removed = true
      return send(204)
    }
    return send(405, 'Method not allowed')
  }

  #enqueue(body: unknown, send: Send) {
    const input = body as
      | { username?: unknown; files?: { filename?: unknown; size?: unknown }[]; options?: { destination?: unknown } }
      | undefined
    if (typeof input?.username !== 'string' || !Array.isArray(input.files)) return send(400, 'username and files are required')
    const username = input.username
    const destination = typeof input.options?.destination === 'string' ? input.options.destination : ''
    const peer = this.peers.get(username)
    const batchId = randomUUID()
    const created: FakeTransfer[] = []
    const failures: { filename: string; message: string }[] = []
    for (const entry of input.files) {
      const filename = typeof entry.filename === 'string' ? entry.filename : ''
      const shared = peer?.files.find((file) => file.filename === filename)
      if (!shared) {
        failures.push({ filename, message: 'File not shared' })
        continue
      }
      const behaviour = shared.behaviour ?? 'succeed'
      created.push({
        id: randomUUID(),
        batchId,
        username,
        filename,
        size: shared.size,
        state: 'Queued, Remotely',
        bytesTransferred: 0,
        averageSpeed: 0,
        placeInQueue: behaviour === 'stall' ? 7 : 0,
        exception: null,
        requestedAt: new Date().toISOString(),
        destination,
        behaviour,
        fixture: shared.fixture,
        polls: 0,
        removed: false,
        deliveredTo: null,
      })
    }
    this.transfers.push(...created)
    this.batches.push({
      id: batchId,
      username,
      destination,
      files: input.files.map((entry) => ({ filename: String(entry.filename), size: Number(entry.size) })),
    })
    return send(201, { batch: { id: batchId, username, transfers: created.map(transferView) }, failures })
  }

  async #advance(transfer: FakeTransfer) {
    if (transfer.removed || transfer.state.startsWith('Completed')) return
    transfer.polls++
    const progress = (fraction: number) => {
      transfer.state = 'InProgress'
      transfer.bytesTransferred = Math.floor(transfer.size * fraction)
      transfer.averageSpeed = 2_000_000
      transfer.placeInQueue = null
    }
    switch (transfer.behaviour) {
      case 'stall':
        return
      case 'reject':
        transfer.state = 'Completed, Rejected'
        transfer.exception = 'File not shared.'
        transfer.placeInQueue = null
        return
      case 'vanish':
        if (transfer.polls > 1) transfer.removed = true
        return
      case 'fail':
        if (transfer.polls === 1) return progress(0.25)
        transfer.state = 'Completed, Errored'
        transfer.exception = 'Remote connection closed'
        transfer.averageSpeed = 0
        return
      case 'succeed':
        if (transfer.polls <= this.transferPollsInProgress) return progress(transfer.polls / (this.transferPollsInProgress + 1))
        // The file is in place before slskd reports the transfer as done.
        transfer.deliveredTo = await this.#deliver(transfer)
        transfer.state = 'Completed, Succeeded'
        transfer.bytesTransferred = transfer.size
        transfer.averageSpeed = 0
        return
    }
  }

  async #deliver(transfer: FakeTransfer): Promise<string> {
    const dir = path.join(this.downloadsDir, ...transfer.destination.split(/[\\/]+/).filter(Boolean))
    await fs.mkdir(dir, { recursive: true })
    const name = remoteBasename(transfer.filename)
    let target = path.join(dir, name)
    if (await exists(target)) {
      const ext = path.extname(name)
      target = path.join(dir, `${name.slice(0, name.length - ext.length)}_${dotnetTicks()}${ext}`)
    }
    await fs.copyFile(transfer.fixture, target)
    return target
  }

  #listing() {
    const users = new Map<string, Map<string, ReturnType<typeof transferView>[]>>()
    for (const transfer of this.transfers) {
      if (transfer.removed) continue
      const dirs = users.get(transfer.username) ?? new Map<string, ReturnType<typeof transferView>[]>()
      users.set(transfer.username, dirs)
      const directory = remoteDir(transfer.filename)
      const files = dirs.get(directory) ?? []
      dirs.set(directory, files)
      files.push(transferView(transfer))
    }
    return [...users].map(([username, dirs]) => ({
      username,
      directories: [...dirs].map(([directory, files]) => ({ directory, fileCount: files.length, files })),
    }))
  }
}
