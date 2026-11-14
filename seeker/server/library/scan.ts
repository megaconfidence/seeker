import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import type { LibraryProblem, LibraryStatus, ScanResult } from '../../shared/types.ts'
import { config } from '../config.ts'
import { all, exec, get, transaction } from '../db.ts'
import { emit } from '../events.ts'
import { fsReason } from '../folders.ts'
import { logger } from '../log.ts'
import { normalize, stripExtras } from '../match/normalize.ts'
import { noteLibraryChange } from '../shares.ts'
import { errorMessage } from '../util.ts'
import { rebuildOwnedIndex } from './owned.ts'

const log = logger('library')

export const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aiff', '.aif', '.wv', '.ape', '.alac'])
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart']
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']
// How soon to look again when the music folder seemed unmounted.
const RETRY_MS = 10 * 60_000

let scanning = false
let pending: { force: boolean } | null = null
let problem: LibraryProblem | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined

export function libraryCounts() {
  const albums = get<{ n: number }>('SELECT COUNT(*) AS n FROM lib_albums')?.n ?? 0
  const tracks = get<{ n: number }>('SELECT COUNT(*) AS n FROM lib_tracks')?.n ?? 0
  return { albums, tracks }
}

export function libraryStatus(): LibraryStatus {
  return { ...libraryCounts(), scanning, problem }
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
  try {
    if (!(await fs.stat(dir)).isDirectory()) return `The music folder, ${dir}, isn’t a folder.`
    for await (const entry of await fs.opendir(dir)) if (!entry.name.startsWith('.')) return null
  } catch (error) {
    return `Seeker can’t read the music folder, ${dir} (${fsReason(error)}). ${unmountedHint}`
  }
  const known = libraryCounts().tracks
  return known > 0 ? `The music folder, ${dir}, is empty, but the library has ${tracks(known)}. ${unmountedHint}` : null
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

// Folders that can't be read are collected rather than skipped, so their tracks aren't taken as
// deleted. Only failing to read the music folder itself is an error.
async function walk(dir: string, out: Entry[], unreadable: string[], root = false) {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (root) throw error
    // A folder that vanished during the scan is simply gone; anything else may come back.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(dir)
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, out, unreadable)
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      try {
        const stat = await fs.stat(full)
        out.push({ file: full, mtime: Math.floor(stat.mtimeMs), size: stat.size })
      } catch {
        // vanished between readdir and stat
      }
    }
  }
}

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

async function readTrack(file: string, mtime: number, size: number) {
  const meta = await parseFile(file, { skipCovers: false, duration: false })
  const common = meta.common
  const format = meta.format
  const dirName = path.basename(path.dirname(file))
  const title = common.title?.trim() || path.basename(file, path.extname(file))
  const artist = common.artist?.trim() || common.albumartist?.trim() || 'Unknown Artist'
  const album = common.album?.trim() || dirName
  const albumArtist = common.albumartist?.trim() || artist
  return {
    path: file,
    album_id: albumIdFor(albumArtist, album),
    mtime,
    size,
    title,
    artist,
    album,
    album_artist: albumArtist,
    track_no: common.track?.no ?? null,
    disc_no: common.disk?.no ?? null,
    year: common.year ?? (common.date ? Number.parseInt(common.date.slice(0, 4), 10) || null : null),
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
    has_cover: common.picture && common.picture.length > 0 ? 1 : 0,
  }
}

type TrackRow = Awaited<ReturnType<typeof readTrack>>

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

async function findCover(dir: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  const lower = new Map(entries.map((name) => [name.toLowerCase(), name]))
  for (const base of COVER_NAMES) {
    for (const ext of COVER_EXTENSIONS) {
      const name = lower.get(base + ext)
      if (name) return path.join(dir, name)
    }
  }
  const anyImage = entries.find((name) => COVER_EXTENSIONS.includes(path.extname(name).toLowerCase()))
  return anyImage ? path.join(dir, anyImage) : null
}

function commonDir(paths: string[]): string {
  if (paths.length === 0) return config.musicDir
  let prefix = path.dirname(paths[0]!)
  for (const file of paths.slice(1)) {
    while (!file.startsWith(prefix + path.sep) && prefix.length > config.musicDir.length) prefix = path.dirname(prefix)
  }
  return prefix
}

