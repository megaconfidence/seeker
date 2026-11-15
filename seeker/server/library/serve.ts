import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { parseFile } from 'music-metadata'
import type { LibraryAlbum, LibraryAlbumDetail, LibraryArtist, LibraryTrack } from '../../shared/types.ts'
import { config } from '../config.ts'
import { all, exec, get } from '../db.ts'
import { libraryAlbumRung } from './manage.ts'
import { COVER_UNCHECKED } from './scan.ts'

const MIME: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

interface AlbumRow {
  id: string
  title: string
  artist: string
  year: number | null
  dir: string
  cover: string | null
  track_count: number
  duration: number | null
  format: string | null
  deezer_album_id: number | null
  mb_album_id: string | null
  added_at: number
}

interface TrackRow {
  id: number
  path: string
  album_id: string
  title: string
  artist: string
  album: string
  track_no: number | null
  disc_no: number | null
  duration: number | null
  codec: string | null
  bitrate: number | null
  sample_rate: number | null
  bit_depth: number | null
  lossless: number
  // 1 embedded art, 0 none, COVER_UNCHECKED not looked for yet.
  has_cover: number
}

// `hasEmbedded`: some track has embedded art, or hasn't been checked yet (albumCover checks).
function toAlbum(row: AlbumRow, hasEmbedded: boolean): LibraryAlbum {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    year: row.year,
    trackCount: row.track_count,
    duration: row.duration ?? 0,
    format: row.format,
    hasCover: !!row.cover || hasEmbedded,
    addedAt: row.added_at,
    deezerAlbumId: row.deezer_album_id,
    mbAlbumId: row.mb_album_id,
  }
}

function toTrack(row: TrackRow): LibraryTrack {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumId: row.album_id,
    trackNo: row.track_no,
    discNo: row.disc_no,
    duration: row.duration ?? 0,
    codec: row.codec,
    bitrate: row.bitrate,
    sampleRate: row.sample_rate,
    bitDepth: row.bit_depth,
    lossless: row.lossless === 1,
  }
}

export function listAlbums(options: { q?: string; artist?: string; sort?: string }): LibraryAlbum[] {
  const where: string[] = []
  const params: Record<string, string> = {}
  if (options.q) {
    where.push('(a.title LIKE :q OR a.artist LIKE :q)')
    params.q = `%${options.q}%`
  }
  if (options.artist) {
    where.push('a.artist = :artist COLLATE NOCASE')
    params.artist = options.artist
  }
  const order =
    options.sort === 'artist'
      ? 'a.artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE'
      : options.sort === 'title'
        ? 'a.title COLLATE NOCASE'
        : options.sort === 'year'
          ? 'a.year DESC, a.artist COLLATE NOCASE'
          : 'a.added_at DESC'
  const rows = all<AlbumRow & { embedded: number }>(
    `SELECT a.*, EXISTS(SELECT 1 FROM lib_tracks t WHERE t.album_id = a.id AND t.has_cover != 0) AS embedded
     FROM lib_albums a ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 2000`,
    params,
  )
  return rows.map((row) => toAlbum(row, row.embedded === 1))
}

export function getAlbum(id: string): LibraryAlbumDetail | null {
  const row = get<AlbumRow>('SELECT * FROM lib_albums WHERE id = ?', [id])
  if (!row) return null
  const tracks = all<TrackRow>(
    'SELECT * FROM lib_tracks WHERE album_id = ? ORDER BY COALESCE(disc_no, 1), COALESCE(track_no, 999), title',
    [id],
  )
  const unsorted = path.relative(config.musicDir, row.dir).split(path.sep)[0] === '_Unsorted'
  return {
    album: toAlbum(row, tracks.some((track) => track.has_cover !== 0)),
    tracks: tracks.map(toTrack),
    canUpgrade: !libraryAlbumRung(id).best,
    unsorted,
  }
}

