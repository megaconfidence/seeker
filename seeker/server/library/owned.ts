import type { OwnedState } from '../../shared/types.ts'
import { all } from '../db.ts'
import { normalize, similarity, stripExtras } from '../match/normalize.ts'

interface AlbumEntry {
  id: string
  trackCount: number
}

interface LibTrack {
  id: number
  disc: number
  track: number | null
  normTitle: string
}

let byDeezer = new Map<number, AlbumEntry>()
let byMb = new Map<string, AlbumEntry>()
let byKey = new Map<string, AlbumEntry>()
let tracksByKey = new Map<string, number>()
let tracksByIsrc = new Map<string, number>()
let tracksByAlbum = new Map<string, LibTrack[]>()

export function rebuildOwnedIndex() {
  const albums = all<{ id: string; track_count: number; norm_key: string; deezer_album_id: number | null; mb_album_id: string | null }>(
    'SELECT id, track_count, norm_key, deezer_album_id, mb_album_id FROM lib_albums',
  )
  const nextDeezer = new Map<number, AlbumEntry>()
  const nextMb = new Map<string, AlbumEntry>()
  const nextKey = new Map<string, AlbumEntry>()
  for (const album of albums) {
    const entry = { id: album.id, trackCount: album.track_count }
    if (album.deezer_album_id) nextDeezer.set(album.deezer_album_id, entry)
    if (album.mb_album_id) nextMb.set(album.mb_album_id, entry)
    const existing = nextKey.get(album.norm_key)
    if (!existing || existing.trackCount < entry.trackCount) nextKey.set(album.norm_key, entry)
  }
  const nextTracks = new Map<string, number>()
  const nextIsrc = new Map<string, number>()
  const nextByAlbum = new Map<string, LibTrack[]>()
  for (const track of all<{
    id: number
    album_id: string
    disc_no: number | null
    track_no: number | null
    norm_artist: string
    norm_title: string
    isrc: string | null
  }>('SELECT id, album_id, disc_no, track_no, norm_artist, norm_title, isrc FROM lib_tracks')) {
    nextTracks.set(`${track.norm_artist}\u0000${track.norm_title}`, track.id)
    if (track.isrc) nextIsrc.set(track.isrc.toUpperCase(), track.id)
    const list = nextByAlbum.get(track.album_id) ?? []
    list.push({ id: track.id, disc: track.disc_no ?? 1, track: track.track_no, normTitle: track.norm_title })
    nextByAlbum.set(track.album_id, list)
  }
  byDeezer = nextDeezer
  byMb = nextMb
  byKey = nextKey
  tracksByKey = nextTracks
  tracksByIsrc = nextIsrc
  tracksByAlbum = nextByAlbum
}

export interface WantedTrack {
  artist: string
  title: string
  isrc?: string | null
  disc?: number | null
  track?: number | null
}

// Library track ids for an album's tracks (null when missing). Tracks are matched by ISRC, then by
// position within the library's copy of the album, then by title, but only when the title is unique
// on the album, so repeated titles ("Interlude", "Ghosts I") don't all count as owned.
export function ownedTrackIds(tracks: WantedTrack[], libraryAlbumId: string | null): (number | null)[] {
  const keys = tracks.map((track) => normalize(stripExtras(track.title)))
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  const inAlbum = libraryAlbumId ? (tracksByAlbum.get(libraryAlbumId) ?? []) : []
  const used = new Set<number>()
  const take = (id: number | null | undefined) => {
    if (id === null || id === undefined || used.has(id)) return null
    used.add(id)
    return id
  }
  return tracks.map((track, index) => {
    const key = keys[index]!
    const byIsrc = track.isrc ? take(tracksByIsrc.get(track.isrc.toUpperCase())) : null
    if (byIsrc) return byIsrc
    if (track.track !== null && track.track !== undefined) {
      const positioned = inAlbum.find(
        (lib) =>
          !used.has(lib.id) &&
          lib.track === track.track &&
          lib.disc === (track.disc ?? 1) &&
          (lib.normTitle === key || similarity(lib.normTitle, key) >= 0.8),
      )
      if (positioned) return take(positioned.id)
    }
    if (counts.get(key) !== 1) return null
    const titled = inAlbum.find((lib) => !used.has(lib.id) && lib.normTitle === key)
    if (titled) return take(titled.id)
    return take(tracksByKey.get(`${normalize(track.artist)}\u0000${key}`))
  })
}

export function findLibraryAlbum(ref: number | string | null, artist: string, title: string): AlbumEntry | null {
  if (typeof ref === 'number' && ref) {
    const entry = byDeezer.get(ref)
    if (entry) return entry
  }
  if (typeof ref === 'string' && ref) {
    const entry = byMb.get(ref)
    if (entry) return entry
  }
  return byKey.get(`${normalize(artist)}\u0000${normalize(stripExtras(title))}`) ?? null
}

export function albumOwned(ref: number | string | null, artist: string, title: string, trackCount: number | null): OwnedState {
  const entry = findLibraryAlbum(ref, artist, title)
  if (!entry) return 'none'
  if (trackCount && entry.trackCount < trackCount) return 'partial'
  return 'complete'
}

export function findLibraryTrack(artist: string, title: string, isrc?: string | null): number | null {
  if (isrc) {
    const id = tracksByIsrc.get(isrc.toUpperCase())
    if (id) return id
  }
  return tracksByKey.get(`${normalize(artist)}\u0000${normalize(stripExtras(title))}`) ?? null
}
