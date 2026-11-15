import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job, JobOrigin, JobTarget, TargetTrack } from '../../shared/types.ts'
import { buildAlbumTarget, buildMbTarget, resolveQuery, type Resolved } from '../catalog.ts'
import { config } from '../config.ts'
import { all, get } from '../db.ts'
import { findLibraryAlbum, findLibraryTrack, ownedTrackIds } from '../library/owned.ts'
import { logger } from '../log.ts'
import { deezer } from '../metadata/deezer.ts'
import { getSettings } from '../settings.ts'
import { assignTracks, groupFolders, rankFolders, scoreFolder, type Folder, type FolderScore } from '../soulseek/album.ts'
import { candidateKey, candidatesFrom, remoteSeparator, splitRemote, toCandidate, type Candidate } from '../soulseek/files.ts'
import { scoreTrack, TRACK_THRESHOLD, type TrackWant } from '../soulseek/match.ts'
import { qualityOf, type Quality } from '../soulseek/quality.ts'
import { albumQueries, trackQueries } from '../soulseek/queries.ts'
import { searchSoulseek } from '../soulseek/search.ts'
import { classifyTransfer, slskd, SlskdError, type SlskdFile, type SlskdTransfer } from '../soulseek/slskd.ts'
import { onSoulseekReady, soulseekReady } from '../status.ts'
import { errorMessage, sleep } from '../util.ts'
import { processJob } from './process.ts'
import * as store from './store.ts'
import { WAIT_PHASES, type FileRow, type JobRow, type WaitReason } from './store.ts'

const log = logger('engine')

const ALBUM_STALL_MS = config.timing.albumStallMs
const TRACK_QUEUE_MS = config.timing.trackQueueMs
const GIVE_UP_IDLE_MS = config.timing.giveUpMs
const MISSING_MS = config.timing.missingMs
const MAX_ATTEMPTS_PER_TRACK = 5
const RETRY_DELAYS_H = [1, 4, 12, 24, 72]

export class AlreadyOwnedError extends Error {}

interface Runtime {
  pool: Candidate[]
  poolKeys: Set<string>
  used: Set<string>
  queries: Set<string>
  folders: FolderScore[]
  triedFolders: Set<string>
  folderRows: Set<number>
  rowProgress: Map<number, { bytes: number; at: number }>
  missingSince: Map<number, number>
  positionAskedAt: Map<number, number>
  givenUp: Set<number>
  lastProgressAt: number
}

const POSITION_EVERY_MS = 60_000

const runtimes = new Map<string, Runtime>()

function rt(jobId: string): Runtime {
  let runtime = runtimes.get(jobId)
  if (!runtime) {
    runtime = {
      pool: [],
      poolKeys: new Set(),
      used: new Set(),
      queries: new Set(),
      folders: [],
      triedFolders: new Set(),
      folderRows: new Set(),
      rowProgress: new Map(),
      missingSince: new Map(),
      positionAskedAt: new Map(),
      givenUp: new Set(),
      lastProgressAt: Date.now(),
    }
    // Never retry a source that already failed for this job, even after a restart.
    for (const row of store.jobFiles(jobId)) {
      if (row.state === 'failed' || row.state === 'cancelled') runtime.used.add(candidateKey(row))
    }
    runtimes.set(jobId, runtime)
  }
  return runtime
}

function addToPool(runtime: Runtime, candidates: Candidate[]) {
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    if (runtime.poolKeys.has(key)) continue
    runtime.poolKeys.add(key)
    runtime.pool.push(candidate)
  }
  if (runtime.pool.length > 30_000) {
    runtime.pool = runtime.pool.slice(-30_000)
    runtime.poolKeys = new Set(runtime.pool.map(candidateKey))
  }
}

const destination = (jobId: string) => `seeker/${jobId}`
const jobDir = (jobId: string) => path.join(config.downloadsDir, 'seeker', jobId)

function stillActive(jobId: string): boolean {
  const row = store.getJob(jobId)
  return !!row && !['cancelled', 'completed', 'wanted', 'failed'].includes(row.status)
}

function wantedTracks(target: JobTarget): TargetTrack[] {
  return target.wanted ? target.tracks.filter((track) => target.wanted!.includes(track.index)) : target.tracks
}

function trackLabel(target: JobTarget | null, index: number | null): string {
  const track = target && index !== null ? target.tracks[index] : undefined
  return track ? `“${track.title}”` : 'File'
}

const isLive = (row: FileRow) => ['queued', 'downloading', 'downloaded', 'imported', 'skipped'].includes(row.state)
const isPending = (row: FileRow) => row.state === 'queued' || row.state === 'downloading'

// ---------- task queue ----------

interface ReplaceTask {
  jobId: string
  tracks: number[]
}

const replaceTasks: ReplaceTask[] = []
let activeTaskJob: string | null = null
let searchLoopRunning = false

export function kick() {
  void runSearchLoop()
}

function jobHasWork(jobId: string): boolean {
  return activeTaskJob === jobId || replaceTasks.some((task) => task.jobId === jobId)
}

async function runSearchLoop() {
  if (searchLoopRunning) return
  searchLoopRunning = true
  try {
    for (;;) {
      if (!soulseekReady()) {
        for (const row of all<{ id: string }>("SELECT id FROM jobs WHERE status = 'queued'")) {
          store.setPhase(row.id, 'Waiting for the Soulseek connection')
        }
        break
      }
      const task = replaceTasks.shift()
      if (task) {
        activeTaskJob = task.jobId
        try {
          await runReplacement(task)
        } catch (error) {
          log.error('Replacement failed', error)
        } finally {
          activeTaskJob = null
        }
        continue
      }
      const next = get<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1")
      if (!next) break
      activeTaskJob = next.id
      let outcome: 'done' | 'waiting'
      try {
        outcome = await runJob(next.id)
      } finally {
        activeTaskJob = null
      }
      if (outcome === 'waiting') {
        // slskd stopped answering (it does while rescanning a big share); try again shortly.
        setTimeout(kick, 30_000).unref()
        break
      }
    }
  } finally {
    searchLoopRunning = false
  }
}

const slskdDidntAnswer = (error: unknown) => error instanceof SlskdError && error.status === 0

