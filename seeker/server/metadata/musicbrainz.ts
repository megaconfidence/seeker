import { config } from '../config.ts'
import { logger } from '../log.ts'
import { similarity } from '../match/normalize.ts'
import { RateLimiter, sleep, TtlCache, yearOf } from '../util.ts'

const log = logger('musicbrainz')
const BASE = config.musicbrainzUrl
const USER_AGENT = `Seeker/${config.version} ( ${process.env.SEEKER_CONTACT || 'self-hosted slskd client'} )`

// MusicBrainz asks for at most one request per second.
const limiter = new RateLimiter(1, 1100)
const cache = new TtlCache<unknown>(500)

interface MbArtistCredit {
  name: string
  joinphrase?: string
  artist: { id: string; name: string }
}

interface MbSearchRelease {
  id: string
  title: string
  score?: number
  status?: string
  date?: string
  country?: string
  barcode?: string
  'track-count'?: number
  'artist-credit'?: MbArtistCredit[]
  'release-group'?: { id: string; 'primary-type'?: string; 'secondary-types'?: string[] }
  media?: { format?: string; 'track-count'?: number }[]
}

interface MbReleaseDetail {
  id: string
  title: string
  date?: string
  barcode?: string
  'artist-credit'?: MbArtistCredit[]
  'release-group'?: { id: string; 'primary-type'?: string; 'secondary-types'?: string[]; 'first-release-date'?: string }
  'label-info'?: { 'catalog-number'?: string; label?: { name: string } }[]
  media?: {
    position: number
    format?: string
    tracks?: {
      id: string
      number: string
      position: number
      title: string
      length?: number
      'artist-credit'?: MbArtistCredit[]
      recording: { id: string; title: string; length?: number; isrcs?: string[] }
    }[]
  }[]
}

export interface MbTrack {
  id: string
  recordingId: string
  title: string
  artist: string
  disc: number
  position: number
  length: number | null
  isrcs: string[]
  artistId: string | null
}

export interface MbRelease {
  id: string
  releaseGroupId: string | null
  artistId: string | null
  artist: string
  title: string
  date: string | null
  originalDate: string | null
  primaryType: string | null
  secondaryTypes: string[]
  label: string | null
  catalogNumber: string | null
  barcode: string | null
  tracks: MbTrack[]
}

export interface MbAlbumSummary {
  releaseId: string
  releaseGroupId: string | null
  title: string
  artist: string
  year: number | null
  trackCount: number | null
  type: string
  secondaryTypes: string[]
}

