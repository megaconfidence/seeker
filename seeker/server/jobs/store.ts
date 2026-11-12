import { randomUUID } from 'node:crypto'
import type {
  Job,
  JobDetail,
  JobFile,
  JobKind,
  JobLogEntry,
  JobOrigin,
  JobRef,
  JobSource,
  JobStatus,
  JobTarget,
} from '../../shared/types.ts'
import { all, exec, get } from '../db.ts'
import { emit } from '../events.ts'

export interface JobRow {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  artist: string
  album: string | null
  year: number | null
  cover_url: string | null
  deezer_artist_id: number | null
  deezer_album_id: number | null
  deezer_track_id: number | null
  mb_release_id: string | null
  target: string | null
  source: string | null
  origin: JobOrigin
  attempts: number
  error: string | null
  next_retry_at: number | null
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
  result: string | null
}

export type FileState = 'queued' | 'downloading' | 'downloaded' | 'imported' | 'skipped' | 'failed' | 'cancelled'

export interface FileRow {
  id: number
  job_id: string
  track_index: number | null
  username: string
  filename: string
  size: number
  transfer_id: string | null
  state: FileState
  remote_state: string | null
  quality: string | null
  bytes: number
  speed: number
  queue_position: number | null
  local_path: string | null
  attempts: number
  error: string | null
  updated_at: number
}

export const PENDING_FILE_STATES: FileState[] = ['queued', 'downloading']
const LIVE_FILE_STATES: FileState[] = ['queued', 'downloading', 'downloaded', 'imported', 'skipped']

const phases = new Map<string, string>()

export function getJob(id: string): JobRow | undefined {
  return get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id])
}

export function insertJob(input: {
  kind: JobKind
  status: JobStatus
  title: string
  artist: string
  album?: string | null
  year?: number | null
  coverUrl?: string | null
  deezerArtistId?: number | null
  deezerAlbumId?: number | null
  deezerTrackId?: number | null
  mbReleaseId?: string | null
  target?: JobTarget | null
  origin: JobOrigin
}): JobRow {
  const id = randomUUID()
  const now = Date.now()
  exec(
    `INSERT INTO jobs (id, kind, status, title, artist, album, year, cover_url, deezer_artist_id, deezer_album_id,
       deezer_track_id, mb_release_id, target, origin, created_at, updated_at)
     VALUES (:id, :kind, :status, :title, :artist, :album, :year, :cover_url, :deezer_artist_id, :deezer_album_id,
       :deezer_track_id, :mb_release_id, :target, :origin, :now, :now)`,
    {
      id,
      kind: input.kind,
      status: input.status,
      title: input.title,
      artist: input.artist,
      album: input.album ?? null,
      year: input.year ?? null,
      cover_url: input.coverUrl ?? null,
      deezer_artist_id: input.deezerArtistId ?? null,
      deezer_album_id: input.deezerAlbumId ?? null,
      deezer_track_id: input.deezerTrackId ?? null,
      mb_release_id: input.mbReleaseId ?? null,
      target: input.target ? JSON.stringify(input.target) : null,
      origin: input.origin,
      now,
    },
  )
  publish(id)
  return getJob(id)!
}

type JobPatch = Partial<Omit<JobRow, 'id' | 'target' | 'source' | 'result'>> & {
  target?: JobTarget | null
  source?: JobSource | null
  result?: Record<string, unknown> | null
}

export function patchJob(id: string, patch: JobPatch) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return
  const values: Record<string, string | number | null> = { id, updated_at: Date.now() }
  const sets = ['updated_at = :updated_at']
  for (const [key, value] of entries) {
    sets.push(`${key} = :${key}`)
    values[key] =
      key === 'target' || key === 'source' || key === 'result'
        ? value === null
          ? null
          : JSON.stringify(value)
        : (value as string | number | null)
  }
  exec(`UPDATE jobs SET ${sets.join(', ')} WHERE id = :id`, values)
  publish(id)
}

export function jobTarget(row: Pick<JobRow, 'target'>): JobTarget | null {
  return row.target ? (JSON.parse(row.target) as JobTarget) : null
}

export function jobFiles(jobId: string): FileRow[] {
  return all<FileRow>('SELECT * FROM job_files WHERE job_id = ? ORDER BY id', [jobId])
}

