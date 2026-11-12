import type {
  CatalogAlbum,
  CatalogAlbumPage,
  CatalogArtist,
  CatalogArtistPage,
  CatalogSearchResult,
  CatalogTrack,
  JobRef,
  JobTarget,
  MatchCandidate,
  MatchPreview,
  OwnedState,
  RecordType,
  TargetTrack,
} from '../shared/types.ts'
import { all } from './db.ts'
import { jobRefs } from './jobs/store.ts'
import { albumOwned, findLibraryAlbum, findLibraryTrack, ownedTrackIds } from './library/owned.ts'
import { cleanTitles, normalize, similarity } from './match/normalize.ts'
import { deezer, type DzAlbum, type DzArtist, type DzTrack } from './metadata/deezer.ts'
import { coverArtUrl, getRelease, searchReleases, type MbAlbumSummary, type MbRelease } from './metadata/musicbrainz.ts'
import { yearOf } from './util.ts'

function recordType(value: string | undefined, secondary: string[] = []): RecordType {
  if (secondary.some((type) => /compilation/i.test(type))) return 'compile'
  const lower = value?.toLowerCase()
  return lower === 'ep' || lower === 'single' || lower === 'compile' ? lower : 'album'
}

function watchedIds(): Set<number> {
  return new Set(all<{ deezer_id: number }>('SELECT deezer_id FROM watch_artists').map((row) => row.deezer_id))
}

function mapArtist(artist: DzArtist, watched: Set<number>): CatalogArtist {
  return {
    id: artist.id,
    name: artist.name,
    picture: artist.picture_big ?? artist.picture_medium ?? null,
    fans: artist.nb_fan,
    albums: artist.nb_album,
    watched: watched.has(artist.id),
  }
}

function mapAlbum(album: DzAlbum, refs: Map<number, JobRef>, fallbackArtist?: DzArtist): CatalogAlbum {
  const artist = album.artist ?? fallbackArtist
  const artistName = artist?.name ?? ''
  return {
    id: album.id,
    mbid: null,
    source: 'deezer',
    title: album.title,
    artist: artistName,
    artistId: artist?.id ?? 0,
    cover: album.cover_xl ?? album.cover_big ?? null,
    coverSmall: album.cover_medium ?? album.cover_small ?? null,
    year: yearOf(album.release_date),
    releaseDate: album.release_date ?? null,
    type: recordType(album.record_type),
    tracks: album.nb_tracks ?? null,
    explicit: !!album.explicit_lyrics,
    owned: albumOwned(album.id, artistName, album.title, album.nb_tracks ?? null),
    job: refs.get(album.id) ?? null,
  }
}

function mapTrack(
  track: DzTrack,
  refs: Map<number, JobRef>,
  album?: DzAlbum,
  title = track.title,
  owned?: number | null,
): CatalogTrack {
  const albumInfo = track.album ?? album
  const libraryTrackId = owned !== undefined ? owned : findLibraryTrack(track.artist.name, title, track.isrc)
  return {
    id: track.id,
    title,
    artist: track.artist.name,
    artistId: track.artist.id,
    album: albumInfo?.title ?? '',
    albumId: albumInfo?.id ?? 0,
    cover: albumInfo?.cover_medium ?? albumInfo?.cover_small ?? null,
    duration: track.duration,
    explicit: !!track.explicit_lyrics,
    disc: track.disk_number ?? null,
    track: track.track_position ?? null,
    owned: libraryTrackId !== null,
    libraryTrackId,
    job: refs.get(track.id) ?? null,
  }
}

export async function searchCatalog(query: string): Promise<CatalogSearchResult> {
  const [artists, albums, tracks] = await Promise.all([
    deezer.searchArtists(query, 6),
    deezer.searchAlbums(query, 24),
    deezer.searchTracks(query, 20),
  ])
  const refs = jobRefs()
  const watched = watchedIds()
  return {
    artists: artists.map((artist) => mapArtist(artist, watched)),
    albums: albums.map((album) => mapAlbum(album, refs.albums)),
    tracks: tracks.map((track) => mapTrack(track, refs.tracks)),
  }
}