export function listArtists(): LibraryArtist[] {
  return all<{ name: string; albums: number; tracks: number; cover: string | null }>(
    `SELECT a.artist AS name, COUNT(*) AS albums, SUM(a.track_count) AS tracks,
       (SELECT id FROM lib_albums b WHERE b.artist = a.artist ORDER BY b.year DESC LIMIT 1) AS cover
     FROM lib_albums a GROUP BY a.artist COLLATE NOCASE ORDER BY a.artist COLLATE NOCASE`,
  ).map((row) => ({ name: row.name, albums: row.albums, tracks: row.tracks, coverAlbumId: row.cover }))
}

export function searchTracks(q: string, limit = 50): LibraryTrack[] {
  return all<TrackRow>(
    `SELECT * FROM lib_tracks WHERE title LIKE :q OR artist LIKE :q OR album LIKE :q ORDER BY artist, album, disc_no, track_no LIMIT ${limit}`,
    { q: `%${q}%` },
  ).map(toTrack)
}

function insideLibrary(file: string): boolean {
  const resolved = path.resolve(file)
  return resolved === config.musicDir || resolved.startsWith(config.musicDir + path.sep)
}

function fileResponse(file: string, size: number, range: string | undefined): Response {
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const match = range?.match(/bytes=(\d*)-(\d*)/)
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : size - Number(match[2])
    let end = match[1] && match[2] ? Number(match[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  }
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream
  return new Response(stream, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    },
  })
}

export async function streamTrack(id: number, range: string | undefined): Promise<Response> {
  const row = get<{ path: string }>('SELECT path FROM lib_tracks WHERE id = ?', [id])
  if (!row || !insideLibrary(row.path)) return new Response('Not found', { status: 404 })
  try {
    const stat = await fs.stat(row.path)
    return fileResponse(row.path, stat.size, range)
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

export async function albumCover(id: string): Promise<Response> {
  const album = get<AlbumRow>('SELECT * FROM lib_albums WHERE id = ?', [id])
  if (!album) return new Response('Not found', { status: 404 })
  if (album.cover && insideLibrary(album.cover)) {
    try {
      const stat = await fs.stat(album.cover)
      const response = fileResponse(album.cover, stat.size, undefined)
      response.headers.set('Cache-Control', 'private, max-age=86400')
      return response
    } catch {
      // fall back to embedded art
    }
  }
  const cacheDir = path.join(config.dataDir, 'covers')
  const cached = path.join(cacheDir, `${id}.img`)
  const newest = get<{ mtime: number }>('SELECT MAX(mtime) AS mtime FROM lib_tracks WHERE album_id = ?', [id])?.mtime ?? 0
  try {
    const stat = await fs.stat(cached)
    if (stat.mtimeMs >= newest) {
      const data = await fs.readFile(cached)
      return new Response(data, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } })
    }
  } catch {
    // not cached yet
  }
  // Library scans don't read covers, so embedded art is looked for here, the first time the album is
  // shown, and the answer kept in has_cover.
  const track = get<{ id: number; path: string; has_cover: number }>(
    `SELECT id, path, has_cover FROM lib_tracks WHERE album_id = ? AND has_cover != 0
     ORDER BY has_cover DESC, COALESCE(disc_no, 1), COALESCE(track_no, 999) LIMIT 1`,
    [id],
  )
  if (!track) return new Response('Not found', { status: 404 })
  try {
    const meta = await parseFile(track.path, { skipCovers: false, duration: false })
    const picture = meta.common.picture?.[0]
    if (!picture) {
      // An album's files nearly always share their art, so one without it settles the album.
      exec('UPDATE lib_tracks SET has_cover = 0 WHERE album_id = ? AND (has_cover = ? OR id = ?)', [id, COVER_UNCHECKED, track.id])
      return new Response('Not found', { status: 404 })
    }
    if (track.has_cover !== 1) exec('UPDATE lib_tracks SET has_cover = 1 WHERE id = ?', [track.id])
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(cached, picture.data)
    return new Response(Buffer.from(picture.data), {
      headers: { 'Content-Type': picture.format || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
