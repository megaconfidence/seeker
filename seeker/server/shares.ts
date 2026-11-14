import type { ShareRescanStatus } from '../shared/types.ts'
import { subscribe } from './events.ts'
import { statusCounts } from './jobs/store.ts'
import { logger } from './log.ts'
import { getSettings, onSettingsChange } from './settings.ts'
import { slskd, SlskdError } from './soulseek/slskd.ts'
import { errorMessage } from './util.ts'

// slskd only shares new music after it rescans its shared folders, and on a big library, or one on
// a network share, a rescan can keep slskd from answering for minutes. So instead of a rescan per
// import, Seeker asks for one once new music has stopped arriving for a while and nothing is
// downloading. A rescan that was already running when music arrived may have missed it, so Seeker
// asks again once that one ends.

const log = logger('shares')

let timer: ReturnType<typeof setTimeout> | undefined
let dueAt: number | null = null
let lastChangeAt = 0
// The library changed since the last rescan Seeker asked for.
let unshared = false
// When the running rescan (Seeker's or slskd's own) was first seen; null when none is running.
let scanSince: number | null = null
let waitingForDownloads = false
let waitingForSlskd = false
let offNoted = false
let lastPoll = { reachable: false, scanning: false, at: 0 }
const listeners = new Set<() => void>()

export function onShareRescanChange(listener: () => void) {
  listeners.add(listener)
}

function changed() {
  for (const listener of listeners) listener()
}

const automatic = () => getSettings().shares.autoRescan
const quietMs = () => Math.max(0, getSettings().shares.quietMinutes) * 60_000
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)

function quietPeriod(): string {
  const minutes = getSettings().shares.quietMinutes
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? 'an hour' : `${minutes / 60} hours`
  if (minutes >= 1) return `${Math.round(minutes)} ${Math.round(minutes) === 1 ? 'minute' : 'minutes'}`
  return `${Math.round(minutes * 60)} seconds`
}

function schedule(at: number) {
  clearTimeout(timer)
  dueAt = at
  timer = setTimeout(() => void run(), Math.max(0, at - Date.now()))
  timer.unref()
  changed()
}

function cancel() {
  clearTimeout(timer)
  timer = undefined
  dueAt = null
  waitingForDownloads = false
}

// Music was added to or removed from the library, so slskd's shares are out of date.
export function noteLibraryChange() {
  lastChangeAt = Date.now()
  unshared = true
  waitingForDownloads = false
  if (!automatic()) {
    if (!offNoted) log.info('Automatic share rescans are off, so new music is shared after slskd’s next rescan')
    offNoted = true
    return changed()
  }
  // finish() asks again once the running rescan is done.
  if (scanSince !== null) return changed()
  const moving = dueAt !== null
  schedule(lastChangeAt + quietMs())
  log.info(
    moving
      ? `The library changed again, so the share rescan moves to about ${clock(dueAt!)}`
      : `slskd will be asked to rescan its shares at about ${clock(dueAt!)}, once the library hasn’t changed for ${quietPeriod()}`,
  )
}

async function run() {
  timer = undefined
  dueAt = null
  if (!unshared || !automatic() || scanSince !== null) return changed()
  if (statusCounts().active > 0) {
    if (!waitingForDownloads) log.info('Downloads are in progress, so the share rescan waits until they finish')
    waitingForDownloads = true
    return changed()
  }
  waitingForDownloads = false
  await start()
}

type Outcome = 'started' | 'running' | 'unreachable'

async function start(): Promise<Outcome> {
  const askedAt = Date.now()
  const looksIdle = lastPoll.reachable && !lastPoll.scanning
  const covers = lastChangeAt <= askedAt
  // Polls sent before slskd answered may still say it isn't scanning, so the rescan counts from the answer.
  try {
    await slskd.rescanShares()
    scanSince = Date.now()
    if (covers) unshared = false
    log.info('Asked slskd to rescan its shares, so new music is shared')
    return 'started'
  } catch (error) {
    if (error instanceof SlskdError && error.status === 409) {
      // Already scanning, possibly since before the new music arrived: ask again when it's done.
      scanSince = Date.now()
      log.info('slskd is already rescanning its shares; Seeker will ask again when it finishes, so the new music is included')
      return 'running'
    }
    if (error instanceof SlskdError && error.timedOut) {
      // slskd stops answering while it scans a big share. If it was idle a moment ago, the scan is ours.
      scanSince = Date.now()
      if (looksIdle && covers) unshared = false
      log.info('slskd didn’t answer in time, probably because it’s busy rescanning; Seeker waits until it answers again')
      return 'running'
    }
    waitingForSlskd = true
    log.warn(`Could not ask slskd to rescan its shares: ${errorMessage(error)}. Seeker will ask again when slskd answers`)
    return 'unreachable'
  } finally {
    changed()
  }
}

function finish() {
  const took = Date.now() - (scanSince ?? Date.now())
  scanSince = null
  log.info(`slskd finished rescanning its shares${took >= 120_000 ? ` after about ${Math.round(took / 60_000)} minutes` : ''}`)
  // Give slskd a moment before the next one; music that arrived during the scan still waits out the quiet period.
  if (unshared && automatic()) schedule(Math.max(lastChangeAt + quietMs(), Date.now() + Math.min(quietMs(), 60_000)))
  changed()
}

// Every status poll reports what slskd said; `at` is when the poll was sent.
export function noteSlskdShares(state: { reachable: boolean; scanning: boolean; at: number }) {
  const previous = lastPoll
  lastPoll = state
  if (!state.reachable) return
  if (scanSince !== null) {
    // A poll sent before the rescan was asked for says nothing about it.
    if (state.at >= scanSince && !state.scanning) finish()
    return
  }
  if (state.scanning) {
    // slskd started a rescan itself, on a schedule or from its own interface. If it wasn't scanning
    // at the previous poll, after the last change, this rescan includes everything new.
    scanSince = state.at
    if (previous.reachable && !previous.scanning && previous.at >= lastChangeAt) unshared = false
    return changed()
  }
  if (waitingForSlskd) {
    waitingForSlskd = false
    if (unshared && automatic() && dueAt === null) schedule(Date.now() + Math.min(quietMs(), 60_000))
  }
}

// The Rescan button and MCP rescan_shares: now, whatever the settings say.
export async function rescanSharesNow(): Promise<{ started: boolean; message: string }> {
  cancel()
  const outcome = await start()
  if (outcome === 'unreachable') throw new Error('Seeker can’t reach slskd to ask for a rescan. Check that slskd is running.')
  return outcome === 'started'
    ? { started: true, message: 'slskd is rescanning its shares.' }
    : { started: false, message: 'slskd is already rescanning its shares.' }
}

export function shareRescanStatus(): ShareRescanStatus {
  return { scheduledAt: dueAt, pending: unshared, waitingForDownloads, running: scanSince !== null }
}

onSettingsChange((sections) => {
  if (!sections.includes('shares')) return
  if (!automatic()) {
    if (dueAt !== null || waitingForDownloads) log.info('Automatic share rescans are off, so the planned rescan is cancelled')
    cancel()
    offNoted = true
  } else if (unshared && scanSince === null) {
    schedule(Math.max(lastChangeAt + quietMs(), Date.now()))
  }
  changed()
})

subscribe((event) => {
  if (!waitingForDownloads || (event.type !== 'job' && event.type !== 'job-removed')) return
  if (statusCounts().active > 0) return
  waitingForDownloads = false
  schedule(Math.max(lastChangeAt + quietMs(), Date.now()))
})