// Search results don't include release dates; the UI asks for them afterwards.
export async function albumYears(ids: number[]): Promise<Record<number, number | null>> {
  const out: Record<number, number | null> = {}
  await Promise.all(
    ids.slice(0, 24).map(async (id) => {
      try {
        out[id] = yearOf((await deezer.album(id)).release_date)
      } catch {
        out[id] = null
      }
    }),
  )
  return out
}

export async function artistPage(id: number): Promise<CatalogArtistPage> {
  const [artist, top, albums] = await Promise.all([deezer.artist(id), deezer.artistTop(id, 10), deezer.artistAlbums(id)])
  const refs = jobRefs()
  // Deezer lists the same release several times (explicit/clean, regional copies); keep one of each.
  const seen = new Map<string, DzAlbum>()
  for (const album of albums) {
    const key = `${normalize(album.title)}|${album.record_type}`
    const existing = seen.get(key)
    if (!existing || (album.explicit_lyrics && !existing.explicit_lyrics)) seen.set(key, album)
  }
  const unique = [...seen.values()].sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))
  return {
    artist: mapArtist(artist, watchedIds()),
    top: top.map((track) => mapTrack(track, refs.tracks)),
    albums: unique.map((album) => mapAlbum(album, refs.albums, artist)),
  }
}

function sortTracks(tracks: DzTrack[]): DzTrack[] {
  return [...tracks].sort(
    (a, b) => (a.disk_number ?? 1) - (b.disk_number ?? 1) || (a.track_position ?? 0) - (b.track_position ?? 0),
  )
}

export async function albumPage(id: number): Promise<CatalogAlbumPage> {
  const [album, tracks] = await Promise.all([deezer.album(id), deezer.albumTracks(id)])
  const refs = jobRefs()
  const mapped = mapAlbum({ ...album, nb_tracks: album.nb_tracks ?? tracks.length }, refs.albums)
  const library = findLibraryAlbum(album.id, album.artist?.name ?? '', album.title)
  const sorted = sortTracks(tracks)
  const titles = cleanTitles(sorted.map((track, index) => ({ title: track.title, track: track.track_position ?? index + 1 })))
  const owned = ownedTrackIds(
    sorted.map((track, index) => ({
      artist: track.artist.name,
      title: titles[index]!.title,
      isrc: track.isrc,
      disc: track.disk_number ?? 1,
      track: track.track_position ?? index + 1,
    })),
    library?.id ?? null,
  )
  return {
    album: {
      ...mapped,
      label: album.label ?? null,
      genres: album.genres?.data.map((genre) => genre.name) ?? [],
      duration: album.duration ?? tracks.reduce((sum, track) => sum + track.duration, 0),
    },
    tracks: sorted.map((track, index) => mapTrack(track, refs.tracks, album, titles[index]!.title, owned[index] ?? null)),
    libraryAlbumId: library?.id ?? null,
  }
}

export async function buildAlbumTarget(albumId: number): Promise<JobTarget> {
  const [album, tracks] = await Promise.all([deezer.album(albumId), deezer.albumTracks(albumId)])
  const sorted = sortTracks(tracks)
  const artist = album.artist?.name ?? sorted[0]?.artist.name ?? 'Unknown Artist'
  const targetTracks: TargetTrack[] = sorted.map((track, index) => ({
    index,
    title: track.title,
    artist: track.artist?.name ?? artist,
    disc: track.disk_number ?? 1,
    track: track.track_position ?? index + 1,
    duration: track.duration,
    isrc: track.isrc,
    deezerId: track.id,
  }))
  return {
    album: {
      title: album.title,
      artist,
      year: yearOf(album.release_date) ?? undefined,
      releaseDate: album.release_date,
      label: album.label,
      genres: album.genres?.data.map((genre) => genre.name) ?? [],
      upc: album.upc,
      recordType: album.record_type,
      trackCount: sorted.length,
      discCount: Math.max(1, ...sorted.map((track) => track.disk_number ?? 1)),
      coverUrl: album.cover_xl ?? album.cover_big,
      deezerId: album.id,
      deezerArtistId: album.artist?.id,
      compilation: album.record_type === 'compile' || /^various artists$/i.test(artist),
    },
    tracks: cleanTitles(targetTracks),
  }
}

