import { createHash } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type { LibraryProblem, LibraryStatus, ScanProgress, ScanResult } from '../../shared/types.ts'
import { config } from '../config.ts'
import { all, exec, get, getMeta, setMeta, transaction } from '../db.ts'
import { emit } from '../events.ts'
import { folderMessage, folderProblem, fsReason } from '../folders.ts'
import { logger } from '../log.ts'
import { normalize, stripExtras } from '../match/normalize.ts'
import { noteInitialLibrary, noteLibraryChange } from '../shares.ts'
import { eachLimit, errorMessage } from '../util.ts'
import { rebuildOwnedIndex } from './owned.ts'
import type { IAudioMetadata } from 'music-metadata'
import { metadataFromPath } from './pathmeta.ts'
import { isReadError, probeTags } from './probe.ts'
import { readTags } from './tags.ts'
import type { TagReadOptions } from './tags.ts'

const log = logger('library')

export const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aiff', '.aif', '.wv', '.ape', '.alac'])
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart']
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']
// What NAS systems keep next to the music (Synology, QNAP, Windows shares, ext4). Never music, and
// snapshots would add every track again.
const SKIPPED_FOLDERS = new Set(['@eadir', '#recycle', '#snapshot', '@recycle', '@recently-snapshot', '$recycle.bin', 'lost+found'])
// Listings, stats and tag reads mostly wait on the disk or the network share, so several run at
// once. File reads use libuv's thread pool, which the image enlarges (UV_THREADPOOL_SIZE).
const LIST_CONCURRENCY = 16
// Tag reads at once, unless SEEKER_SCAN_CONCURRENCY says. On a network share every read is a few
// round trips, and a dozen at once kept an NFS server, and everything else using it, busy.
const LOCAL_READS = 12
const NETWORK_READS = 4
// statfs types of network filesystems. FUSE covers sshfs, rclone, GlusterFS and the like.
const NETWORK_FILESYSTEMS = new Map<number, string>([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'CIFS'],
  [0xfe534d42, 'SMB2'],
  [0x65735546, 'FUSE'],
  [0x01021997, '9P'],
  [0x00c36400, 'Ceph'],
  [0x5346414f, 'AFS'],
  [0x6b414653, 'AFS'],
  [0x73757245, 'Coda'],
  [0x0bd00bd0, 'Lustre'],
  [0x47504653, 'GPFS'],
  [0x19830326, 'BeeGFS'],
  [0x564c, 'NCP'],
])
// A full scan saves what it has read every BATCH_SIZE tracks (or config.timing.scanBatchMs), so a
// restart or a stopped scan keeps it, and albums show up while a long first scan runs.
const BATCH_SIZE = 200
// The owned index (owned.ts) is rebuilt from every track, so scan batches rebuild it at most this often.
const OWNED_INDEX_MS = 15_000
// Reads slower than this are logged; config.timing.scanReadMs gives up on them.
const SLOW_READ_MS = 10_000
// Reads given up on that are still stuck in the file system (on a hard NFS mount they can't be
// interrupted) each hold one of libuv's 16 threads, which all of Seeker's file access shares. This
// many at once stops the scan as if the share were down, whatever the concurrency.
const MAX_STUCK_READS = 8
const LOSSLESS_EXTENSIONS = new Set(['flac', 'wav', 'aiff', 'aif', 'wv', 'ape', 'alac'])
// lib_tracks.has_cover for embedded art nobody has looked for yet. Scans don't read covers;
// albumCover() in serve.ts checks the first time an album is shown, and stores 1 or 0.
export const COVER_UNCHECKED = -1
// How soon to look again when the music folder seemed unmounted.
const RETRY_MS = 10 * 60_000
// How often a running scan reports its progress: to the web app, and to the log on long scans.
const PROGRESS_EVENT_MS = 500
const PROGRESS_LOG_MS = 15_000
const STOPPED_MESSAGE = 'Library scan stopped. Seeker keeps what it read and continues from there next time.'

// The running scan: what stops it, and its result.
let stopScan: AbortController | null = null
let scanDone: Promise<ScanResult> | null = null
let pending: { force: boolean } | null = null
let problem: LibraryProblem | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined
let indexWork = Promise.resolve()
let progress: ScanProgress | null = null
let progressEventAt = 0
let progressLog: ReturnType<typeof setInterval> | undefined
// For the progress log: bytes read during this scan, and where the files/s rate counts from.
let bytesRead = 0
let rateFrom = { at: 0, read: 0 }
// Paths that imports and deletions changed while a full scan was reading files: what the scan read
// for them is older, so it leaves them alone.
let changedDuringScan: Set<string> | null = null
// Files whose tags couldn't be parsed since the running scan started (readTrack).
let unparsed: string[] = []
// Reads given up on that haven't finished yet (MAX_STUCK_READS).
let stuckReads = 0

// Commits to the index (full scans and post-import indexing) must not prepare album snapshots over
// one another. Only commits wait here: a full scan lists and reads files first, without waiting.
function serializeIndex<T>(run: () => Promise<T>): Promise<T> {
  const next = indexWork.then(run)
  indexWork = next.then(() => {}, () => {})
  return next
}

