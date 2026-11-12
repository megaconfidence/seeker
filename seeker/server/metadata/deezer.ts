import { config } from '../config.ts'
import { logger } from '../log.ts'
import { RateLimiter, sleep, TtlCache } from '../util.ts'

const log = logger('deezer')
const BASE = config.deezerUrl

// Deezer allows 50 requests per 5 seconds per IP.
const limiter = new RateLimiter(40, 5000)
const cache = new TtlCache<unknown>(2000)

export interface DzArtist {
  id: number
  name: string
  picture_small?: string
  picture_medium?: string
  picture_big?: string
  picture_xl?: string
  nb_album?: number
  nb_fan?: number
}

export interface DzTrack {
  id: number
  title: string
  title_short?: string
  title_version?: string
  duration: number
  track_position?: number
  disk_number?: number
  isrc?: string
  explicit_lyrics?: boolean
  artist: DzArtist
  album?: DzAlbum
  contributors?: DzArtist[]
  release_date?: string
}

export interface DzAlbum {
  id: number
  title: string
  cover_small?: string
  cover_medium?: string
  cover_big?: string
  cover_xl?: string
  release_date?: string
  record_type?: string
  nb_tracks?: number
  explicit_lyrics?: boolean
  artist?: DzArtist
  upc?: string
  label?: string
  duration?: number
  genres?: { data: { id: number; name: string }[] }
  contributors?: DzArtist[]
  tracks?: { data: DzTrack[] }
}

interface DzError {
  error?: { type?: string; message?: string; code?: number }
}

interface DzPage<T> {
  data: T[]
  total?: number
  next?: string
}

export class DeezerError extends Error {
  code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

async function request<T>(path: string, ttlMs: number): Promise<T> {
  const cached = cache.get(path)
  if (cached !== undefined) return cached as T

  for (let attempt = 0; ; attempt++) {
    await limiter.wait()
    const response = await fetch(BASE + path, {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      if (response.status >= 500 && attempt < 2) {
        await sleep(1000 * (attempt + 1))
        continue
      }
      throw new DeezerError(`Deezer returned HTTP ${response.status}`)
    }
    const body = (await response.json()) as T & DzError
    if (body.error) {
      // Code 4 means the quota was exceeded; back off and try again.
      if (body.error.code === 4 && attempt < 3) {
        log.warn('Deezer rate limit hit, backing off')
        await sleep(2000 * (attempt + 1))
        continue
      }
      throw new DeezerError(body.error.message || 'Deezer error', body.error.code)
    }
    cache.set(path, body, ttlMs)
    return body
  }
}

async function paged<T>(path: string, ttlMs: number, max = 1000): Promise<T[]> {
  const items: T[] = []
  let index = 0
  const separator = path.includes('?') ? '&' : '?'
  while (items.length < max) {
    const page = await request<DzPage<T>>(`${path}${separator}limit=100&index=${index}`, ttlMs)
    items.push(...page.data)
    if (!page.next || page.data.length === 0) break
    index += page.data.length
  }
  return items
}

const HOUR = 3600_000
const q = (value: string) => encodeURIComponent(value)

export const deezer = {
  searchArtists: (query: string, limit = 8) =>
    request<DzPage<DzArtist>>(`/search/artist?q=${q(query)}&limit=${limit}`, 10 * 60_000).then((page) => page.data),
  searchAlbums: (query: string, limit = 24) =>
    request<DzPage<DzAlbum>>(`/search/album?q=${q(query)}&limit=${limit}`, 10 * 60_000).then((page) => page.data),
  searchTracks: (query: string, limit = 20) =>
    request<DzPage<DzTrack>>(`/search/track?q=${q(query)}&limit=${limit}`, 10 * 60_000).then((page) => page.data),
  artist: (id: number) => request<DzArtist>(`/artist/${id}`, 6 * HOUR),
  artistAlbums: (id: number, fresh = false) => paged<DzAlbum>(`/artist/${id}/albums`, fresh ? 60_000 : HOUR, 500),
  artistTop: (id: number, limit = 10) =>
    request<DzPage<DzTrack>>(`/artist/${id}/top?limit=${limit}`, 6 * HOUR).then((page) => page.data),
  album: (id: number) => request<DzAlbum>(`/album/${id}`, 6 * HOUR),
  albumTracks: (id: number) => paged<DzTrack>(`/album/${id}/tracks`, 6 * HOUR, 500),
  track: (id: number) => request<DzTrack & { preview?: string }>(`/track/${id}`, 6 * HOUR),
  // Preview links carry an expiring token, so these are cached briefly.
  previewUrl: async (id: number) => (await request<DzTrack & { preview?: string }>(`/track/${id}?fresh=1`, 5 * 60_000)).preview ?? null,
}