// ---------- MusicBrainz fallback ----------

function mbOwned(release: { releaseId: string; artist: string; title: string; trackCount: number | null }): OwnedState {
  return albumOwned(release.releaseId, release.artist, release.title, release.trackCount)
}

function mapMbSummary(summary: MbAlbumSummary, refs: Map<string, JobRef>): CatalogAlbum {
  return {
    id: 0,
    mbid: summary.releaseId,
    source: 'musicbrainz',
    title: summary.title,
    artist: summary.artist,
    artistId: 0,
    cover: coverArtUrl(summary.releaseId, 500, summary.releaseGroupId),
    coverSmall: coverArtUrl(summary.releaseId, 250, summary.releaseGroupId),
    year: summary.year,
    releaseDate: null,
    type: recordType(summary.type, summary.secondaryTypes),
    tracks: summary.trackCount,
    explicit: false,
    owned: mbOwned(summary),
    job: refs.get(summary.releaseId) ?? null,
  }
}

export async function searchMusicBrainz(query: string): Promise<CatalogAlbum[]> {
  const refs = jobRefs()
  return (await searchReleases(query, 12)).map((summary) => mapMbSummary(summary, refs.mbAlbums))
}

export async function mbAlbumPage(mbid: string): Promise<CatalogAlbumPage> {
  const release = await getRelease(mbid)
  const refs = jobRefs()
  const tracks = cleanTitles(release.tracks.map((track) => ({ ...track, track: track.position })))
  const duration = tracks.reduce((sum, track) => sum + (track.length ?? 0) / 1000, 0)
  const year = yearOf(release.originalDate ?? release.date)
  const library = findLibraryAlbum(mbid, release.artist, release.title)
  const owned = ownedTrackIds(
    tracks.map((track) => ({ artist: track.artist, title: track.title, isrc: track.isrcs[0], disc: track.disc, track: track.position })),
    library?.id ?? null,
  )
  return {
    album: {
      id: 0,
      mbid,
      source: 'musicbrainz',
      title: release.title,
      artist: release.artist,
      artistId: 0,
      cover: coverArtUrl(mbid, 500, release.releaseGroupId),
      coverSmall: coverArtUrl(mbid, 250, release.releaseGroupId),
      year,
      releaseDate: release.date,
      type: recordType(release.primaryType ?? undefined, release.secondaryTypes),
      tracks: tracks.length,
      explicit: false,
      owned: albumOwned(mbid, release.artist, release.title, tracks.length),
      job: refs.mbAlbums.get(mbid) ?? null,
      label: release.label,
      genres: [],
      duration,
    },
    tracks: tracks.map((track, index) => {
      const libraryTrackId = owned[index] ?? null
      return {
        id: 0,
        title: track.title,
        artist: track.artist,
        artistId: 0,
        album: release.title,
        albumId: 0,
        cover: coverArtUrl(mbid, 250, release.releaseGroupId),
        duration: (track.length ?? 0) / 1000,
        explicit: false,
        disc: track.disc,
        track: track.position,
        owned: libraryTrackId !== null,
        libraryTrackId,
        job: null,
      }
    }),
    libraryAlbumId: library?.id ?? null,
  }
}