async function rebuildAlbums(albumIds?: Set<string>) {
  const where = albumIds ? `WHERE album_id IN (${[...albumIds].map(() => '?').join(',')})` : ''
  const params = albumIds ? [...albumIds] : []
  const rows = all<{
    id: number
    path: string
    album_id: string
    title: string
    album: string
    album_artist: string
    year: number | null
    duration: number | null
    codec: string | null
    lossless: number
    bit_depth: number | null
    sample_rate: number | null
    bitrate: number | null
    mb_album_id: string | null
    added_at: number
  }>(
    `SELECT id, path, album_id, title, album, album_artist, year, duration, codec, lossless, bit_depth, sample_rate,
       bitrate, mb_album_id, added_at FROM lib_tracks ${where}`,
    params,
  )
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

  const albums: Record<string, unknown>[] = []
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
      cover: await findCover(dir),
      track_count: tracks.length,
      duration: tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0),
      format,
      norm_key: `${normalize(firstTrack.album_artist)}\u0000${normalize(stripExtras(firstTrack.album))}`,
      mb_album_id: tracks.find((track) => track.mb_album_id)?.mb_album_id ?? null,
      deezer_album_id: deezerId,
      added_at: Math.min(...tracks.map((track) => track.added_at)),
    })
  }

  transaction(() => {
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
        album as Record<string, string | number | null>,
      )
    }
  })
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
  if (scanning) {
    pending = { force: !!options.force || !!pending?.force }
    return result('queued', 'A library scan is already running; Seeker scans again when it finishes.')
  }
  scanning = true
  announce()
  try {
    return await scan(!!options.force)
  } catch (error) {
    log.error('Library scan failed', error)
    return result('refused', `The library scan failed: ${errorMessage(error)}`)
  } finally {
    scanning = false
    announce()
    if (pending) {
      const next = pending
      pending = null
      void scanLibrary(next)
    }
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

async function scan(force: boolean): Promise<ScanResult> {
  const started = Date.now()
  const dir = config.musicDir
  clearTimeout(retryTimer)
  const known = new Map(
    all<{ path: string; mtime: number; size: number }>('SELECT path, mtime, size FROM lib_tracks').map((row) => [row.path, row]),
  )
  const files: Entry[] = []
  const unreadable: string[] = []
  try {
    // Never created here: creating it would hide a share that isn't mounted.
    if (!(await fs.stat(dir)).isDirectory()) throw Object.assign(new Error(`${dir} isn’t a folder`), { code: 'ENOTDIR' })
    await walk(dir, files, unreadable, true)
  } catch (error) {
    return refuse(`Seeker can’t read the music folder, ${dir} (${fsReason(error)}). ${unmountedHint}`, known.size, false, true)
  }
  if (files.length === 0 && known.size > 0 && !force) {
    return refuse(`The music folder, ${dir}, is empty, but the library has ${tracks(known.size)}. ${unmountedHint}`, known.size, true, true)
  }

  const seen = new Set(files.map((entry) => entry.file))
  const inUnreadable = (file: string) => unreadable.some((folder) => file.startsWith(folder + path.sep))
  const gone = [...known.keys()].filter((file) => !seen.has(file) && !inUnreadable(file))
  const limit = Math.max(100, Math.floor(known.size / 2))
  if (gone.length > limit && !force) {
    return refuse(
      `${gone.length.toLocaleString('en')} of the library’s ${tracks(known.size)} are missing from the music folder, ${dir}. That’s more than Seeker removes without asking, in case the folder isn’t all there.`,
      gone.length,
      true,
      false,
    )
  }

  let updated = 0
  const now = Date.now()
  for (const entry of files) {
    const existing = known.get(entry.file)
    if (existing && existing.mtime === entry.mtime && existing.size === entry.size) continue
    try {
      upsertTrack(await readTrack(entry.file, entry.mtime, entry.size), now)
      updated++
    } catch (error) {
      log.warn(`Could not read ${entry.file}`, error)
    }
  }
  transaction(() => {
    for (const file of gone) exec('DELETE FROM lib_tracks WHERE path = ?', [file])
  })
  await rebuildAlbums()
  rebuildOwnedIndex()
  if (updated || gone.length) noteLibraryChange()
  if (unreadable.length) {
    const shown = unreadable.slice(0, 3).join(', ') + (unreadable.length > 3 ? ', …' : '')
    log.warn(`Seeker couldn’t read ${unreadable.length} ${unreadable.length === 1 ? 'folder' : 'folders'} in the music folder, so it kept their tracks: ${shown}. Check their permissions.`)
  }
  problem = null
  const message = `Library scan: ${files.length} files, ${updated} updated, ${gone.length} removed${force ? ' (forced)' : ''} in ${Date.now() - started} ms`
  log.info(message)
  return result('done', message, { files: files.length, updated, removed: gone.length })
}

// Index specific files right after an import, without walking the whole library.
export async function scanFiles(files: string[]): Promise<void> {
  const albumIds = new Set<string>()
  const now = Date.now()
  for (const file of files) {
    const previous = get<{ album_id: string }>('SELECT album_id FROM lib_tracks WHERE path = ?', [file])
    if (previous) albumIds.add(previous.album_id)
    try {
      const stat = await fs.stat(file)
      const row = await readTrack(file, Math.floor(stat.mtimeMs), stat.size)
      upsertTrack(row, now)
      albumIds.add(row.album_id)
    } catch (error) {
      log.warn(`Could not index ${file}`, error)
    }
  }
  if (albumIds.size) await rebuildAlbums(albumIds)
  rebuildOwnedIndex()
  noteLibraryChange()
  announce()
}

export function startLibraryScanner() {
  void scanLibrary()
  setInterval(() => void scanLibrary(), 6 * 3600_000).unref()
}