async function runJob(jobId: string): Promise<'done' | 'waiting'> {
  const job = store.getJob(jobId)
  if (!job || job.status !== 'queued') return 'done'
  store.patchJob(jobId, { status: 'searching', started_at: job.started_at ?? Date.now(), error: null, next_retry_at: null })
  try {
    const target = store.jobTarget(job)
    if (job.kind === 'files') await restartFilesJob(job)
    else if (!target) throw new Error('This download has no album information')
    else if (job.kind === 'album') await searchAlbum(job, target)
    else await searchTracks(job, target, wantedTracks(target), false)
  } catch (error) {
    if (!stillActive(jobId)) return 'done'
    if (!soulseekReady() || slskdDidntAnswer(error)) {
      store.patchJob(jobId, { status: 'queued' })
      store.setPhase(jobId, soulseekReady() ? 'Waiting for slskd to answer' : 'Waiting for the Soulseek connection')
      return 'waiting'
    }
    log.error(`Job ${jobId} failed`, error)
    await toWanted(jobId, errorMessage(error))
  }
  return 'done'
}

async function runSearch(jobId: string, query: string) {
  const runtime = rt(jobId)
  store.setPhase(jobId, `Searching Soulseek for “${query}”`)
  const outcome = await searchSoulseek(query, {
    onProgress: (progress) =>
      store.setPhase(
        jobId,
        `Searching for “${query}” · ${progress.responses} ${progress.responses === 1 ? 'user' : 'users'} replied`,
      ),
  })
  runtime.queries.add(query)
  const candidates = candidatesFrom(outcome.responses)
  addToPool(runtime, candidates)
  store.logJob(jobId, 'info', `Searched “${query}”: ${outcome.responses.length} users, ${candidates.length} audio files`)
  return outcome
}

// ---------- albums ----------

function rankAlbumFolders(runtime: Runtime, target: JobTarget, wanted: number[]) {
  const quality = getSettings().quality
  const scored = groupFolders(runtime.pool)
    .filter((folder) => !runtime.triedFolders.has(folder.key))
    .map((folder) => scoreFolder(target.album, target.tracks, folder, quality, wanted, target.maxRung))
  return { ranked: rankFolders(scored.filter((score) => score.eligible)), scored }
}

function describeNearMisses(scored: FolderScore[]): string | null {
  const best = scored
    .filter((score) => score.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage || b.score - a.score)
    .slice(0, 3)
  if (best.length === 0) return null
  return best.map((score) => `${score.folder.username}: ${score.reason ?? 'not eligible'}`).join('; ')
}

async function searchAlbum(job: JobRow, target: JobTarget) {
  const runtime = rt(job.id)
  const wanted = wantedTracks(target)
  if (wanted.length === 0) return settle(job.id)
  if (wanted.length <= 2 && target.tracks.length > 3) return searchTracks(job, target, wanted, false)

  const wantedIndexes = wanted.map((track) => track.index)
  let result = { ranked: [] as FolderScore[], scored: [] as FolderScore[] }
  for (const query of albumQueries(target.album)) {
    if (!stillActive(job.id)) return
    await runSearch(job.id, query)
    result = rankAlbumFolders(runtime, target, wantedIndexes)
    const top = result.ranked[0]
    if (top && top.coverage === 1 && top.rung === 0) break
  }
  if (!stillActive(job.id)) return

  if (result.ranked.length === 0) {
    const misses = describeNearMisses(result.scored)
    if (misses) store.logJob(job.id, 'info', `Closest folders: ${misses}`)
    if (wanted.length <= 4) return searchTracks(job, target, wanted, false)
    return toWanted(job.id, 'No complete copy of this album was found on Soulseek')
  }

  const started = await startBestFolder(job, target, result.ranked, wantedIndexes)
  if (!stillActive(job.id)) return
  if (!started) {
    if (wanted.length <= 4) return searchTracks(job, target, wanted, false)
    return toWanted(job.id, 'Found the album, but no user could start the download')
  }

  const covered = new Set(store.jobFiles(job.id).filter(isLive).map((row) => row.track_index))
  const missing = wanted.filter((track) => !covered.has(track.index))
  if (missing.length) {
    store.logJob(job.id, 'info', `${missing.length} track(s) not in that folder; searching for them separately`)
    await searchTracks(job, target, missing, true)
  }
  enterDownloading(job.id)
}

async function browseFolder(folder: Folder): Promise<Folder> {
  const peer = folder.files[0]!.peer
  const dirs = [...new Set(folder.files.map((file) => file.dir))].slice(0, 4)
  const files: Candidate[] = []
  for (const dir of dirs) {
    try {
      const response = await slskd.browseDirectory(folder.username, dir)
      const listings = Array.isArray(response) ? response : [response]
      const separator = remoteSeparator(dir)
      for (const listing of listings) {
        for (const file of listing.files ?? []) {
          const name = file.filename
          const filename = /[\\/]/.test(name) ? name : `${dir}${separator}${name}`
          const candidate = toCandidate(folder.username, { ...(file as SlskdFile), filename }, peer)
          if (candidate) files.push(candidate)
        }
      }
    } catch (error) {
      log.debug(`Browse of ${folder.username}:${dir} failed: ${errorMessage(error)}`)
      return folder
    }
  }
  if (files.length === 0) return folder
  const regrouped = groupFolders(files).find((candidate) => candidate.key === folder.key)
  if (!regrouped || regrouped.files.length < folder.files.length) return folder
  return regrouped
}

async function startBestFolder(job: JobRow, target: JobTarget, ranked: FolderScore[], wanted: number[]): Promise<boolean> {
  const runtime = rt(job.id)
  const quality = getSettings().quality
  for (const choice of ranked.slice(0, 5)) {
    if (!stillActive(job.id)) return false
    runtime.triedFolders.add(choice.folder.key)
    store.setPhase(job.id, `Checking ${choice.folder.username}’s copy`)
    const full = await browseFolder(choice.folder)
    const scored = scoreFolder(target.album, target.tracks, full, quality, wanted, target.maxRung)
    if (!scored.eligible) {
      store.logJob(job.id, 'info', `Skipped ${full.username}: ${scored.reason}`)
      continue
    }
    const rows = await enqueue(job, scored.pairs, full.username, scored.label, full.dir)
    if (rows.length) {
      for (const id of rows) runtime.folderRows.add(id)
      runtime.folders = ranked.filter((item) => item.folder.key !== choice.folder.key)
      store.logJob(
        job.id,
        'info',
        `Downloading ${scored.pairs.size} tracks from ${full.username} · ${scored.label} · “${full.name}”`,
      )
      return true
    }
  }
  return false
}

// ---------- single tracks ----------

function wantFor(target: JobTarget, track: TargetTrack): TrackWant {
  return {
    title: track.title,
    artist: track.artist || target.album.artist,
    album: target.album.title,
    duration: track.duration,
    track: track.track,
    disc: track.disc,
  }
}

function peerOrder(a: Candidate, b: Candidate): number {
  return (
    Number(b.peer.freeSlot) - Number(a.peer.freeSlot) || a.peer.queue - b.peer.queue || b.peer.speed - a.peer.speed
  )
}