export function targetFromRelease(release: MbRelease): JobTarget {
  const year = yearOf(release.date) ?? undefined
  const original = yearOf(release.originalDate) ?? undefined
  const tracks: TargetTrack[] = release.tracks.map((track, index) => ({
    index,
    title: track.title,
    artist: track.artist,
    disc: track.disc,
    track: track.position,
    duration: Math.round((track.length ?? 0) / 1000),
    isrc: track.isrcs[0],
    mbRecordingId: track.recordingId,
    mbTrackId: track.id,
    mbArtistId: track.artistId ?? undefined,
  }))
  return {
    album: {
      title: release.title,
      artist: release.artist,
      year,
      originalYear: original,
      releaseDate: release.date ?? undefined,
      label: release.label ?? undefined,
      genres: [],
      upc: release.barcode ?? undefined,
      recordType: recordType(release.primaryType ?? undefined, release.secondaryTypes),
      trackCount: tracks.length,
      discCount: Math.max(1, ...tracks.map((track) => track.disc)),
      coverUrl: coverArtUrl(release.id, 1200, release.releaseGroupId),
      mbReleaseId: release.id,
      mbReleaseGroupId: release.releaseGroupId ?? undefined,
      mbArtistId: release.artistId ?? undefined,
      mbChecked: true,
      compilation: release.secondaryTypes.some((type) => /compilation/i.test(type)) || /^various artists$/i.test(release.artist),
    },
    tracks: cleanTitles(tracks),
  }
}

export async function buildMbTarget(mbid: string): Promise<JobTarget> {
  return targetFromRelease(await getRelease(mbid))
}

// ---------- "Artist - Title" → a catalog album or track ----------

export type Resolved = MatchCandidate
export type Preview = MatchPreview

export class NotFoundError extends Error {
  suggestions: string[]
  constructor(message: string, suggestions: string[] = []) {
    super(message)
    this.suggestions = suggestions
  }
}

const DERIVATIVE = /\b(karaoke|tribute|cover|in the style of|made famous|instrumental version|8-bit|lullaby)\b/i
const MIN_CONFIDENCE = 0.55

function parseQuery(query: string) {
  const dash = query.split(/\s+[-–—]\s+/)
  const artist = dash.length > 1 ? dash[0]!.trim() : ''
  const title = dash.length > 1 ? dash.slice(1).join(' - ').trim() : query
  return { artist, title, text: artist ? `${artist} ${title}` : title }
}

async function candidates(query: string, kind: 'auto' | 'album' | 'track'): Promise<Resolved[]> {
  const trimmed = query.trim()
  const url = trimmed.match(/deezer\.com\/(?:[a-z]{2}\/)?(album|track)\/(\d+)/i)
  if (url) {
    const id = Number(url[2])
    if (url[1]!.toLowerCase() === 'album') {
      const album = await deezer.album(id)
      return [
        {
          kind: 'album',
          source: 'deezer',
          id,
          title: album.title,
          artist: album.artist?.name ?? '',
          cover: album.cover_xl ?? null,
          year: yearOf(album.release_date),
          recordType: recordType(album.record_type),
          tracks: album.nb_tracks ?? null,
          confidence: 1,
          owned: albumOwned(id, album.artist?.name ?? '', album.title, album.nb_tracks ?? null),
        },
      ]
    }
    const track = await deezer.track(id)
    return [
      {
        kind: 'track',
        source: 'deezer',
        id,
        title: track.title,
        artist: track.artist.name,
        album: track.album?.title,
        cover: track.album?.cover_xl ?? null,
        year: yearOf(track.release_date),
        duration: track.duration,
        confidence: 1,
        owned: findLibraryTrack(track.artist.name, track.title, track.isrc) ? 'complete' : 'none',
      },
    ]
  }

  const { artist, title, text } = parseQuery(trimmed)
  const wantsDerivative = DERIVATIVE.test(trimmed)
  const scoreItem = (itemTitle: string, itemArtist: string) => {
    const titleScore = similarity(title, itemTitle)
    const artistScore = artist ? similarity(artist, itemArtist) : 0.6
    let score = titleScore * 0.6 + artistScore * 0.4
    if (normalize(itemTitle) === normalize(title)) score += 0.08
    if (!wantsDerivative && DERIVATIVE.test(`${itemTitle} ${itemArtist}`)) score -= 0.4
    return Math.max(0, Math.min(1, score))
  }

  const [albums, tracks] = await Promise.all([
    kind === 'track' ? Promise.resolve([] as DzAlbum[]) : deezer.searchAlbums(text, 10),
    kind === 'album' ? Promise.resolve([] as DzTrack[]) : deezer.searchTracks(text, 10),
  ])
  const out: Resolved[] = [
    ...albums.map(
      (album): Resolved => ({
        kind: 'album',
        source: 'deezer',
        id: album.id,
        title: album.title,
        artist: album.artist?.name ?? '',
        cover: album.cover_xl ?? album.cover_big ?? null,
        year: null,
        recordType: recordType(album.record_type),
        tracks: album.nb_tracks ?? null,
        confidence: scoreItem(album.title, album.artist?.name ?? ''),
        owned: albumOwned(album.id, album.artist?.name ?? '', album.title, album.nb_tracks ?? null),
      }),
    ),
    ...tracks.map(
      (track): Resolved => ({
        kind: 'track',
        source: 'deezer',
        id: track.id,
        title: track.title,
        artist: track.artist.name,
        album: track.album?.title,
        albumId: track.album?.id,
        cover: track.album?.cover_xl ?? track.album?.cover_big ?? null,
        year: null,
        duration: track.duration,
        confidence: scoreItem(track.title, track.artist.name),
        owned: findLibraryTrack(track.artist.name, track.title, track.isrc) ? 'complete' : 'none',
      }),
    ),
  ]

  // Nothing convincing on Deezer: ask MusicBrainz for albums.
  if (kind !== 'track' && !out.some((item) => item.confidence >= MIN_CONFIDENCE)) {
    try {
      for (const summary of await searchReleases(trimmed, 6)) {
        out.push({
          kind: 'album',
          source: 'musicbrainz',
          id: 0,
          mbid: summary.releaseId,
          title: summary.title,
          artist: summary.artist,
          cover: coverArtUrl(summary.releaseId, 500, summary.releaseGroupId),
          year: summary.year,
          recordType: recordType(summary.type, summary.secondaryTypes),
          tracks: summary.trackCount,
          confidence: scoreItem(summary.title, summary.artist) - 0.02,
          owned: mbOwned(summary),
        })
      }
    } catch {
      // MusicBrainz is optional here
    }
  }
  return out
}

