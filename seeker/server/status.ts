import type { AppStatus, SlskdStatus } from '../shared/types.ts'
import { config } from './config.ts'
import { emit } from './events.ts'
import { statusCounts } from './jobs/store.ts'
import { isScanning, libraryCounts } from './library/scan.ts'
import { logger } from './log.ts'
import { noteLibraryChange, noteSlskdShares, onShareRescanChange, shareRescanStatus } from './shares.ts'
import { slskd } from './soulseek/slskd.ts'
import { errorMessage } from './util.ts'

const log = logger('status')

const offline = (error: string | null): SlskdStatus => ({
  reachable: false,
  connected: false,
  loggedIn: false,
  username: null,
  state: null,
  error,
  sharedFiles: null,
  sharedFolders: null,
  scanningShares: false,
})

let current: SlskdStatus = offline(config.slskdApiKey ? null : 'SLSKD_API_KEY is not set')
let username: { value: string | null; at: number } = { value: null, at: 0 }
const readyListeners = new Set<() => void>()
let failures = 0
let checkedShares = false

export function onSoulseekReady(listener: () => void) {
  readyListeners.add(listener)
}

export function soulseekReady(): boolean {
  return current.loggedIn
}

export function slskdStatus(): SlskdStatus {
  return current
}

export function appStatus(): AppStatus {
  return {
    version: config.version,
    commit: config.commit || null,
    slskd: current,
    shareRescan: shareRescanStatus(),
    jobs: statusCounts(),
    library: { ...libraryCounts(), scanning: isScanning() },
  }
}

onShareRescanChange(() => emit({ type: 'status', status: appStatus() }))

async function poll() {
  const at = Date.now()
  let next: SlskdStatus
  try {
    const app = await slskd.application()
    if (Date.now() - username.at > 5 * 60_000 || !username.value) {
      const options = await slskd.options().catch(() => null)
      username = { value: options?.soulseek?.username || null, at: Date.now() }
    }
    next = {
      reachable: true,
      connected: !!app.server?.isConnected,
      loggedIn: !!app.server?.isLoggedIn,
      username: username.value,
      state: app.server?.state ?? null,
      error: null,
      sharedFiles: app.shares?.files ?? null,
      sharedFolders: app.shares?.directories ?? null,
      scanningShares: !!app.shares?.scanning,
    }
    failures = 0
    noteSlskdShares({ reachable: true, scanning: next.scanningShares, at })
    // slskd only scans shares at startup; if it shares nothing but the library has music, rescan.
    if (!checkedShares) {
      checkedShares = true
      if (next.sharedFiles === 0 && !next.scanningShares && libraryCounts().tracks > 0) noteLibraryChange()
    }
  } catch (error) {
    failures++
    if (failures === 1) log.warn(`Cannot reach slskd: ${errorMessage(error)}`)
    next = offline(errorMessage(error))
    noteSlskdShares({ reachable: false, scanning: false, at })
  }
  const changed = JSON.stringify(next) !== JSON.stringify(current)
  const becameReady = next.loggedIn && !current.loggedIn
  current = next
  if (changed) {
    if (becameReady) log.info(`Connected to Soulseek as ${next.username ?? 'unknown user'}`)
    emit({ type: 'status', status: appStatus() })
  }
  if (becameReady) for (const listener of readyListeners) listener()
}

export function startStatus() {
  void poll()
  setInterval(() => void poll(), config.timing.statusMs).unref()
}