interface RankOptions {
  // Prefer files in this quality (e.g. the rest of the album's), so albums don't mix formats.
  preferLabel?: string
  maxRung?: number
}

function rankTrack(want: TrackWant, runtime: Runtime, options: RankOptions = {}): Candidate[] {
  const quality = getSettings().quality
  const scored: { candidate: Candidate; quality: Quality; score: number }[] = []
  for (const candidate of runtime.pool) {
    if (runtime.used.has(candidateKey(candidate))) continue
    const q = qualityOf(candidate, quality)
    if (!q || (options.maxRung !== undefined && q.rung >= options.maxRung)) continue
    const { score } = scoreTrack(want, candidate)
    if (score < TRACK_THRESHOLD) continue
    scored.push({ candidate, quality: q, score })
  }
  scored.sort((a, b) => a.quality.rung - b.quality.rung || b.score - a.score)
  const ordered: Candidate[] = []
  const matches = (item: { quality: Quality }) => (options.preferLabel && item.quality.label === options.preferLabel ? 0 : 1)
  while (scored.length) {
    const leader = scored[0]!
    const band = scored.filter((item) => item.quality.rung === leader.quality.rung && leader.score - item.score <= 0.08)
    band.sort((a, b) => matches(a) - matches(b) || peerOrder(a.candidate, b.candidate) || b.quality.tier - a.quality.tier)
    // Spread retries across users so one bad peer can't eat every attempt.
    const byUser = new Map<string, Candidate[]>()
    for (const item of band) {
      const list = byUser.get(item.candidate.username) ?? []
      list.push(item.candidate)
      byUser.set(item.candidate.username, list)
    }
    const lists = [...byUser.values()]
    for (let i = 0; lists.some((list) => i < list.length); i++) {
      for (const list of lists) if (i < list.length) ordered.push(list[i]!)
    }
    for (const item of band) scored.splice(scored.indexOf(item), 1)
  }
  return ordered
}

function rankOptions(jobId: string, target: JobTarget): RankOptions {
  const row = store.getJob(jobId)
  const source = row?.source ? (JSON.parse(row.source) as { quality?: string }) : null
  return { preferLabel: row?.kind === 'album' ? source?.quality : undefined, maxRung: target.maxRung }
}

async function findTrack(job: JobRow, target: JobTarget, track: TargetTrack): Promise<boolean> {
  const runtime = rt(job.id)
  const want = wantFor(target, track)
  const options = rankOptions(job.id, target)
  let ranked = rankTrack(want, runtime, options)
  if (ranked.length === 0) {
    for (const query of trackQueries(track, target.album)) {
      if (runtime.queries.has(query)) continue
      if (!stillActive(job.id)) return false
      await runSearch(job.id, query)
      ranked = rankTrack(want, runtime, options)
      if (ranked.length) break
    }
  }
  const quality = getSettings().quality
  for (const candidate of ranked.slice(0, 6)) {
    if (!stillActive(job.id)) return false
    const label = qualityOf(candidate, quality)?.label ?? candidate.ext.toUpperCase()
    store.setPhase(job.id, `Requesting “${track.title}” from ${candidate.username}`)
    const rows = await enqueue(job, new Map([[track.index, candidate]]), candidate.username, label, candidate.dir)
    if (rows.length) {
      store.logJob(job.id, 'info', `“${track.title}”: downloading from ${candidate.username} · ${label}`)
      return true
    }
  }
  return false
}

async function searchTracks(job: JobRow, target: JobTarget, tracks: TargetTrack[], partOfAlbum: boolean) {
  const runtime = rt(job.id)
  for (const track of tracks) {
    if (!stillActive(job.id)) return
    const found = await findTrack(job, target, track)
    if (!found) {
      runtime.givenUp.add(track.index)
      store.logJob(job.id, 'warn', `No usable file found for “${track.title}”`)
    }
  }
  if (!partOfAlbum && stillActive(job.id)) enterDownloading(job.id)
}

// ---------- enqueueing ----------

async function enqueue(
  job: JobRow,
  pairs: Map<number | null, Candidate>,
  username: string,
  label: string,
  folder: string,
): Promise<number[]> {
  const runtime = rt(job.id)
  const entries = [...pairs.entries()]
  for (const [, candidate] of entries) runtime.used.add(candidateKey(candidate))
  let response
  try {
    response = await slskd.enqueue(
      username,
      entries.map(([, candidate]) => ({ filename: candidate.filename, size: candidate.size })),
      destination(job.id),
    )
  } catch (error) {
    store.logJob(job.id, 'warn', `Could not start a download from ${username}: ${errorMessage(error)}`)
    return []
  }
  const transfers = response?.batch?.transfers ?? []
  const failures = new Map((response?.failures ?? []).map((failure) => [failure.filename, failure.message]))
  const quality = getSettings().quality
  const ids: number[] = []
  for (const [index, candidate] of entries) {
    const transfer = transfers.find((item) => item.filename === candidate.filename)
    const failure = failures.get(candidate.filename)
    if (failure && !transfer) {
      store.logJob(job.id, 'warn', `${username} refused ${candidate.name}: ${failure}`)
      continue
    }
    ids.push(
      store.insertFile(job.id, {
        trackIndex: index,
        username,
        filename: candidate.filename,
        size: candidate.size,
        transferId: transfer?.id ?? null,
        state: 'queued',
        quality: qualityOf(candidate, quality)?.label ?? label,
      }),
    )
  }
  if (ids.length) {
    store.patchJob(job.id, { source: { username, folder, quality: label } })
    runtime.lastProgressAt = Date.now()
  }
  return ids
}

function enterDownloading(jobId: string) {
  const rows = store.jobFiles(jobId)
  if (rows.some(isPending)) {
    store.patchJob(jobId, { status: 'downloading' })
    store.setPhase(jobId, 'Waiting for the download to start')
  } else if (rows.some((row) => row.state === 'downloaded')) {
    store.patchJob(jobId, { status: 'processing' })
    kickProcessing()
  } else {
    void toWanted(jobId, store.getJob(jobId)?.error || 'No matching file found on Soulseek')
  }
}

// ---------- replacements ----------