function choose(items: Resolved[], kind: 'auto' | 'album' | 'track'): Resolved | null {
  const albums = items.filter((item) => item.kind === 'album').sort((a, b) => b.confidence - a.confidence)
  const tracks = items.filter((item) => item.kind === 'track').sort((a, b) => b.confidence - a.confidence)
  const bestAlbum = albums[0] && albums[0].confidence >= MIN_CONFIDENCE ? albums[0] : null
  const bestTrack = tracks[0] && tracks[0].confidence >= MIN_CONFIDENCE ? tracks[0] : null
  if (kind === 'album') return bestAlbum
  if (kind === 'track') return bestTrack
  if (bestAlbum && (!bestTrack || (bestAlbum.recordType !== 'single' && bestAlbum.confidence >= bestTrack.confidence - 0.05))) {
    return bestAlbum
  }
  return bestTrack ?? bestAlbum
}

export async function previewQuery(query: string, kind: 'auto' | 'album' | 'track' = 'auto'): Promise<Preview> {
  const items = await candidates(query, kind)
  const best = choose(items, kind)
  if (best?.kind === 'album' && best.source === 'deezer' && best.year === null) {
    try {
      best.year = yearOf((await deezer.album(best.id)).release_date)
    } catch {
      // the year is only cosmetic
    }
  }
  const alternatives = items
    .filter((item) => item !== best && item.confidence >= 0.35)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
  return { best, alternatives }
}

export async function resolveQuery(query: string, kind: 'auto' | 'album' | 'track' = 'auto'): Promise<Resolved> {
  const items = await candidates(query, kind)
  const best = choose(items, kind)
  if (best) return best
  const suggestions = items
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map((item) => `${item.artist} - ${item.title}${item.kind === 'album' ? ' (album)' : ''}`)
  const what = kind === 'album' ? 'album' : kind === 'track' ? 'song' : 'album or song'
  throw new NotFoundError(`No ${what} matching "${query.trim()}"`, suggestions)
}