export function insertFile(
  jobId: string,
  data: {
    trackIndex: number | null
    username: string
    filename: string
    size: number
    transferId: string | null
    state: FileState
    quality?: string | null
    error?: string | null
  },
): number {
  const result = exec(
    `INSERT INTO job_files (job_id, track_index, username, filename, size, transfer_id, state, quality, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [jobId, data.trackIndex, data.username, data.filename, data.size, data.transferId, data.state, data.quality ?? null, data.error ?? null, Date.now()],
  )
  publish(jobId)
  return Number(result.lastInsertRowid)
}

export function patchFile(id: number, patch: Partial<Omit<FileRow, 'id' | 'job_id'>>) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return
  const values: Record<string, string | number | null> = { id, updated_at: Date.now() }
  const sets = ['updated_at = :updated_at']
  for (const [key, value] of entries) {
    sets.push(`${key} = :${key}`)
    values[key] = value as string | number | null
  }
  exec(`UPDATE job_files SET ${sets.join(', ')} WHERE id = :id`, values)
}

export function logJob(jobId: string, level: JobLogEntry['level'], message: string) {
  exec('INSERT INTO job_log (job_id, at, level, message) VALUES (?, ?, ?, ?)', [jobId, Date.now(), level, message])
}

export function setPhase(jobId: string, phase: string | null) {
  if (phase) phases.set(jobId, phase)
  else phases.delete(jobId)
  publish(jobId)
}

function progressOf(row: JobRow, files: FileRow[]) {
  const live = files.filter((file) => LIVE_FILE_STATES.includes(file.state))
  const target = jobTarget(row)
  const wantedCount = target ? (target.wanted?.length ?? target.tracks.length) : live.length
  const doneTracks = new Set(
    live
      .filter((file) => ['downloaded', 'imported', 'skipped'].includes(file.state))
      .map((file) => file.track_index ?? -file.id),
  )
  return {
    files: Math.max(wantedCount, live.length ? new Set(live.map((file) => file.track_index ?? -file.id)).size : 0),
    done: doneTracks.size,
    bytes: live.reduce((sum, file) => sum + (file.state === 'downloaded' || file.state === 'imported' ? file.size : file.bytes), 0),
    size: live.reduce((sum, file) => sum + file.size, 0),
    speed: live.filter((file) => file.state === 'downloading').reduce((sum, file) => sum + file.speed, 0),
  }
}

export function toJob(row: JobRow, files = jobFiles(row.id)): Job {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    artist: row.artist,
    album: row.album,
    year: row.year,
    coverUrl: row.cover_url,
    deezerArtistId: row.deezer_artist_id,
    deezerAlbumId: row.deezer_album_id,
    deezerTrackId: row.deezer_track_id,
    mbReleaseId: row.mb_release_id,
    origin: row.origin,
    attempts: row.attempts,
    error: row.error,
    phase: phases.get(row.id) ?? null,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    source: row.source ? (JSON.parse(row.source) as JobSource) : null,
    progress: progressOf(row, files),
  }
}

export function toDetail(row: JobRow): JobDetail {
  const files = jobFiles(row.id)
  const log = all<JobLogEntry>('SELECT at, level, message FROM job_log WHERE job_id = ? ORDER BY id', [row.id])
  return {
    ...toJob(row, files),
    target: jobTarget(row),
    files: files.map(
      (file): JobFile => ({
        id: file.id,
        trackIndex: file.track_index,
        username: file.username,
        filename: file.filename,
        size: file.size,
        state: file.state,
        bytes: file.bytes,
        speed: file.speed,
        queuePosition: file.queue_position,
        error: file.error,
      }),
    ),
    log,
  }
}

export function listJobs(): Job[] {
  const rows = all<JobRow>(
    `SELECT * FROM jobs
     WHERE status IN ('queued', 'searching', 'downloading', 'processing', 'wanted', 'failed')
        OR updated_at > ?
     ORDER BY CASE WHEN status IN ('queued', 'searching', 'downloading', 'processing') THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 300`,
    [Date.now() - 14 * 24 * 3600_000],
  )
  return rows.map((row) => toJob(row))
}

export function deleteJob(id: string) {
  exec('DELETE FROM jobs WHERE id = ?', [id])
  phases.delete(id)
  emit({ type: 'job-removed', id })
}

// Latest job per Deezer album/track, used to show download state next to catalog results.
export function jobRefs(): { albums: Map<number, JobRef>; tracks: Map<number, JobRef>; mbAlbums: Map<string, JobRef> } {
  const albums = new Map<number, JobRef>()
  const tracks = new Map<number, JobRef>()
  const mbAlbums = new Map<string, JobRef>()
  for (const row of all<{
    id: string
    kind: JobKind
    status: JobStatus
    deezer_album_id: number | null
    deezer_track_id: number | null
    mb_release_id: string | null
  }>(
    `SELECT id, kind, status, deezer_album_id, deezer_track_id, mb_release_id FROM jobs
     WHERE status != 'cancelled' AND kind IN ('album', 'track') ORDER BY created_at ASC`,
  )) {
    const ref = { id: row.id, status: row.status }
    if (row.kind === 'album' && row.deezer_album_id) albums.set(row.deezer_album_id, ref)
    if (row.kind === 'album' && row.mb_release_id && !row.deezer_album_id) mbAlbums.set(row.mb_release_id, ref)
    if (row.kind === 'track' && row.deezer_track_id) tracks.set(row.deezer_track_id, ref)
  }
  return { albums, tracks, mbAlbums }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function publish(id: string) {
  if (timers.has(id)) return
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      const row = getJob(id)
      if (row) emit({ type: 'job', job: toJob(row) })
    }, 250),
  )
}

export function statusCounts() {
  const rows = all<{ status: JobStatus; n: number }>('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
  const count = (statuses: JobStatus[]) => rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.n, 0)
  return {
    active: count(['queued', 'searching', 'downloading', 'processing']),
    wanted: count(['wanted']),
    failed: count(['failed']),
  }
}