function scheduleReplacement(jobId: string, trackIndexes: number[]) {
  const job = store.getJob(jobId)
  if (!job || job.kind === 'files') return
  const runtime = rt(jobId)
  const rows = store.jobFiles(jobId)
  const retryable: number[] = []
  for (const index of trackIndexes) {
    const attempts = rows.filter((row) => row.track_index === index && (row.state === 'failed' || row.state === 'cancelled')).length
    if (attempts >= MAX_ATTEMPTS_PER_TRACK) {
      runtime.givenUp.add(index)
      store.logJob(jobId, 'warn', `Giving up on ${trackLabel(store.jobTarget(job), index)} for now after ${attempts} sources`)
    } else retryable.push(index)
  }
  if (retryable.length) {
    replaceTasks.push({ jobId, tracks: retryable })
    kick()
  }
}

async function runReplacement(task: ReplaceTask) {
  const job = store.getJob(task.jobId)
  if (!job || !['downloading', 'processing'].includes(job.status)) return
  const target = store.jobTarget(job)
  if (!target) return
  const runtime = rt(job.id)
  const rows = store.jobFiles(job.id)
  const tracks = target.tracks.filter(
    (track) => task.tracks.includes(track.index) && !rows.some((row) => row.track_index === track.index && isLive(row)),
  )
  if (tracks.length === 0) return

  // Switch copies when several tracks are missing, or half or more of a short album is; fetching
  // them one by one would otherwise leave the album in mixed quality.
  if (job.kind === 'album' && (tracks.length > 2 || tracks.length * 2 >= wantedTracks(target).length)) {
    const quality = getSettings().quality
    const indexes = tracks.map((track) => track.index)
    if (!runtime.folders.some((item) => !runtime.triedFolders.has(item.folder.key))) {
      // No known alternatives (e.g. Seeker restarted): look for other copies of the album.
      const query = albumQueries(target.album).find((item) => !runtime.queries.has(item))
      if (query) await runSearch(job.id, query)
      runtime.folders = rankAlbumFolders(runtime, target, indexes).ranked
    }
    for (const alternative of runtime.folders.slice(0, 4)) {
      if (runtime.triedFolders.has(alternative.folder.key)) continue
      runtime.triedFolders.add(alternative.folder.key)
      const full = await browseFolder(alternative.folder)
      const scored = scoreFolder(target.album, target.tracks, full, quality, indexes, target.maxRung)
      if (!scored.eligible || scored.coverage < 1) continue
      let pairs = scored.pairs
      // Keep the album in one quality: if tracks we already have came in a different quality,
      // take those from this copy too and drop the earlier files.
      const done = store.jobFiles(job.id).filter((row) => row.state === 'downloaded' && row.track_index !== null)
      const differing = done.filter((row) => row.quality && row.quality !== scored.label)
      if (differing.length) {
        const everything = scoreFolder(
          target.album,
          target.tracks,
          full,
          quality,
          [...indexes, ...differing.map((row) => row.track_index!)],
          target.maxRung,
        )
        if (everything.eligible && everything.coverage === 1) {
          pairs = everything.pairs
          for (const row of differing) {
            store.patchFile(row.id, { state: 'cancelled', error: 'replaced to keep the album in one quality' })
            if (row.transfer_id) void slskd.cancel(row.username, row.transfer_id, true)
          }
          store.logJob(job.id, 'info', `Also taking ${differing.length} earlier track(s) from ${full.username} so the whole album is ${scored.label}`)
        }
      }
      const ids = await enqueue(job, pairs, full.username, scored.label, full.dir)
      if (ids.length) {
        for (const id of ids) runtime.folderRows.add(id)
        store.logJob(job.id, 'info', `Switched to ${full.username}’s copy for ${ids.length} tracks`)
        runtime.lastProgressAt = Date.now()
        return
      }
    }
  }
  for (const track of tracks) {
    if (!stillActive(job.id)) return
    const found = await findTrack(job, target, track)
    if (!found) {
      runtime.givenUp.add(track.index)
      store.logJob(job.id, 'warn', `No other source found for “${track.title}”`)
    }
  }
  runtime.lastProgressAt = Date.now()
}

// ---------- monitoring ----------

function describeFailure(transfer: SlskdTransfer): string {
  const state = transfer.state.replace(/^Completed,\s*/, '')
  const reasons: Record<string, string> = {
    Errored: 'the transfer failed',
    Rejected: 'the user rejected the request',
    TimedOut: 'the transfer timed out',
    Cancelled: 'the transfer was cancelled',
    Aborted: 'the user aborted the transfer',
  }
  const reason = reasons[state] ?? state.toLowerCase()
  return transfer.exception ? `${reason} (${transfer.exception})` : reason
}

async function failRow(job: JobRow, row: FileRow, reason: string, state: 'failed' | 'cancelled' = 'failed') {
  store.patchFile(row.id, { state, error: reason, speed: 0 })
  if (row.transfer_id) await slskd.cancel(row.username, row.transfer_id, true)
  rt(job.id).used.add(candidateKey(row))
  store.logJob(job.id, 'warn', `${trackLabel(store.jobTarget(job), row.track_index)} from ${row.username}: ${reason}`)
}

let monitoring = false

async function monitorTick() {
  if (monitoring) return
  monitoring = true
  try {
    const jobs = all<JobRow>("SELECT * FROM jobs WHERE status = 'downloading'")
    if (jobs.length === 0) return
    let transfers: SlskdTransfer[]
    try {
      transfers = await slskd.downloads()
    } catch {
      // A failed poll tells us nothing; never treat it as "every transfer vanished".
      return
    }
    const byId = new Map(transfers.map((transfer) => [transfer.id, transfer]))
    const byKey = new Map(transfers.map((transfer) => [`${transfer.username}\u0000${transfer.filename}`, transfer]))
    for (const job of jobs) {
      try {
        await monitorJob(job, byId, byKey)
      } catch (error) {
        log.error(`Monitoring ${job.id} failed`, error)
      }
    }
  } finally {
    monitoring = false
  }
}

function describeWaiting(rows: FileRow[]): string {
  const names = (list: FileRow[]) => {
    const users = [...new Set(list.map((row) => row.username))]
    return `${users.slice(0, 2).join(', ')}${users.length > 2 ? ` +${users.length - 2}` : ''}`
  }
  const downloading = rows.filter((row) => row.state === 'downloading')
  // slskd reports a transfer as started while it is still trying to reach the user; only data counts.
  const moving = downloading.filter((row) => row.bytes > 0)
  if (moving.length) return `Downloading from ${names(moving)}`
  if (downloading.length) return `Connecting to ${names(downloading)}`
  const remote = rows.filter((row) => row.remote_state?.includes('Remotely'))
  if (remote.length) {
    const positions = remote.map((row) => row.queue_position).filter((value): value is number => !!value)
    const user = remote[0]!.username
    return positions.length
      ? `Waiting in ${user}’s queue (position ${Math.min(...positions)})`
      : `Waiting in ${user}’s queue`
  }
  return 'Starting download'
}

