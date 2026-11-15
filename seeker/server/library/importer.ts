import fs from 'node:fs/promises'
import path from 'node:path'
import type { ImportCandidate, ImportChoice, ImportFolder, Job, JobTarget } from '../../shared/types.ts'
import { buildAlbumTarget, buildMbTarget } from '../catalog.ts'
import { config } from '../config.ts'
import { all } from '../db.ts'
import { queueImport } from '../jobs/engine.ts'
import { logJob } from '../jobs/store.ts'
import { similarity, stripExtras } from '../match/normalize.ts'
import { deezer } from '../metadata/deezer.ts'
import { coverArtUrl, searchReleases } from '../metadata/musicbrainz.ts'
import { assignTracks, type Folder } from '../soulseek/album.ts'
import { toCandidate, type Candidate } from '../soulseek/files.ts'
import { TtlCache } from '../util.ts'
import { AUDIO_EXTENSIONS } from './scan.ts'
import { readTags } from './tags.ts'

interface LocalFile {
  path: string
  size: number
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  track: number | null
  disc: number | null
  duration: number | null
  year: number | null
  format: string
}

const DISC_DIR = /^(cd|disc|disk)[\s._-]*\d{1,2}\b/i
const tagCache = new Map<string, { mtime: number; file: LocalFile }>()
const candidateCache = new TtlCache<{ target: JobTarget; pairs: Map<number, string> }>(200)

async function walk(dir: string, out: { path: string; size: number; mtime: number }[]) {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const stat = await fs.stat(full).catch(() => null)
      if (stat) out.push({ path: full, size: stat.size, mtime: Math.floor(stat.mtimeMs) })
    }
  }
}

// "Album/CD1/01.flac" belongs to "Album".
function albumDirOf(file: string): string {
  const dir = path.dirname(file)
  return DISC_DIR.test(path.basename(dir)) ? path.dirname(dir) : dir
}

async function readFile(entry: { path: string; size: number; mtime: number }): Promise<LocalFile> {
  const cached = tagCache.get(entry.path)
  if (cached && cached.mtime === entry.mtime) return cached.file
  let file: LocalFile = {
    path: entry.path,
    size: entry.size,
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    track: null,
    disc: null,
    duration: null,
    year: null,
    format: path.extname(entry.path).slice(1).toUpperCase(),
  }
  try {
    // Like library scans, without reading embedded art: import folders are often network shares too.
    const meta = await readTags(entry.path)
    const common = meta.common
    const discFromDir = path.basename(path.dirname(entry.path)).match(/(\d{1,2})\s*$/)
    file = {
      ...file,
      title: common.title?.trim() || null,
      artist: common.artist?.trim() || null,
      album: common.album?.trim() || null,
      albumArtist: common.albumartist?.trim() || null,
      track: common.track?.no ?? null,
      disc: common.disk?.no ?? (DISC_DIR.test(path.basename(path.dirname(entry.path))) && discFromDir ? Number(discFromDir[1]) : null),
      duration: meta.format.duration ?? null,
      year: common.year ?? null,
      format: meta.format.lossless ? (meta.format.codec ?? file.format).split(' ')[0]!.toUpperCase() : file.format,
    }
  } catch {
    // unreadable tags: identify by file name
  }
  tagCache.set(entry.path, { mtime: entry.mtime, file })
  return file
}