// Imports and deletions that change these paths' rows while a full scan runs.
export function indexedElsewhere(paths: Iterable<string>) {
  if (changedDuringScan) for (const file of paths) changedDuringScan.add(file)
}

export function libraryCounts() {
  const albums = get<{ n: number }>('SELECT COUNT(*) AS n FROM lib_albums')?.n ?? 0
  const tracks = get<{ n: number }>('SELECT COUNT(*) AS n FROM lib_tracks')?.n ?? 0
  return { albums, tracks }
}

export function libraryStatus(): LibraryStatus {
  return { ...libraryCounts(), scanning: stopScan !== null, problem, progress: progress && { ...progress } }
}

const count = (n: number) => n.toLocaleString('en')
const relative = (file: string) => path.relative(config.musicDir, file) || null

function reportProgress(force = false) {
  if (!progress) return
  const now = Date.now()
  if (force || now - progressEventAt >= PROGRESS_EVENT_MS) {
    progressEventAt = now
    announce()
  }
}

// On a timer rather than per file, so a scan stuck on slow files still says where it is.
function logProgress() {
  if (!progress) return
  const { phase, found, read, toRead, current } = progress
  if (phase === 'listing') {
    log.info(`Library scan: ${count(found)} files found so far${current ? `, listing ${current}` : ''}`)
  } else if (phase === 'reading') {
    const now = Date.now()
    const rate = (read - rateFrom.read) / Math.max(1, (now - rateFrom.at) / 1000)
    rateFrom = { at: now, read }
    const megabytes = (bytesRead / 1024 / 1024).toFixed(1)
    log.info(
      `Library scan: read ${count(read)} of ${count(toRead)} new or changed files (${rate.toFixed(1)} files/s, ${megabytes} MB read)${current ? `, now ${current}` : ''}`,
    )
  } else {
    log.info('Library scan: saving what it read')
  }
}

function announce() {
  emit({ type: 'library', ...libraryStatus() })
}