async function monitorJob(job: JobRow, byId: Map<string, SlskdTransfer>, byKey: Map<string, SlskdTransfer>) {
  const runtime = rt(job.id)
  const now = Date.now()
  for (const row of store.jobFiles(job.id).filter(isPending)) {
    const transfer = (row.transfer_id ? byId.get(row.transfer_id) : undefined) ?? byKey.get(`${row.username}\u0000${row.filename}`)
    if (!runtime.rowProgress.has(row.id)) runtime.rowProgress.set(row.id, { bytes: row.bytes, at: now })
    if (!transfer) {
      const since = runtime.missingSince.get(row.id) ?? now
      runtime.missingSince.set(row.id, since)
      if (now - since > MISSING_MS) {
        await failRow(job, row, 'the transfer disappeared from slskd')
        scheduleReplacement(job.id, row.track_index === null ? [] : [row.track_index])
      }
      continue
    }
    runtime.missingSince.delete(row.id)
    const progress = runtime.rowProgress.get(row.id)!
    if (transfer.bytesTransferred > progress.bytes) {
      runtime.rowProgress.set(row.id, { bytes: transfer.bytesTransferred, at: now })
      runtime.lastProgressAt = now
    }
    const verdict = classifyTransfer(transfer.state)
    if (verdict === 'succeeded' && transfer.bytesTransferred >= transfer.size) {
      store.patchFile(row.id, {
        transfer_id: transfer.id,
        state: 'downloaded',
        remote_state: transfer.state,
        bytes: transfer.size,
        speed: 0,
        queue_position: null,
        error: null,
      })
      runtime.lastProgressAt = now
    } else if (verdict === 'failed' || verdict === 'succeeded') {
      await failRow(job, row, verdict === 'failed' ? describeFailure(transfer) : 'the file arrived incomplete')
      scheduleReplacement(job.id, row.track_index === null ? [] : [row.track_index])
    } else {
      const remotelyQueued = verdict !== 'active' && transfer.state.includes('Remotely')
      store.patchFile(row.id, {
        transfer_id: transfer.id,
        state: verdict === 'active' ? 'downloading' : 'queued',
        remote_state: transfer.state,
        bytes: transfer.bytesTransferred,
        speed: verdict === 'active' ? transfer.averageSpeed : 0,
        queue_position: remotelyQueued ? (transfer.placeInQueue ?? row.queue_position) : null,
      })
      // Every minute, ask peers where we are in their queue so the UI can show it.
      if (remotelyQueued && now - (runtime.positionAskedAt.get(row.id) ?? 0) > POSITION_EVERY_MS) {
        runtime.positionAskedAt.set(row.id, now)
        void slskd.placeInQueue(row.username, transfer.id).then((place) => {
          if (place === null) return
          const current = store.jobFiles(job.id).find((item) => item.id === row.id)
          if (current?.state !== 'queued') return
          store.patchFile(row.id, { queue_position: place })
          store.publish(job.id)
        })
      }
    }
  }

  if (jobHasWork(job.id)) {
    store.publish(job.id)
    return
  }

  const pending = store.jobFiles(job.id).filter(isPending)
  if (pending.length === 0) {
    finishDownloading(job.id)
    return
  }

  const folderPending = pending.filter((row) => job.kind === 'album' && (runtime.folderRows.has(row.id) || runtime.folderRows.size === 0))
  const trackPending = pending.filter((row) => !folderPending.includes(row))
  const target = store.jobTarget(job)

  // A single file stuck in a queue: move on if there's another usable source.
  for (const row of trackPending) {
    const progress = runtime.rowProgress.get(row.id)!
    const idle = now - progress.at
    if (row.bytes > 0 && row.state === 'downloading' && idle < GIVE_UP_IDLE_MS) continue
    if (idle > TRACK_QUEUE_MS && target && row.track_index !== null && job.kind !== 'files') {
      const track = target.tracks[row.track_index]
      const alternatives = track ? rankTrack(wantFor(target, track), runtime, { maxRung: target.maxRung }) : []
      if (alternatives.length || idle > GIVE_UP_IDLE_MS) {
        await failRow(job, row, 'waited too long in the queue', 'cancelled')
        scheduleReplacement(job.id, [row.track_index])
      }
    } else if (idle > GIVE_UP_IDLE_MS && job.kind === 'files') {
      await failRow(job, row, 'no progress for 30 minutes', 'cancelled')
    }
  }

  // A whole folder making no progress: switch to another copy, or search track by track.
  if (folderPending.length && now - runtime.lastProgressAt > ALBUM_STALL_MS) {
    const switches = store.jobFiles(job.id).filter((row) => row.error === 'stalled').length
    if (switches < folderPending.length * 4 || now - runtime.lastProgressAt > GIVE_UP_IDLE_MS) {
      const waited =
        ALBUM_STALL_MS >= 60_000 ? `${Math.round(ALBUM_STALL_MS / 60_000)} minutes` : `${Math.round(ALBUM_STALL_MS / 1000)} seconds`
      store.logJob(job.id, 'warn', `No progress from ${folderPending[0]!.username} for ${waited}; trying another source`)
      for (const row of folderPending) await failRow(job, row, 'stalled', 'cancelled')
      scheduleReplacement(
        job.id,
        folderPending.map((row) => row.track_index).filter((index): index is number => index !== null),
      )
      runtime.lastProgressAt = now
    }
  }

  store.setPhase(job.id, describeWaiting(store.jobFiles(job.id).filter(isPending)))
}

function finishDownloading(jobId: string) {
  const rows = store.jobFiles(jobId)
  if (rows.some((row) => row.state === 'downloaded')) {
    store.patchJob(jobId, { status: 'processing' })
    store.setPhase(jobId, 'Checking files')
    kickProcessing()
  } else {
    void settle(jobId)
  }
}

// ---------- processing ----------

let processingRunning = false
let processingTimer: ReturnType<typeof setTimeout> | undefined
const PROCESSING_RETRY_MS = 10 * 60_000

function kickProcessing() {
  // Only if recording an error fails too; an unhandled rejection would stop Seeker.
  void runProcessing().catch((error) => log.error('Processing stopped', error))
}

// The downloads stay where they are; processing tries again later, or when the user presses Try again.
function waitToProcess(jobId: string, reason: WaitReason) {
  store.patchJob(jobId, { next_retry_at: Date.now() + PROCESSING_RETRY_MS, waiting_for: reason })
  store.setPhase(jobId, WAIT_PHASES[reason])
}

