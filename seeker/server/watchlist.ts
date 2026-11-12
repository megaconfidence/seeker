import type { RecordType, WatchArtist } from '../shared/types.ts'
import { all, exec, get } from './db.ts'
import { emit } from './events.ts'
import { AlreadyOwnedError, queueAlbum } from './jobs/engine.ts'
import { logger } from './log.ts'
import { normalize, stripExtras } from './match/normalize.ts'
import { deezer, type DzAlbum } from './metadata/deezer.ts'
import { getSettings } from './settings.ts'
import { errorMessage, sleep } from './util.ts'

const log = logger('watchlist')

interface WatchRow {
  deezer_id: number
  name: string
  picture: string | null
  types: string
  since: string
  added_at: number
  last_checked_at: number | null
  last_found: number
}

function toArtist(row: WatchRow): WatchArtist {
  return {
    id: row.deezer_id,
    name: row.name,
    picture: row.picture,
    types: JSON.parse(row.types) as RecordType[],
    since: row.since,
    addedAt: row.added_at,
    lastCheckedAt: row.last_checked_at,
    lastFound: row.last_found,
  }
}

export function listWatchlist(): WatchArtist[] {
  return all<WatchRow>('SELECT * FROM watch_artists ORDER BY name COLLATE NOCASE').map(toArtist)
}

export async function watchArtist(id: number, options: { types?: RecordType[]; since?: string } = {}): Promise<WatchArtist> {
  const artist = await deezer.artist(id)
  // Deezer often lists releases a few days late, so start the window two weeks back.
  const since = options.since ?? new Date(Date.now() - 14 * 24 * 3600_000).toISOString().slice(0, 10)
  exec(
    `INSERT INTO watch_artists (deezer_id, name, picture, types, since, added_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(deezer_id) DO UPDATE SET name = excluded.name, picture = excluded.picture, types = excluded.types`,
    [
      id,
      artist.name,
      artist.picture_big ?? artist.picture_medium ?? null,
      JSON.stringify(options.types ?? getSettings().watchlist.types),
      since,
      Date.now(),
    ],
  )
  emit({ type: 'watchlist' })
  void checkArtist(id).catch((error) => log.warn(`First check of ${artist.name} failed`, error))
  return toArtist(get<WatchRow>('SELECT * FROM watch_artists WHERE deezer_id = ?', [id])!)
}

export function updateWatch(id: number, patch: { types?: RecordType[] }) {
  if (patch.types) exec('UPDATE watch_artists SET types = ? WHERE deezer_id = ?', [JSON.stringify(patch.types), id])
  emit({ type: 'watchlist' })
}

export function unwatchArtist(id: number) {
  exec('DELETE FROM watch_artists WHERE deezer_id = ?', [id])
  emit({ type: 'watchlist' })
}

export async function checkArtist(id: number): Promise<number> {
  const row = get<WatchRow>('SELECT * FROM watch_artists WHERE deezer_id = ?', [id])
  if (!row) return 0
  const types = JSON.parse(row.types) as string[]
  const albums = await deezer.artistAlbums(id, true)
  const known = new Set(
    all<{ deezer_album_id: number }>("SELECT deezer_album_id FROM jobs WHERE deezer_album_id IS NOT NULL AND kind = 'album'").map(
      (job) => job.deezer_album_id,
    ),
  )
  // "Album" and "Album (Deluxe Edition)" are the same release for this purpose.
  const base = (title: string) => normalize(stripExtras(title))
  const knownTitles = new Set(
    all<{ title: string }>("SELECT title FROM jobs WHERE kind = 'album' AND deezer_artist_id = ?", [id]).map((job) => base(job.title)),
  )
  const fuller = (album: DzAlbum) => (/\b(deluxe|expanded|complete|edition)\b/i.test(album.title) ? 1 : 0)
  const fresh = new Map<string, DzAlbum>()
  for (const album of albums) {
    if (!album.release_date || album.release_date < row.since) continue
    if (!types.includes(album.record_type ?? 'album')) continue
    if (known.has(album.id)) continue
    const key = base(album.title)
    if (knownTitles.has(key)) continue
    const existing = fresh.get(key)
    if (
      !existing ||
      fuller(album) > fuller(existing) ||
      (fuller(album) === fuller(existing) && album.explicit_lyrics && !existing.explicit_lyrics)
    ) {
      fresh.set(key, album)
    }
  }
  let queued = 0
  for (const album of fresh.values()) {
    try {
      await queueAlbum(album.id, 'watchlist')
      queued++
      log.info(`New release from ${row.name}: ${album.title}`)
    } catch (error) {
      if (!(error instanceof AlreadyOwnedError)) log.warn(`Could not queue ${album.title}: ${errorMessage(error)}`)
    }
  }
  exec('UPDATE watch_artists SET last_checked_at = ?, last_found = last_found + ? WHERE deezer_id = ?', [Date.now(), queued, id])
  emit({ type: 'watchlist' })
  return queued
}

let checking = false

export async function checkDueArtists(force = false) {
  if (checking) return
  checking = true
  try {
    const interval = getSettings().watchlist.intervalHours * 3600_000
    const due = all<WatchRow>('SELECT * FROM watch_artists ORDER BY last_checked_at').filter(
      (row) => force || !row.last_checked_at || Date.now() - row.last_checked_at >= interval,
    )
    for (const row of due) {
      try {
        await checkArtist(row.deezer_id)
      } catch (error) {
        log.warn(`Checking ${row.name} failed: ${errorMessage(error)}`)
      }
      await sleep(4000)
    }
  } finally {
    checking = false
  }
}

export function startWatchlist() {
  setTimeout(() => void checkDueArtists(), 60_000).unref()
  setInterval(() => void checkDueArtists(), 15 * 60_000).unref()
}