function mostCommon(values: (string | number | null)[]): string | null {
  const counts = new Map<string, number>()
  for (const value of values) if (value !== null && value !== '') counts.set(String(value), (counts.get(String(value)) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

const encodeId = (relative: string) => Buffer.from(relative).toString('base64url')

function decodeId(id: string): string {
  const relative = Buffer.from(id, 'base64url').toString('utf8')
  const absolute = path.resolve(config.importDir, relative)
  if (absolute !== config.importDir && !absolute.startsWith(config.importDir + path.sep)) throw new Error('Invalid folder')
  return absolute
}

export async function listImportFolders(): Promise<{ dir: string; exists: boolean; folders: ImportFolder[] }> {
  const exists = await fs
    .stat(config.importDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false)
  if (!exists) return { dir: config.importDir, exists, folders: [] }
  const entries: { path: string; size: number; mtime: number }[] = []
  await walk(config.importDir, entries)
  const groups = new Map<string, typeof entries>()
  for (const entry of entries) {
    const key = albumDirOf(entry.path)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const folders: ImportFolder[] = []
  for (const [dir, files] of groups) {
    const sample = await Promise.all(files.slice(0, 3).map(readFile))
    folders.push({
      id: encodeId(path.relative(config.importDir, dir)),
      path: path.relative(config.importDir, dir) || '.',
      name: path.basename(dir),
      files: files.length,
      size: files.reduce((sum, file) => sum + file.size, 0),
      artist: mostCommon(sample.map((file) => file.albumArtist ?? file.artist)),
      album: mostCommon(sample.map((file) => file.album)),
      year: Number(mostCommon(sample.map((file) => file.year))) || null,
      formats: [...new Set(sample.map((file) => file.format))],
    })
  }
  return { dir: config.importDir, exists, folders: folders.sort((a, b) => a.path.localeCompare(b.path)) }
}

async function folderFiles(id: string): Promise<{ dir: string; files: LocalFile[] }> {
  const dir = decodeId(id)
  const entries: { path: string; size: number; mtime: number }[] = []
  await walk(dir, entries)
  const own = entries.filter((entry) => albumDirOf(entry.path) === dir)
  return { dir, files: await Promise.all(own.map(readFile)) }
}

async function libraryFiles(albumId: string): Promise<{ dir: string; files: LocalFile[] }> {
  const rows = all<{ path: string; size: number; mtime: number }>('SELECT path, size, mtime FROM lib_tracks WHERE album_id = ?', [albumId])
  if (rows.length === 0) throw new Error('Album not found')
  const files = await Promise.all(rows.map(readFile))
  return { dir: path.dirname(rows[0]!.path), files }
}

// Turn local files into match candidates, using tags for the title when they have them.
function toEntries(dir: string, files: LocalFile[]) {
  const peer = { freeSlot: true, speed: 0, queue: 0 }
  const entries: { file: Candidate; quality: { rung: number; tier: number; label: string; format: 'other'; lossless: boolean } }[] = []
  const byFilename = new Map<string, LocalFile>()
  for (const local of files) {
    const ext = path.extname(local.path)
    const name = local.title
      ? `${String(local.track ?? '').padStart(local.track ? 2 : 0, '0')} ${local.title}`.trim()
      : path.basename(local.path, ext)
    const filename = `${dir}/${local.disc && local.disc > 1 ? `CD${local.disc}/` : ''}${name}${ext}`
    const candidate = toCandidate('local', { filename, size: local.size, length: local.duration ?? undefined }, peer)
    if (!candidate) continue
    byFilename.set(filename, local)
    entries.push({ file: candidate, quality: { rung: 0, tier: 0, label: local.format, format: 'other', lossless: false } })
  }
  return { entries, byFilename }
}

function assign(target: JobTarget, dir: string, files: LocalFile[]) {
  const { entries, byFilename } = toEntries(dir, files)
  const folder: Folder = { key: dir, username: 'local', dir, name: path.basename(dir), files: entries.map((entry) => entry.file), discOf: new Map() }
  for (const entry of entries) {
    const local = byFilename.get(entry.file.filename)
    if (local?.disc) folder.discOf.set(entry.file.filename, local.disc)
  }
  const assignment = assignTracks(target.tracks, entries, { artist: target.album.artist, album: target.album.title, folder })
  const pairs = new Map<number, string>()
  for (const [index, candidate] of assignment.pairs) {
    const local = byFilename.get(candidate.filename)
    if (local) pairs.set(index, local.path)
  }
  return pairs
}

async function identify(cacheKey: string, dir: string, files: LocalFile[]): Promise<ImportCandidate[]> {
  const artist = mostCommon(files.map((file) => file.albumArtist ?? file.artist))
  const album = mostCommon(files.map((file) => file.album))
  const query = artist && album ? `${artist} ${stripExtras(album)}` : path.basename(dir).replace(/[_.]+/g, ' ')
  const wantTitle = album ?? path.basename(dir)

  const options: { source: 'deezer' | 'musicbrainz'; id: number; mbid: string | null; title: string; artist: string; cover: string | null }[] = []
  for (const result of await deezer.searchAlbums(query, 6).catch(() => [])) {
    options.push({ source: 'deezer', id: result.id, mbid: null, title: result.title, artist: result.artist?.name ?? '', cover: result.cover_big ?? null })
  }
  const strong = options.some((option) => similarity(option.title, wantTitle) >= 0.7)
  if (!strong) {
    for (const release of await searchReleases(artist && album ? `${artist} - ${album}` : query, 4).catch(() => [])) {
      options.push({ source: 'musicbrainz', id: 0, mbid: release.releaseId, title: release.title, artist: release.artist, cover: coverArtUrl(release.releaseId, 250, release.releaseGroupId) })
    }
  }

  const results: ImportCandidate[] = []
  for (const option of options.slice(0, 6)) {
    try {
      const target = option.source === 'deezer' ? await buildAlbumTarget(option.id) : await buildMbTarget(option.mbid!)
      const pairs = assign(target, dir, files)
      candidateCache.set(`${cacheKey}:${option.source}:${option.mbid ?? option.id}`, { target, pairs }, 30 * 60_000)
      const titleScore = similarity(option.title, wantTitle)
      const artistScore = artist ? similarity(option.artist, artist) : 0.5
      const fileCoverage = files.length ? pairs.size / files.length : 0
      const countFit = 1 - Math.min(1, Math.abs(files.length - target.tracks.length) / Math.max(files.length, target.tracks.length))
      results.push({
        source: option.source,
        id: option.id,
        mbid: option.mbid,
        title: option.title,
        artist: option.artist,
        year: target.album.originalYear ?? target.album.year ?? null,
        cover: option.cover ?? target.album.coverUrl ?? null,
        trackCount: target.tracks.length,
        matched: pairs.size,
        files: files.length,
        score: 0.3 * titleScore + 0.2 * artistScore + 0.35 * fileCoverage + 0.15 * countFit,
      })
    } catch {
      // skip candidates we can't load
    }
  }
  return results.sort((a, b) => b.score - a.score)
}

async function queue(cacheKey: string, dir: string, files: LocalFile[], choice: ImportChoice, mode: 'copy' | 'move'): Promise<Job> {
  const artist = mostCommon(files.map((file) => file.albumArtist ?? file.artist)) ?? 'Unknown Artist'
  const album = mostCommon(files.map((file) => file.album)) ?? path.basename(dir)
  if ('asIs' in choice) {
    return queueImport({
      files: files.map((file) => ({ path: file.path, size: file.size, trackIndex: null })),
      target: {
        album: { title: album, artist, trackCount: files.length, discCount: 1, mbChecked: true },
        tracks: [],
        importMode: mode,
      },
      title: album,
      artist,
      origin: 'manual',
    })
  }
  const key = `${cacheKey}:${'mbid' in choice ? 'musicbrainz' : 'deezer'}:${'mbid' in choice ? choice.mbid : choice.albumId}`
  let prepared = candidateCache.get(key)
  if (!prepared) {
    const target = 'mbid' in choice ? await buildMbTarget(choice.mbid) : await buildAlbumTarget(choice.albumId)
    prepared = { target, pairs: assign(target, dir, files) }
  }
  const { target, pairs } = prepared
  if (pairs.size === 0) throw new Error('None of these files match that album’s tracks')
  const matchedPaths = new Set(pairs.values())
  const job = queueImport({
    files: [...pairs.entries()].map(([trackIndex, file]) => ({
      path: file,
      size: files.find((local) => local.path === file)?.size ?? 0,
      trackIndex,
    })),
    target: { ...target, wanted: [...pairs.keys()], importMode: mode },
    title: target.album.title,
    artist: target.album.artist,
    coverUrl: target.album.coverUrl ?? null,
    deezerAlbumId: target.album.deezerId ?? null,
    mbReleaseId: target.album.mbReleaseId ?? null,
    origin: 'manual',
  })
  const leftOver = files.filter((file) => !matchedPaths.has(file.path)).length
  if (leftOver) logJob(job.id, 'info', `${leftOver} file(s) didn’t match a track on the album and were left where they are`)
  return job
}

export async function identifyImportFolder(id: string): Promise<ImportCandidate[]> {
  const { dir, files } = await folderFiles(id)
  return identify(`import:${id}`, dir, files)
}

export async function importFolder(id: string, choice: ImportChoice, mode: 'copy' | 'move'): Promise<Job> {
  const { dir, files } = await folderFiles(id)
  if (files.length === 0) throw new Error('This folder has no audio files')
  return queue(`import:${id}`, dir, files, choice, mode)
}

export async function identifyLibraryAlbum(albumId: string): Promise<ImportCandidate[]> {
  const { dir, files } = await libraryFiles(albumId)
  return identify(`library:${albumId}`, dir, files)
}

// Re-tag and re-file a library album against a catalog album (fixes unsorted or mismatched albums).
export async function rematchLibraryAlbum(albumId: string, choice: ImportChoice): Promise<Job> {
  const { dir, files } = await libraryFiles(albumId)
  return queue(`library:${albumId}`, dir, files, choice, 'move')
}