async function runProcessing() {
  if (processingRunning) return
  processingRunning = true
  try {
    for (;;) {
      const job = get<JobRow>("SELECT * FROM jobs WHERE status = 'processing' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY updated_at LIMIT 1", [Date.now()])
      if (!job) break
      let failedTracks: number[] = []
      let waitingFor: WaitReason | undefined
      try {
        ;({ failedTracks, waitingFor } = await processJob(job.id))
      } catch (error) {
        log.error(`Processing ${job.id} failed`, error)
        store.logJob(job.id, 'error', `Post-processing failed: ${errorMessage(error)}`)
        // Picking the job straight up again would repeat the same error thousands of times a second,
        // so the downloads that are left wait for the next try instead.
        if (stillActive(job.id) && store.jobFiles(job.id).some((row) => row.state === 'downloaded')) {
          store.patchJob(job.id, { error: `Processing failed: ${errorMessage(error)}` })
          waitToProcess(job.id, 'retry')
          continue
        }
      }
      if (!stillActive(job.id)) continue
      if (waitingFor) {
        waitToProcess(job.id, waitingFor)
        continue
      }
      store.patchJob(job.id, { next_retry_at: null, waiting_for: null, error: null })
      const runtime = rt(job.id)
      for (const row of store.jobFiles(job.id)) if (row.state === 'failed') runtime.used.add(candidateKey(row))
      if (failedTracks.length && job.kind !== 'files') {
        scheduleReplacement(job.id, failedTracks)
        if (jobHasWork(job.id)) {
          store.patchJob(job.id, { status: 'downloading' })
          store.setPhase(job.id, 'Finding another source')
          continue
        }
      }
      await settle(job.id)
    }
  } finally {
    processingRunning = false
    clearTimeout(processingTimer)
    const next = get<{ at: number }>("SELECT MIN(next_retry_at) AS at FROM jobs WHERE status = 'processing' AND next_retry_at IS NOT NULL")
    if (next?.at) {
      processingTimer = setTimeout(kickProcessing, Math.max(0, next.at - Date.now()))
      processingTimer.unref()
    }
  }
}

// ---------- final states ----------

async function cleanupJobFiles(jobId: string) {
  await fs.rm(jobDir(jobId), { recursive: true, force: true }).catch(() => {})
  await fs.rmdir(path.join(config.downloadsDir, 'seeker')).catch(() => {})
}

async function settle(jobId: string) {
  const job = store.getJob(jobId)
  if (!job || !stillActive(jobId)) return
  const rows = store.jobFiles(jobId)
  if (rows.some(isPending) || rows.some((row) => row.state === 'downloaded') || jobHasWork(jobId)) return
  const target = store.jobTarget(job)
  const done = new Set(
    rows.filter((row) => row.state === 'imported' || row.state === 'skipped').map((row) => row.track_index),
  )

  if (job.kind === 'files' || job.kind === 'import') {
    const imported = rows.filter((row) => row.state === 'imported' || row.state === 'skipped').length
    if (imported > 0) {
      store.patchJob(jobId, { status: 'completed', completed_at: Date.now(), error: null, result: { imported } })
    } else {
      store.patchJob(jobId, { status: 'failed', error: rows.find((row) => row.error)?.error ?? 'Nothing was downloaded' })
    }
    store.setPhase(jobId, null)
    runtimes.delete(jobId)
    await cleanupJobFiles(jobId)
    return
  }

  const wanted = target ? wantedTracks(target) : []
  const missing = wanted.filter((track) => !done.has(track.index))
  if (missing.length === 0) {
    store.patchJob(jobId, {
      status: 'completed',
      completed_at: Date.now(),
      error: null,
      next_retry_at: null,
      result: { imported: done.size },
    })
    store.logJob(jobId, 'info', 'Done')
    store.setPhase(jobId, null)
    runtimes.delete(jobId)
    await cleanupJobFiles(jobId)
    return
  }
  if (done.size > 0 && target) {
    store.patchJob(jobId, { target: { ...target, wanted: missing.map((track) => track.index) } })
    await toWanted(jobId, `${missing.length} of ${wanted.length} tracks are still missing`)
    return
  }
  const lastError = [...rows].reverse().find((row) => row.error)?.error
  await toWanted(jobId, lastError ? `Every source failed (last: ${lastError})` : 'No working source found on Soulseek')
}

async function toWanted(jobId: string, reason: string) {
  const job = store.getJob(jobId)
  if (!job) return
  for (const row of store.jobFiles(jobId).filter(isPending)) {
    store.patchFile(row.id, { state: 'cancelled', error: 'stopped', speed: 0 })
    if (row.transfer_id) await slskd.cancel(row.username, row.transfer_id, true)
  }
  const attempts = job.attempts + 1
  const enabled = getSettings().wishlist.enabled
  const delay = RETRY_DELAYS_H[Math.min(attempts - 1, RETRY_DELAYS_H.length - 1)]! * 3600_000
  store.patchJob(jobId, {
    status: enabled ? 'wanted' : 'failed',
    attempts,
    error: reason,
    next_retry_at: enabled ? Date.now() + delay : null,
  })
  store.logJob(jobId, 'warn', enabled ? `${reason}. Will try again in ${delay / 3600_000} h.` : reason)
  store.setPhase(jobId, null)
  runtimes.delete(jobId)
  await cleanupJobFiles(jobId)
}

// ---------- public API ----------

function activeJobFor(column: 'deezer_album_id' | 'deezer_track_id' | 'mb_release_id', id: number | string, kind: string): JobRow | undefined {
  return get<JobRow>(
    `SELECT * FROM jobs WHERE ${column} = ? AND kind = ? AND status IN ('queued', 'searching', 'downloading', 'processing', 'wanted', 'failed')
     ORDER BY created_at DESC LIMIT 1`,
    [id, kind],
  )
}

function revive(row: JobRow): Job {
  if (row.status === 'wanted' || row.status === 'failed') retryJob(row.id)
  return store.toJob(store.getJob(row.id)!)
}

export interface AlbumOptions {
  force?: boolean
  // Upgrades: only copies better than this rung, replacing this library album's files.
  maxRung?: number
  replaceLibraryAlbumId?: string
}