async function request<T>(path: string): Promise<T> {
  const cached = cache.get(path)
  if (cached !== undefined) return cached as T
  for (let attempt = 0; ; attempt++) {
    await limiter.wait()
    const response = await fetch(BASE + path, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if ((response.status === 503 || response.status === 429) && attempt < 3) {
      await sleep(2000 * (attempt + 1))
      continue
    }
    if (!response.ok) throw new Error(`MusicBrainz returned HTTP ${response.status}`)
    const body = (await response.json()) as T & { error?: string }
    // MusicBrainz sometimes answers 200 with a "busy, try again" error body.
    if (body.error && /busy|try again/i.test(body.error) && attempt < 3) {
      await sleep(2000 * (attempt + 1))
      continue
    }
    cache.set(path, body, 6 * 3600_000)
    return body
  }
}

function lucene(value: string): string {
  return value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1')
}

export function creditName(credits: MbArtistCredit[] | undefined): string {
  return (credits ?? []).map((credit) => credit.name + (credit.joinphrase ?? '')).join('')
}

// Individual releases often have no art while their release group does, so prefer the group's.
export const coverArtUrl = (releaseId: string, size: 250 | 500 | 1200 = 500, releaseGroupId?: string | null) =>
  releaseGroupId
    ? `${config.coverArtUrl}/release-group/${releaseGroupId}/front-${size}`
    : `${config.coverArtUrl}/release/${releaseId}/front-${size}`

function pick(
  releases: MbSearchRelease[],
  want: { title: string; artist: string; trackCount: number },
): MbSearchRelease | undefined {
  let best: { release: MbSearchRelease; score: number } | undefined
  for (const release of releases) {
    const count = release['track-count'] ?? release.media?.reduce((sum, m) => sum + (m['track-count'] ?? 0), 0) ?? 0
    if (count !== want.trackCount) continue
    const titleScore = similarity(release.title, want.title)
    const artistScore = similarity(creditName(release['artist-credit']), want.artist)
    if (titleScore < 0.5 || artistScore < 0.5) continue
    let score = titleScore * 2 + artistScore + (release.score ?? 0) / 100
    if (release.status === 'Official') score += 0.3
    if (release.media?.some((m) => m.format === 'Digital Media')) score += 0.2
    if (!best || score > best.score) best = { release, score }
  }
  return best?.release
}

export async function findRelease(want: {
  upc?: string
  title: string
  artist: string
  trackCount: number
}): Promise<MbRelease | null> {
  try {
    let candidate: MbSearchRelease | undefined
    if (want.upc) {
      const barcode = want.upc.replace(/^0+/, '')
      const query = `barcode:${barcode} OR barcode:0${barcode} OR barcode:00${barcode}`
      const found = await request<{ releases: MbSearchRelease[] }>(
        `/release?query=${encodeURIComponent(query)}&fmt=json&limit=10`,
      )
      candidate = pick(found.releases, want)
    }
    if (!candidate) {
      const query = `release:"${lucene(want.title)}" AND artist:"${lucene(want.artist)}" AND tracks:${want.trackCount}`
      const found = await request<{ releases: MbSearchRelease[] }>(
        `/release?query=${encodeURIComponent(query)}&fmt=json&limit=15`,
      )
      candidate = pick(found.releases, want)
    }
    if (!candidate) return null
    return await getRelease(candidate.id)
  } catch (error) {
    log.warn(`Lookup failed for ${want.artist} - ${want.title}`, error)
    return null
  }
}

export async function getRelease(id: string): Promise<MbRelease> {
  const detail = await request<MbReleaseDetail>(
    `/release/${id}?inc=recordings+artist-credits+release-groups+labels+isrcs&fmt=json`,
  )
  const label = detail['label-info']?.find((info) => info.label?.name && !/^\[no label\]$/i.test(info.label.name))
  const group = detail['release-group']
  const artist = creditName(detail['artist-credit']) || 'Unknown Artist'
  return {
    id: detail.id,
    releaseGroupId: group?.id ?? null,
    artistId: detail['artist-credit']?.[0]?.artist.id ?? null,
    artist,
    title: detail.title,
    date: detail.date ?? null,
    originalDate: group?.['first-release-date'] ?? null,
    primaryType: group?.['primary-type'] ?? null,
    secondaryTypes: group?.['secondary-types'] ?? [],
    label: label?.label?.name ?? null,
    catalogNumber: label?.['catalog-number'] && label['catalog-number'] !== '[none]' ? label['catalog-number'] : null,
    barcode: detail.barcode || null,
    tracks: (detail.media ?? []).flatMap((medium) =>
      (medium.tracks ?? []).map((track) => ({
        id: track.id,
        recordingId: track.recording.id,
        title: track.title,
        artist: creditName(track['artist-credit']) || artist,
        disc: medium.position,
        position: track.position,
        length: track.length ?? track.recording.length ?? null,
        isrcs: track.recording.isrcs ?? [],
        artistId: track['artist-credit']?.[0]?.artist.id ?? null,
      })),
    ),
  }
}

// Search releases and collapse them to one entry per release group (album).
export async function searchReleases(query: string, limit = 12): Promise<MbAlbumSummary[]> {
  const dash = query.split(/\s+[-–—]\s+/)
  const lucQuery =
    dash.length > 1
      ? `release:(${lucene(dash.slice(1).join(' '))}) AND artist:(${lucene(dash[0]!)})`
      : `release:(${lucene(query)}) OR artist:(${lucene(query)})`
  const found = await request<{ releases: MbSearchRelease[] }>(
    `/release?query=${encodeURIComponent(lucQuery)}&fmt=json&limit=50`,
  )
  const groups = new Map<string, MbSearchRelease[]>()
  for (const release of found.releases ?? []) {
    const key = release['release-group']?.id ?? release.id
    groups.set(key, [...(groups.get(key) ?? []), release])
  }
  const summaries: MbAlbumSummary[] = []
  for (const releases of groups.values()) {
    const ranked = [...releases].sort((a, b) => {
      const official = Number(b.status === 'Official') - Number(a.status === 'Official')
      if (official) return official
      const digital = Number(!!b.media?.some((m) => m.format === 'Digital Media')) - Number(!!a.media?.some((m) => m.format === 'Digital Media'))
      if (digital) return digital
      return (a.date ?? '9999').localeCompare(b.date ?? '9999')
    })
    const release = ranked[0]!
    const dates = releases.map((item) => item.date).filter((date): date is string => !!date).sort()
    summaries.push({
      releaseId: release.id,
      releaseGroupId: release['release-group']?.id ?? null,
      title: release.title,
      artist: creditName(release['artist-credit']),
      year: yearOf(dates[0]),
      trackCount: release['track-count'] ?? release.media?.reduce((sum, m) => sum + (m['track-count'] ?? 0), 0) ?? null,
      type: (release['release-group']?.['primary-type'] ?? 'Album').toLowerCase(),
      secondaryTypes: release['release-group']?.['secondary-types'] ?? [],
    })
    if (summaries.length >= limit) break
  }
  return summaries
}