const tracks = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'track' : 'tracks'}`
const unmountedHint = 'If it’s a network share, check that it’s mounted.'

// Why the music folder can't be trusted right now, or null. A missing or unreadable folder, or an
// empty one while the library has tracks, usually means a network share that isn't mounted rather
// than an empty library.
export async function musicFolderProblem(): Promise<string | null> {
  const dir = config.musicDir
  let empty = true
  try {
    if (!(await fs.stat(dir)).isDirectory()) return `The music folder, ${dir}, isn’t a folder.`
    for await (const entry of await fs.opendir(dir)) {
      if (!entry.name.startsWith('.')) {
        empty = false
        break
      }
    }
  } catch (error) {
    return `Seeker can’t read the music folder, ${dir} (${fsReason(error)}). ${unmountedHint}`
  }
  const known = libraryCounts().tracks
  if (empty && known > 0) return `The music folder, ${dir}, is empty, but the library has ${tracks(known)}. ${unmountedHint}`
  const access = await folderProblem(dir)
  return access ? folderMessage('music', access) : null
}

export function albumIdFor(albumArtist: string, album: string): string {
  return createHash('sha1')
    .update(`${normalize(albumArtist)}\u0000${normalize(album)}`)
    .digest('hex')
    .slice(0, 16)
}

interface Entry {
  file: string
  mtime: number
  size: number
}

interface Listing {
  files: Entry[]
  unreadable: string[]
  unreadableFiles: Set<string>
  // Every folder listed, with its cover image or null, so building albums needs no second listing.
  covers: Map<string, string | null>
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code
const byPath = (a: { file: string } | { path: string }, b: { file: string } | { path: string }) => {
  const left = 'file' in a ? a.file : a.path
  const right = 'file' in b ? b.file : b.path
  return left < right ? -1 : left > right ? 1 : 0
}

const STOPPED = Symbol('stopped')

// Settles with `promise`, or with STOPPED as soon as the scan is stopped: a call stuck on an
// unresponsive network share can't be interrupted, so the scan stops waiting for it instead.
function unlessStopped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof STOPPED> {
  return new Promise((resolve, reject) => {
    const stop = () => resolve(STOPPED)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

// Lists the music folder, several folders and files at a time: on a network share each listing
// and stat is a round trip. Folders that can't be read are collected rather than skipped, so their
// tracks aren't taken as deleted. Only failing to read the music folder itself is an error. A
// stopped scan gets a partial listing back, which says nothing about what's gone.
async function list(root: string, signal: AbortSignal, onFolder: (dir: string) => void, onFile: () => void): Promise<Listing> {
  const listing: Listing = { files: [], unreadable: [], unreadableFiles: new Set(), covers: new Map() }
  type Task = { dir: string } | { file: string }
  await eachLimit<Task>([{ dir: root }], LIST_CONCURRENCY, async (task, add) => {
    if (signal.aborted) return
    if ('file' in task) {
      try {
        const stat = await unlessStopped(fs.stat(task.file), signal)
        if (stat === STOPPED) return
        listing.files.push({ file: task.file, mtime: Math.floor(stat.mtimeMs), size: stat.size })
        onFile()
      } catch (error) {
        if (errno(error) !== 'ENOENT') listing.unreadableFiles.add(task.file)
      }
      return
    }
    onFolder(task.dir)
    let entries: Dirent[] | typeof STOPPED
    try {
      entries = await unlessStopped(fs.readdir(task.dir, { withFileTypes: true }), signal)
    } catch (error) {
      if (task.dir === root) throw error
      // A folder that vanished during the scan is simply gone; anything else may come back.
      if (errno(error) !== 'ENOENT') listing.unreadable.push(task.dir)
      return
    }
    if (entries === STOPPED) return
    const images: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(task.dir, entry.name)
      const ext = path.extname(entry.name).toLowerCase()
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name.toLowerCase())) add({ dir: full })
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(ext)) {
        add({ file: full })
      } else if (entry.isFile() && COVER_EXTENSIONS.includes(ext)) {
        images.push(entry.name)
      }
    }
    listing.covers.set(task.dir, pickCover(task.dir, images))
  })
  // Several at a time finish in any order; sorted, track ids and logs come out the same every time.
  listing.files.sort(byPath)
  return listing
}

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

// What's known of a file nobody could parse: the format its extension says.
function untagged(file: string): IAudioMetadata {
  const ext = path.extname(file).slice(1).toLowerCase()
  return {
    common: { track: { no: null, of: null }, disk: { no: null, of: null }, movementIndex: { no: null, of: null } },
    format: { trackInfo: [], tagTypes: [], codec: ext.toUpperCase() || undefined, lossless: LOSSLESS_EXTENSIONS.has(ext) },
    native: {},
    quality: { warnings: [] },
  }
}

// Tags and stream details, without reading cover images or the audio: see readTags() in tags.ts.
// Tags music-metadata can't parse (issue #2: a tag whose header understates its size) get a second
// opinion from ffprobe, and failing that the file is named after its path, so the track isn't
// dropped. A file that can't be read at all throws, and keeps whatever the index has.
async function readTrack(file: string, mtime: number, size: number, io: TagReadOptions = {}) {
  let meta: IAudioMetadata
  try {
    meta = await readTags(file, io)
  } catch (error) {
    if (isReadError(error)) throw error
    const probed = await probeTags(file, io.signal)
    meta = probed ?? untagged(file)
    unparsed.push(file)
    log.warn(
      `Seeker couldn’t read the tags in ${file} (${errorMessage(error)}), so it ${probed ? 'used what ffprobe read from the file' : 'named the track after its folder and file name'}.`,
    )
  }
  const common = meta.common
  const format = meta.format
  const tagTitle = common.title?.trim()
  const tagArtist = common.artist?.trim() || common.albumartist?.trim()
  const tagAlbum = common.album?.trim()
  // Files without tags (music copied in by hand) are named after their folders and file name.
  const named = tagTitle && tagArtist && tagAlbum ? null : metadataFromPath(file, config.musicDir)
  const title = tagTitle || named?.title || path.basename(file, path.extname(file))
  const artist = tagArtist || named?.artist || 'Unknown Artist'
  const album = tagAlbum || named?.album || path.basename(path.dirname(file))
  const albumArtist = common.albumartist?.trim() || (tagArtist ? artist : named?.albumArtist) || artist
  const tagYear = common.year ?? (common.date ? Number.parseInt(common.date.slice(0, 4), 10) || null : null)
  return {
    path: file,
    album_id: albumIdFor(albumArtist, album),
    mtime,
    size,
    title,
    artist,
    album,
    album_artist: albumArtist,
    // A number at the start of a file name is only a track number when the title came from it too.
    track_no: common.track?.no ?? (tagTitle ? null : (named?.track ?? null)),
    disc_no: common.disk?.no ?? named?.disc ?? null,
    year: tagYear ?? named?.year ?? null,
    duration: format.duration ?? null,
    codec: format.codec ?? format.container ?? null,
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    sample_rate: format.sampleRate ?? null,
    bit_depth: format.bitsPerSample ?? null,
    lossless: format.lossless ? 1 : 0,
    isrc: first(common.isrc) ?? null,
    mb_track_id: common.musicbrainz_recordingid ?? null,
    mb_album_id: common.musicbrainz_albumid ?? null,
    norm_artist: normalize(artist),
    norm_title: normalize(stripExtras(title)),
    has_cover: COVER_UNCHECKED,
  }
}

type TrackRow = Awaited<ReturnType<typeof readTrack>>

const TIMED_OUT = Symbol('timed out')

// Reads a file's tags, or gives up after config.timing.scanReadMs, or when `stop` aborts. A read on
// an unresponsive network share can't be interrupted, so nothing waits for one given up on; the
// file is skipped until the next scan. Read errors are thrown.
async function readWithin(
  entry: Entry,
  options: { stop?: AbortSignal; onBytes?: (bytes: number) => void } = {},
): Promise<TrackRow | typeof TIMED_OUT | typeof STOPPED> {
  const { stop, onBytes } = options
  if (stop?.aborted) return STOPPED
  const read = new AbortController()
  const limit = config.timing.scanReadMs
  const timer = setTimeout(() => read.abort(new DOMException(`No answer within ${limit} ms`, 'TimeoutError')), limit)
  const onStop = () => read.abort(new DOMException('The library scan was stopped', 'AbortError'))
  stop?.addEventListener('abort', onStop, { once: true })
  const started = Date.now()
  const reading = readTrack(entry.file, entry.mtime, entry.size, { signal: read.signal, onBytes })
  try {
    const row = await Promise.race([
      reading,
      new Promise<never>((_, reject) => read.signal.addEventListener('abort', () => reject(read.signal.reason), { once: true })),
    ])
    const took = Date.now() - started
    if (took >= SLOW_READ_MS) log.info(`Reading ${entry.file} took ${Math.round(took / 1000)} s`)
    return row
  } catch (error) {
    if (!read.signal.aborted) throw error
    stuckReads++
    void reading.then(
      () => stuckReads--,
      () => stuckReads--,
    )
    if ((read.signal.reason as Error).name !== 'TimeoutError') return STOPPED
    log.warn(
      `Seeker gave up reading ${entry.file} after ${Math.round(limit / 1000)} s and skipped it for now; the next library scan tries again. If this keeps happening, check that file and the share it’s on.`,
    )
    return TIMED_OUT
  } finally {
    clearTimeout(timer)
    stop?.removeEventListener('abort', onStop)
  }
}

// What a statfs type says about a folder: the network filesystem it's on, or null. The types are
// 32-bit magic numbers, which some platforms report as negative.
export function networkFilesystem(type: number): string | null {
  return NETWORK_FILESYSTEMS.get(type >>> 0) ?? null
}

// How many files to read at once, logged when `report` is set. A Docker bind mount reports the
// filesystem it comes from, so this sees an NFS share mounted on the host too.
async function readConcurrency(report: boolean): Promise<number> {
  const choose = (reads: number, why: string) => {
    if (report) log.info(`Library scan: reading ${reads} ${reads === 1 ? 'file' : 'files'} at a time${why}`)
    return reads
  }
  if (config.scanConcurrency) return choose(config.scanConcurrency, ', as SEEKER_SCAN_CONCURRENCY says')
  const otherwise = '; SEEKER_SCAN_CONCURRENCY changes that'
  try {
    const filesystem = networkFilesystem((await fs.statfs(config.musicDir)).type)
    return filesystem ? choose(NETWORK_READS, `, because the music folder is on ${filesystem}${otherwise}`) : choose(LOCAL_READS, otherwise)
  } catch (error) {
    return choose(NETWORK_READS, `, because Seeker can’t tell what the music folder is on (${fsReason(error)})${otherwise}`)
  }
}

function upsertTrack(row: TrackRow, now: number) {
  exec(
    `INSERT INTO lib_tracks (path, album_id, mtime, size, title, artist, album, album_artist, track_no, disc_no, year,
       duration, codec, bitrate, sample_rate, bit_depth, lossless, isrc, mb_track_id, mb_album_id, norm_artist, norm_title,
       has_cover, added_at)
     VALUES (:path, :album_id, :mtime, :size, :title, :artist, :album, :album_artist, :track_no, :disc_no, :year,
       :duration, :codec, :bitrate, :sample_rate, :bit_depth, :lossless, :isrc, :mb_track_id, :mb_album_id, :norm_artist,
       :norm_title, :has_cover, :added_at)
     ON CONFLICT(path) DO UPDATE SET album_id = excluded.album_id, mtime = excluded.mtime, size = excluded.size,
       title = excluded.title, artist = excluded.artist, album = excluded.album, album_artist = excluded.album_artist,
       track_no = excluded.track_no, disc_no = excluded.disc_no, year = excluded.year, duration = excluded.duration,
       codec = excluded.codec, bitrate = excluded.bitrate, sample_rate = excluded.sample_rate,
       bit_depth = excluded.bit_depth, lossless = excluded.lossless, isrc = excluded.isrc,
       mb_track_id = excluded.mb_track_id, mb_album_id = excluded.mb_album_id, norm_artist = excluded.norm_artist,
       norm_title = excluded.norm_title, has_cover = excluded.has_cover`,
    { ...row, added_at: now },
  )
}

export function formatLabel(codec: string | null, lossless: boolean, bitDepth: number | null, sampleRate: number | null, bitrate: number | null): string {
  const name = (codec ?? '').toUpperCase()
  const label = name.includes('FLAC')
    ? 'FLAC'
    : name.includes('ALAC')
      ? 'ALAC'
      : name.includes('MPEG') || name.includes('MP3')
        ? 'MP3'
        : name.includes('AAC') || name.includes('MP4')
          ? 'AAC'
          : name.includes('OPUS')
            ? 'Opus'
            : name.includes('VORBIS')
              ? 'Vorbis'
              : name.includes('PCM') || name.includes('WAV')
                ? 'WAV'
                : name || 'Audio'
  if (lossless) {
    const depth = bitDepth ? `${bitDepth}` : ''
    const rate = sampleRate ? `${(sampleRate / 1000).toString().replace(/\.0$/, '')}` : ''
    return depth && rate ? `${label} ${depth}/${rate}` : label
  }
  return bitrate ? `${label} ${bitrate}` : label
}

// A folder's cover among its images: cover.jpg, folder.jpg… first, then any image.
function pickCover(dir: string, images: string[]): string | null {
  const lower = new Map(images.map((name) => [name.toLowerCase(), name]))
  for (const base of COVER_NAMES) {
    for (const ext of COVER_EXTENSIONS) {
      const name = lower.get(base + ext)
      if (name) return path.join(dir, name)
    }
  }
  return images[0] ? path.join(dir, images[0]) : null
}

async function findCover(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const images = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && COVER_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    return pickCover(dir, images.map((entry) => entry.name))
  } catch {
    return null
  }
}

function commonDir(paths: string[]): string {
  if (paths.length === 0) return config.musicDir
  let prefix = path.dirname(paths[0]!)
  for (const file of paths.slice(1)) {
    while (!file.startsWith(prefix + path.sep) && prefix.length > config.musicDir.length) prefix = path.dirname(prefix)
  }
  return prefix
}

type AlbumTrack = TrackRow & { added_at: number }
type AlbumRow = Record<string, string | number | null>

// `covers` are the cover images a full scan found while listing; other folders are looked at here.
async function prepareAlbums(rows: AlbumTrack[], covers?: Map<string, string | null>): Promise<AlbumRow[]> {
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = groups.get(row.album_id) ?? []
    list.push(row)
    groups.set(row.album_id, list)
  }

  const imported = new Map<string, number>()
  for (const row of all<{ path: string; deezer_album_id: number | null }>(
    'SELECT path, deezer_album_id FROM imports WHERE deezer_album_id IS NOT NULL',
  )) {
    imported.set(row.path, row.deezer_album_id!)
  }

  const albums: AlbumRow[] = []
  for (const [id, tracks] of groups) {
    const firstTrack = tracks[0]!
    const dir = commonDir(tracks.map((track) => track.path))
    const formats = new Map<string, number>()
    for (const track of tracks) {
      const label = formatLabel(track.codec, track.lossless === 1, track.bit_depth, track.sample_rate, track.lossless ? null : track.bitrate)
      formats.set(label, (formats.get(label) ?? 0) + 1)
    }
    const format = [...formats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const years = tracks.map((track) => track.year).filter((year): year is number => !!year)
    const deezerId = tracks.map((track) => imported.get(track.path)).find((value) => value !== undefined) ?? null
    albums.push({
      id,
      title: firstTrack.album,
      artist: firstTrack.album_artist,
      year: years.length ? Math.min(...years) : null,
      dir,
      cover: covers?.has(dir) ? (covers.get(dir) ?? null) : await findCover(dir),
      track_count: tracks.length,
      duration: tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0),
      format,
      norm_key: `${normalize(firstTrack.album_artist)}\u0000${normalize(stripExtras(firstTrack.album))}`,
      mb_album_id: tracks.find((track) => track.mb_album_id)?.mb_album_id ?? null,
      deezer_album_id: deezerId,
      added_at: Math.min(...tracks.map((track) => track.added_at)),
    })
  }

  return albums
}

function writeAlbums(albums: AlbumRow[], albumIds?: Set<string>) {
  if (albumIds) {
    for (const id of albumIds) exec('DELETE FROM lib_albums WHERE id = ?', [id])
  } else {
    exec('DELETE FROM lib_albums')
  }
  for (const album of albums) {
    exec(
      `INSERT INTO lib_albums (id, title, artist, year, dir, cover, track_count, duration, format, norm_key, mb_album_id,
         deezer_album_id, added_at)
       VALUES (:id, :title, :artist, :year, :dir, :cover, :track_count, :duration, :format, :norm_key, :mb_album_id,
         :deezer_album_id, :added_at)`,
      album,
    )
  }
}

// The albums tracks are on now, and the ones their files were on before.
function albumsOf(updates: TrackRow[], files: Iterable<string>): Set<string> {
  const albumIds = new Set(updates.map((row) => row.album_id))
  for (const file of files) {
    const previous = get<{ album_id: string }>('SELECT album_id FROM lib_tracks WHERE path = ?', [file])
    if (previous) albumIds.add(previous.album_id)
  }
  return albumIds
}

// `albumIds` limits the album rebuild to those albums. `owned: false` leaves the owned index for a
// later commit to rebuild.
async function commitIndex(
  updates: TrackRow[],
  gone: string[],
  options: { albumIds?: Set<string>; markIndexed?: boolean; covers?: Map<string, string | null>; owned?: boolean } = {},
) {
  const { albumIds, markIndexed = false, covers, owned = true } = options
  const where = albumIds ? `WHERE album_id IN (${[...albumIds].map(() => '?').join(',')})` : ''
  const current = all<AlbumTrack>(`SELECT * FROM lib_tracks ${where}`, albumIds ? [...albumIds] : [])
  const projected = new Map(current.map((row) => [row.path, row]))
  for (const file of gone) projected.delete(file)
  const now = Date.now()
  for (const row of updates) projected.set(row.path, { ...row, added_at: projected.get(row.path)?.added_at ?? now })
  // All asynchronous cover discovery finishes before the synchronous transaction starts.
  const albums = await prepareAlbums([...projected.values()], covers)
  transaction(() => {
    for (const row of updates) upsertTrack(row, now)
    for (const file of gone) exec('DELETE FROM lib_tracks WHERE path = ?', [file])
    writeAlbums(albums, albumIds)
    if (markIndexed) setMeta('library_indexed', '1')
  })
  if (owned) rebuildOwnedIndex()
}

const result = (outcome: ScanResult['outcome'], message: string, counts: Partial<ScanResult> = {}): ScanResult => ({
  outcome,
  message,
  files: 0,
  updated: 0,
  removed: 0,
  ...counts,
})

// `force` removes tracks whose files are gone even when that's most of the library, once the user
// has confirmed they removed them. A missing or unreadable music folder is never scanned.
export async function scanLibrary(options: { force?: boolean } = {}): Promise<ScanResult> {
  if (stopScan) {
    pending = { force: !!options.force || !!pending?.force }
    return result('queued', 'A library scan is already running; Seeker scans again when it finishes.')
  }
  stopScan = new AbortController()
  // One listener per listing or read in progress, more than the default warning allows.
  setMaxListeners(0, stopScan.signal)
  scanDone = runScan(!!options.force, stopScan.signal)
  return scanDone
}

async function runScan(force: boolean, signal: AbortSignal): Promise<ScanResult> {
  announce()
  try {
    return await scan(force, signal)
  } catch (error) {
    log.error('Library scan failed', error)
    return refuse(`The library scan failed: ${errorMessage(error)}.`, 0, false, false)
  } finally {
    stopScan = null
    scanDone = null
    announce()
    if (pending) {
      const next = pending
      pending = null
      void scanLibrary(next)
    }
  }
}

// Stops the running scan: no more reads start, reads still going are abandoned, and what was read
// is saved, but nothing is removed. A scan queued to follow it is dropped. Waits up to `waitMs` for
// the scan to end, and returns its result; null when no scan was running.
export async function cancelLibraryScan(waitMs = 10_000): Promise<ScanResult | null> {
  pending = null
  const done = scanDone
  if (!stopScan || !done) return null
  if (!stopScan.signal.aborted) {
    log.info('Stopping the library scan')
    stopScan.abort()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<ScanResult>((resolve) => {
    timer = setTimeout(() => resolve(result('cancelled', 'Seeker is stopping the library scan. It saves what it read first.')), waitMs)
  })
  try {
    return await Promise.race([done, slow])
  } finally {
    clearTimeout(timer)
  }
}

function refuse(message: string, missing: number, canForce: boolean, retry: boolean): ScanResult {
  const full = `${message} Seeker kept the library as it was.`
  // Retries while a share stays unmounted would repeat the same warning every few minutes.
  if (problem?.message === full) log.debug(full)
  else log.warn(full)
  problem = { message: full, missing, canForce }
  if (retry) {
    // A share that isn't mounted usually comes back by itself, so look again before the next 6-hourly scan.
    retryTimer = setTimeout(() => void scanLibrary(), RETRY_MS)
    retryTimer.unref()
  }
  return result('refused', full)
}

async function scan(force: boolean, signal: AbortSignal): Promise<ScanResult> {
  progress = { phase: 'listing', found: 0, read: 0, toRead: 0, current: null }
  bytesRead = 0
  unparsed = []
  changedDuringScan = new Set()
  progressLog = setInterval(logProgress, PROGRESS_LOG_MS)
  progressLog.unref()
  reportProgress(true)
  try {
    return await scanFolder(force, signal)
  } finally {
    clearInterval(progressLog)
    progress = null
    changedDuringScan = null
  }
}

// `reading` is how far the scan got, once it was reading files.
function stopped(reading?: { read: number; toRead: number; files: number; updated: number }): ScanResult {
  log.info(
    reading
      ? `Library scan stopped after reading ${count(reading.read)} of ${count(reading.toRead)} new or changed files; the next scan continues from there`
      : 'Library scan stopped while listing the music folder',
  )
  return result('cancelled', STOPPED_MESSAGE, reading && { files: reading.files, updated: reading.updated })
}

// A scan that stopped itself because the share stopped answering. Like a stopped scan it keeps what
// it read; it says why on the Library page, and looks again later.
function unanswering(unanswered: number, reading: { files: number; updated: number }): ScanResult {
  const message = `${unanswered} files didn’t answer within ${Math.round(config.timing.scanReadMs / 1000)} s, so Seeker stopped the library scan. Check that the music folder’s network share is up. Seeker keeps what it read and tries again in 10 minutes.`
  log.warn(message)
  problem = { message, missing: 0, canForce: false }
  pending = null
  retryTimer = setTimeout(() => void scanLibrary(), RETRY_MS)
  retryTimer.unref()
  return result('cancelled', message, { files: reading.files, updated: reading.updated })
}

// Lets requests waiting on the server run between batches of synchronous database work.
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve))

// One batch of a full scan, with the albums its tracks are on now and were on before. Paths an
// import or deletion changed meanwhile are left alone.
function saveBatch(rows: TrackRow[], covers: Map<string, string | null>, owned = true): Promise<void> {
  return serializeIndex(async () => {
    const fresh = rows.filter((row) => !changedDuringScan?.has(row.path)).sort(byPath)
    if (fresh.length) await commitIndex(fresh, [], { albumIds: albumsOf(fresh, fresh.map((row) => row.path)), covers, owned })
  })
}

// What a full scan has read, saved every BATCH_SIZE tracks or config.timing.scanBatchMs, one batch
// after another while the scan goes on reading. `onSaved` runs after each batch.
function batches(covers: Map<string, string | null>, onSaved: () => void) {
  let rows: TrackRow[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let saving = Promise.resolve()
  let failure: { error: unknown } | null = null
  let ownedAt = 0
  const save = () => {
    clearTimeout(timer)
    timer = undefined
    const batch = rows
    rows = []
    if (!batch.length) return
    saving = saving.then(async () => {
      if (failure) return
      try {
        const owned = Date.now() - ownedAt >= OWNED_INDEX_MS
        if (owned) ownedAt = Date.now()
        await saveBatch(batch, covers, owned)
        onSaved()
      } catch (error) {
        failure = { error }
      }
      await breathe()
    })
  }
  return {
    failed: () => failure !== null,
    add(row: TrackRow) {
      rows.push(row)
      if (rows.length >= BATCH_SIZE) save()
      else if (rows.length === 1) timer = setTimeout(save, config.timing.scanBatchMs)
    },
    // Waits for the batches being saved, and returns the rows not saved yet. Throws if a batch failed.
    async finish(): Promise<TrackRow[]> {
      clearTimeout(timer)
      timer = undefined
      await saving
      if (failure) throw failure.error
      const rest = rows
      rows = []
      return rest
    },
  }
}

async function scanFolder(force: boolean, signal: AbortSignal): Promise<ScanResult> {
  const started = Date.now()
  const dir = config.musicDir
  clearTimeout(retryTimer)
  const known = new Map(
    all<{ path: string; mtime: number; size: number }>('SELECT path, mtime, size FROM lib_tracks').map((row) => [row.path, row]),
  )
  // A first scan is marked '0' before it saves anything and '1' once it finishes, so one cut off
  // part way is still the first scan when it resumes. Databases from before the mark have tracks
  // and no mark.
  const indexed = getMeta('library_indexed')
  const firstScan = indexed === '0' || (indexed === undefined && known.size === 0)
  const onFolder = (folder: string) => {
    progress!.current = relative(folder)
  }
  const onFile = () => {
    progress!.found++
    reportProgress()
  }
  let listing: Listing
  try {
    // Never created here: creating it would hide a share that isn't mounted.
    const stat = await unlessStopped(fs.stat(dir), signal)
    if (stat === STOPPED) return stopped()
    if (!stat.isDirectory()) throw Object.assign(new Error(`${dir} isn’t a folder`), { code: 'ENOTDIR' })
    listing = await list(dir, signal, onFolder, onFile)
  } catch (error) {
    return refuse(`Seeker can’t read the music folder, ${dir} (${fsReason(error)}). ${unmountedHint}`, known.size, false, true)
  }
  // A listing cut short says nothing about what's gone, so nothing past here runs.
  if (signal.aborted) return stopped()
  const { files, unreadable, unreadableFiles, covers } = listing
  if (files.length === 0 && known.size > 0) {
    if (unreadable.length || unreadableFiles.size) {
      const paths = [...unreadable, ...unreadableFiles].slice(0, 3).join(', ')
      return refuse(`Seeker couldn’t read folders or files in the music folder, ${dir}: ${paths}. Check the mount and permissions.`, known.size, false, true)
    }
    if (!force) return refuse(`The music folder, ${dir}, is empty, but the library has ${tracks(known.size)}. ${unmountedHint}`, known.size, true, true)
  }

  const seen = new Set(files.map((entry) => entry.file))
  const inUnreadable = (file: string) => unreadable.some((folder) => file.startsWith(folder + path.sep))
  const gone = [...known.keys()].filter((file) => !seen.has(file) && !inUnreadable(file) && !unreadableFiles.has(file))
  if (!force && gone.length >= 100 && gone.length > known.size / 2) {
    return refuse(
      `${gone.length.toLocaleString('en')} of the library’s ${tracks(known.size)} are missing from the music folder, ${dir}. That’s more than Seeker removes without asking, in case the folder isn’t all there.`,
      gone.length,
      true,
      false,
    )
  }

  const toRead = files.filter((entry) => {
    const existing = known.get(entry.file)
    return !existing || existing.mtime !== entry.mtime || existing.size !== entry.size
  })
  // The folder is there and the guards passed, so an earlier refusal no longer holds, and a long
  // scan shouldn't show it while albums appear.
  problem = null
  progress = { phase: 'reading', found: files.length, read: 0, toRead: toRead.length, current: null }
  rateFrom = { at: Date.now(), read: 0 }
  reportProgress(true)
  if (firstScan && indexed !== '0') setMeta('library_indexed', '0')

  let updated = 0
  const saved = batches(covers, announce)
  const reads = toRead.length ? await readConcurrency(true) : LOCAL_READS
  // Two rounds of reads in a row that get no answer mean the share stopped answering, not that the
  // files are odd. Going on would give each remaining file the whole time limit. `shareDown` is how
  // many hadn't answered when the scan stopped for it.
  let unanswered = 0
  let shareDown = 0
  const onBytes = (bytes: number) => {
    bytesRead += bytes
  }
  const read = async (entry: Entry) => {
    if (signal.aborted || saved.failed()) return
    progress!.current = relative(entry.file)
    const row = await readWithin(entry, { stop: signal, onBytes }).catch((error: unknown) => {
      log.warn(`Could not read ${entry.file}`, error)
      return null
    })
    if (row === STOPPED) return
    unanswered = row === TIMED_OUT ? unanswered + 1 : 0
    if ((unanswered >= 2 * reads || stuckReads >= MAX_STUCK_READS) && !shareDown) {
      shareDown = Math.max(unanswered, stuckReads)
      stopScan?.abort()
    }
    if (row && row !== TIMED_OUT) {
      saved.add(row)
      updated++
    }
    progress!.read++
    reportProgress()
  }
  try {
    await eachLimit(toRead, reads, read)
  } catch (error) {
    // No batch is saved once the scan is over.
    await saved.finish().catch(() => {})
    throw error
  }
  const rest = (await saved.finish()).sort(byPath)

  progress = { ...progress!, phase: 'committing', current: null }
  reportProgress(true)
  if (signal.aborted) {
    const reading = { read: progress.read, toRead: toRead.length, files: files.length, updated }
    // What was read is kept; removals wait for a scan that finishes. A first scan tells the share
    // rescans once it's done, as it finds music slskd shares already.
    await saveBatch(rest, covers)
    if (updated && !firstScan) noteLibraryChange()
    return shareDown ? unanswering(shareDown, reading) : stopped(reading)
  }
  await serializeIndex(() => {
    // An import or deletion that changed a path while this scan read files knows better.
    const current = (file: string) => !changedDuringScan!.has(file)
    return commitIndex(rest.filter((row) => current(row.path)), gone.filter(current), { markIndexed: true, covers })
  })
  if (firstScan) {
    // Tracks known at the start were saved by this first scan before it was cut off.
    if (updated || gone.length || known.size) noteInitialLibrary()
  } else if (updated || gone.length) {
    noteLibraryChange()
  }
  if (unreadable.length || unreadableFiles.size) {
    const paths = [...unreadable, ...unreadableFiles]
    const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? ', …' : '')
    log.warn(`Seeker couldn’t read ${paths.length} folders or files in the music folder, so it kept their tracks: ${shown}. Check the mount and permissions.`)
  }
  problem = null
  // Each of these was warned about by name; the count shows they're in the library anyway.
  const odd = unparsed.length ? `, ${unparsed.length} with tags Seeker couldn’t read (named by ffprobe or their paths)` : ''
  const message = `Library scan: ${files.length} files, ${updated} updated, ${gone.length} removed${odd}${force ? ' (forced)' : ''} in ${Date.now() - started} ms`
  log.info(message)
  return result('done', message, { files: files.length, updated, removed: gone.length })
}

// Index specific files right after an import, without walking the whole library. A full scan
// that's running doesn't hold this up: it only waits for that scan's commit, if it's underway.
export async function scanFiles(files: string[]): Promise<void> {
  indexedElsewhere(files)
  const updates: TrackRow[] = []
  await eachLimit(files, await readConcurrency(false), async (file) => {
    try {
      const stat = await fs.stat(file)
      const row = await readWithin({ file, mtime: Math.floor(stat.mtimeMs), size: stat.size })
      if (row !== TIMED_OUT && row !== STOPPED) updates.push(row)
    } catch (error) {
      log.warn(`Could not index ${file}`, error)
    }
  })
  updates.sort(byPath)
  return serializeIndex(async () => {
    try {
      await indexFiles(files, updates)
    } catch (error) {
      // The files are on disk, so a library scan in a few minutes indexes them.
      refuse(`Indexing imported files failed: ${errorMessage(error)}.`, 0, false, true)
      throw error
    } finally {
      announce()
    }
  })
}

async function indexFiles(files: string[], updates: TrackRow[]): Promise<void> {
  const albumIds = albumsOf(updates, files)
  if (albumIds.size) await commitIndex(updates, [], { albumIds })
  if (problem?.message.startsWith('Indexing imported files failed:')) problem = null
  if (updates.length) noteLibraryChange()
}

export function startLibraryScanner() {
  void scanLibrary()
  setInterval(() => void scanLibrary(), 6 * 3600_000).unref()
}