function insertAlbumJob(target: JobTarget, origin: JobOrigin, options: AlbumOptions): Job {
  let ownedCount = 0
  if (!options.force) {
    const library = findLibraryAlbum(target.album.deezerId ?? target.album.mbReleaseId ?? null, target.album.artist, target.album.title)
    const owned = ownedTrackIds(target.tracks, library?.id ?? null)
    const missing = target.tracks.filter((_, index) => owned[index] === null)
    ownedCount = target.tracks.length - missing.length
    if (missing.length === 0) throw new AlreadyOwnedError(`${target.album.title} is already in your library`)
    if (ownedCount > 0) target.wanted = missing.map((track) => track.index)
  }
  if (options.maxRung !== undefined) target.maxRung = options.maxRung
  if (options.replaceLibraryAlbumId) target.replaceLibraryAlbumId = options.replaceLibraryAlbumId
  const row = store.insertJob({
    kind: 'album',
    status: 'queued',
    title: target.album.title,
    artist: target.album.artist,
    album: target.album.title,
    year: target.album.originalYear ?? target.album.year ?? null,
    coverUrl: target.album.coverUrl ?? null,
    deezerArtistId: target.album.deezerArtistId ?? null,
    deezerAlbumId: target.album.deezerId ?? null,
    mbReleaseId: target.album.mbReleaseId ?? null,
    target,
    origin,
  })
  store.logJob(
    row.id,
    'info',
    options.maxRung !== undefined
      ? 'Queued: looking for a better copy than the one in your library'
      : ownedCount
        ? `Queued (${ownedCount} of ${target.tracks.length} tracks are already in your library)`
        : 'Queued',
  )
  kick()
  return store.toJob(row)
}

export async function queueAlbum(albumId: number, origin: JobOrigin, options: AlbumOptions = {}): Promise<Job> {
  const existing = activeJobFor('deezer_album_id', albumId, 'album')
  if (existing) return revive(existing)
  return insertAlbumJob(await buildAlbumTarget(albumId), origin, options)
}

export async function queueMbAlbum(mbid: string, origin: JobOrigin, options: AlbumOptions = {}): Promise<Job> {
  const existing = activeJobFor('mb_release_id', mbid, 'album')
  if (existing) return revive(existing)
  return insertAlbumJob(await buildMbTarget(mbid), origin, options)
}

export async function queueTrack(trackId: number, origin: JobOrigin, options: { force?: boolean } = {}): Promise<Job> {
  const existing = activeJobFor('deezer_track_id', trackId, 'track')
  if (existing) return revive(existing)
  const track = await deezer.track(trackId)
  if (!options.force && findLibraryTrack(track.artist.name, track.title, track.isrc) !== null) {
    throw new AlreadyOwnedError(`${track.title} is already in your library`)
  }
  const albumId = track.album?.id
  let target: JobTarget
  if (albumId) {
    target = await buildAlbumTarget(albumId)
  } else {
    target = {
      album: { title: track.title, artist: track.artist.name, trackCount: 1, discCount: 1 },
      tracks: [],
    }
  }
  let index = target.tracks.findIndex((item) => item.deezerId === trackId)
  if (index < 0) {
    index = target.tracks.length
    target.tracks.push({
      index,
      title: track.title,
      artist: track.artist.name,
      disc: track.disk_number ?? 1,
      track: track.track_position ?? 1,
      duration: track.duration,
      isrc: track.isrc,
      deezerId: track.id,
    })
  }
  target.wanted = [index]
  const row = store.insertJob({
    kind: 'track',
    status: 'queued',
    title: track.title,
    artist: track.artist.name,
    album: target.album.title,
    year: target.album.year ?? null,
    coverUrl: target.album.coverUrl ?? null,
    deezerArtistId: track.artist.id,
    deezerAlbumId: albumId ?? null,
    deezerTrackId: trackId,
    target,
    origin,
  })
  store.logJob(row.id, 'info', 'Queued')
  kick()
  return store.toJob(row)
}

export async function queueQuery(
  query: string,
  kind: 'auto' | 'album' | 'track',
  origin: JobOrigin,
  options: { force?: boolean } = {},
): Promise<{ job: Job; resolved: Resolved }> {
  const resolved = await resolveQuery(query, kind)
  const job =
    resolved.kind === 'track'
      ? await queueTrack(resolved.id, origin, options)
      : resolved.source === 'musicbrainz' && resolved.mbid
        ? await queueMbAlbum(resolved.mbid, origin, options)
        : await queueAlbum(resolved.id, origin, options)
  return { job, resolved }
}

// Local files (an import folder, or library files being re-matched) to tag and file into the library.
export function queueImport(input: {
  files: { path: string; size: number; trackIndex: number | null }[]
  target: JobTarget | null
  title: string
  artist: string
  coverUrl?: string | null
  deezerAlbumId?: number | null
  mbReleaseId?: string | null
  origin: JobOrigin
}): Job {
  if (input.files.length === 0) throw new Error('No audio files to import')
  const row = store.insertJob({
    kind: 'import',
    status: 'processing',
    title: input.title,
    artist: input.artist,
    album: input.target?.album.title ?? null,
    year: input.target?.album.originalYear ?? input.target?.album.year ?? null,
    coverUrl: input.coverUrl ?? input.target?.album.coverUrl ?? null,
    deezerArtistId: input.target?.album.deezerArtistId ?? null,
    deezerAlbumId: input.deezerAlbumId ?? null,
    mbReleaseId: input.mbReleaseId ?? null,
    target: input.target,
    origin: input.origin,
  })
  for (const file of input.files) {
    const id = store.insertFile(row.id, {
      trackIndex: file.trackIndex,
      username: 'local',
      filename: file.path,
      size: file.size,
      transferId: null,
      state: 'downloaded',
      quality: path.extname(file.path).slice(1).toUpperCase(),
    })
    store.patchFile(id, { local_path: file.path })
  }
  const mode = input.target?.importMode === 'copy' ? 'Copying' : 'Moving'
  store.logJob(row.id, 'info', `${mode} ${input.files.length} files into your library`)
  store.setPhase(row.id, 'Checking files')
  kickProcessing()
  return store.toJob(store.getJob(row.id)!)
}

export async function queueFiles(
  username: string,
  files: { filename: string; size: number }[],
  options: { albumId?: number | null },
  origin: JobOrigin,
): Promise<Job> {
  if (files.length === 0) throw new Error('No files selected')
  const peer = { freeSlot: true, speed: 0, queue: 0 }
  const candidates = files
    .map((file) => toCandidate(username, { filename: file.filename, size: file.size }, peer))
    .filter((candidate): candidate is Candidate => candidate !== null)
  if (candidates.length === 0) throw new Error('None of the selected files are audio files')
  const target = options.albumId ? await buildAlbumTarget(options.albumId) : null
  const pairs = new Map<number | null, Candidate>()
  if (target) {
    const folder = groupFolders(candidates)[0]!
    const permissive = candidates.map((file) => ({ file, quality: { rung: 0, tier: 0, label: '', format: 'other' as const, lossless: false } }))
    const assignment = assignTracks(target.tracks, permissive, { artist: target.album.artist, album: target.album.title, folder })
    for (const [index, file] of assignment.pairs) pairs.set(index, file)
    target.wanted = [...assignment.pairs.keys()]
  }
  const unassigned = candidates.filter((candidate) => ![...pairs.values()].includes(candidate))
  const dirParts = splitRemote(candidates[0]!.dir)
  const folderName = dirParts[dirParts.length - 1] ?? username
  const row = store.insertJob({
    kind: 'files',
    status: 'downloading',
    title: target?.album.title ?? folderName,
    artist: target?.album.artist ?? username,
    album: target?.album.title ?? null,
    year: target?.album.year ?? null,
    coverUrl: target?.album.coverUrl ?? null,
    deezerArtistId: target?.album.deezerArtistId ?? null,
    deezerAlbumId: options.albumId ?? null,
    target,
    origin,
  })
  const extras = unassigned.map((candidate) => [null, candidate] as const)
  // Unassigned files go in the same batch but carry no track index.
  const ids = await enqueueManual(row, [...pairs.entries(), ...extras], username)
  if (ids === 0) {
    store.patchJob(row.id, { status: 'failed', error: `Could not start the download from ${username}` })
  } else {
    store.logJob(row.id, 'info', `Downloading ${ids} files from ${username}`)
    store.setPhase(row.id, 'Waiting for the download to start')
  }
  return store.toJob(store.getJob(row.id)!)
}

async function enqueueManual(job: JobRow, entries: (readonly [number | null, Candidate])[], username: string): Promise<number> {
  let response
  try {
    response = await slskd.enqueue(
      username,
      entries.map(([, candidate]) => ({ filename: candidate.filename, size: candidate.size })),
      destination(job.id),
    )
  } catch (error) {
    store.logJob(job.id, 'error', `Could not start the download: ${errorMessage(error)}`)
    return 0
  }
  const transfers = response?.batch?.transfers ?? []
  let count = 0
  for (const [index, candidate] of entries) {
    const transfer = transfers.find((item) => item.filename === candidate.filename)
    if (!transfer && response?.failures?.some((failure) => failure.filename === candidate.filename)) continue
    store.insertFile(job.id, {
      trackIndex: index,
      username,
      filename: candidate.filename,
      size: candidate.size,
      transferId: transfer?.id ?? null,
      state: 'queued',
      quality: candidate.ext.toUpperCase(),
    })
    count++
  }
  if (count) store.patchJob(job.id, { source: { username, folder: entries[0]![1].dir, quality: entries[0]![1].ext.toUpperCase() } })
  return count
}

async function restartFilesJob(job: JobRow) {
  const rows = store.jobFiles(job.id).filter((row) => row.state === 'failed' || row.state === 'cancelled')
  const byUser = new Map<string, FileRow[]>()
  for (const row of rows) byUser.set(row.username, [...(byUser.get(row.username) ?? []), row])
  let started = 0
  for (const [username, userRows] of byUser) {
    const peer = { freeSlot: true, speed: 0, queue: 0 }
    const entries = userRows
      .map((row) => [row.track_index, toCandidate(username, { filename: row.filename, size: row.size }, peer)] as const)
      .filter((entry): entry is readonly [number | null, Candidate] => entry[1] !== null)
    started += await enqueueManual(job, entries, username)
  }
  if (started) enterDownloading(job.id)
  else await toWanted(job.id, 'Could not start the download again')
}

export async function cancelJob(jobId: string) {
  const job = store.getJob(jobId)
  if (!job) return
  for (const row of store.jobFiles(jobId).filter(isPending)) {
    store.patchFile(row.id, { state: 'cancelled', error: 'cancelled', speed: 0 })
    if (row.transfer_id) await slskd.cancel(row.username, row.transfer_id, true)
  }
  for (let i = replaceTasks.length - 1; i >= 0; i--) if (replaceTasks[i]!.jobId === jobId) replaceTasks.splice(i, 1)
  if (!['completed'].includes(job.status)) {
    store.patchJob(jobId, { status: 'cancelled', next_retry_at: null, waiting_for: null })
    store.logJob(jobId, 'info', 'Cancelled')
  }
  store.setPhase(jobId, null)
  runtimes.delete(jobId)
  await cleanupJobFiles(jobId)
}

export function retryJob(jobId: string) {
  const job = store.getJob(jobId)
  if (job?.status === 'processing' && job.next_retry_at !== null) {
    store.patchJob(jobId, { next_retry_at: null, waiting_for: null, error: null })
    store.setPhase(jobId, 'Retrying files already downloaded')
    kickProcessing()
    return
  }
  if (!job || !['wanted', 'failed', 'cancelled'].includes(job.status)) return
  runtimes.delete(jobId)
  if (job.kind === 'import') {
    // Imports have no source to search; just try processing the files again.
    for (const row of store.jobFiles(jobId)) {
      if ((row.state === 'failed' || row.state === 'cancelled') && row.local_path) store.patchFile(row.id, { state: 'downloaded', error: null })
    }
    store.patchJob(jobId, { status: 'processing', error: null })
    store.logJob(jobId, 'info', 'Retrying')
    kickProcessing()
    return
  }
  store.patchJob(jobId, { status: 'queued', next_retry_at: null, error: null })
  store.logJob(jobId, 'info', 'Retrying')
  kick()
}

export async function removeJob(jobId: string) {
  const job = store.getJob(jobId)
  if (!job) return
  if (!['completed', 'cancelled', 'failed', 'wanted'].includes(job.status)) await cancelJob(jobId)
  store.deleteJob(jobId)
}

export function clearFinished() {
  for (const row of all<{ id: string }>("SELECT id FROM jobs WHERE status IN ('completed', 'cancelled')")) store.deleteJob(row.id)
}

function wishlistTick() {
  const due = all<{ id: string }>("SELECT id FROM jobs WHERE status = 'wanted' AND next_retry_at <= ? ORDER BY next_retry_at", [
    Date.now(),
  ])
  for (const row of due) {
    runtimes.delete(row.id)
    store.patchJob(row.id, { status: 'queued', next_retry_at: null })
    store.logJob(row.id, 'info', 'Trying again')
  }
  if (due.length) kick()
}

export function startEngine() {
  for (const row of all<{ id: string }>("SELECT id FROM jobs WHERE status = 'searching'")) {
    store.patchJob(row.id, { status: 'queued' })
  }
  onSoulseekReady(() => kick())
  setInterval(() => void monitorTick(), config.timing.pollMs).unref()
  setInterval(wishlistTick, 60_000).unref()
  kickProcessing()
  void sleep(3000).then(() => kick())
}
