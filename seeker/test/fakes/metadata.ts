import http from 'node:http'
import type { AddressInfo } from 'node:net'

// One local server standing in for the Deezer API (/deezer), Deezer's image CDN (/deezer-cdn),
// MusicBrainz (/musicbrainz) and the Cover Art Archive (/coverart).
// MusicBrainz knows no releases and the Cover Art Archive has no images, so enrichment finds nothing.

export interface FakeTrack {
  id: number
  title: string
  duration: number
  track: number
  disc?: number
  isrc?: string
}

export interface FakeAlbum {
  id: number
  title: string
  artist: { id: number; name: string }
  releaseDate: string
  tracks: FakeTrack[]
  label?: string
  genres?: string[]
  // Served at the album's cover URL; without it the cover returns 404.
  cover?: Buffer
}

type Send = (status: number, payload: unknown, contentType?: string) => void

const NO_DATA = { error: { type: 'DataException', message: 'no data', code: 800 } }

export class FakeMetadata {
  url = ''
  readonly albums = new Map<number, FakeAlbum>()
  readonly requests: { method: string; path: string; status: number }[] = []
  #server: http.Server

  constructor() {
    this.#server = http.createServer((req, res) => this.#handle(req, res))
  }

  get deezerUrl() {
    return `${this.url}/deezer`
  }

  get musicbrainzUrl() {
    return `${this.url}/musicbrainz`
  }

  get coverArtUrl() {
    return `${this.url}/coverart`
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(0, '127.0.0.1', () => resolve())
    })
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
    return this
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  addAlbum(album: FakeAlbum) {
    this.albums.set(album.id, album)
  }

  requestsTo(service: 'deezer' | 'deezer-cdn' | 'musicbrainz' | 'coverart') {
    return this.requests.filter((request) => request.path.startsWith(`/${service}/`))
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake-metadata')
    const send: Send = (status, payload, contentType = 'application/json') => {
      this.requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, status })
      res.writeHead(status, { 'Content-Type': contentType })
      res.end(Buffer.isBuffer(payload) ? payload : JSON.stringify(payload))
    }
    req.resume()
    const [service, ...rest] = url.pathname.split('/').filter(Boolean)
    if (req.method !== 'GET') return send(405, { error: 'Method not allowed' })
    if (service === 'deezer') return this.#deezer(rest, send)
    if (service === 'deezer-cdn') return this.#cover(rest, send)
    if (service === 'musicbrainz') return this.#musicbrainz(rest, send)
    return send(404, { error: 'Not found' })
  }

  // ---------- Deezer ----------

  #coverUrl(album: FakeAlbum) {
    return `${this.url}/deezer-cdn/images/cover/${album.id}/1000x1000-000000-80-0-0.jpg`
  }

  #trackJson(album: FakeAlbum, track: FakeTrack, withAlbum: boolean) {
    return {
      id: track.id,
      readable: true,
      title: track.title,
      title_short: track.title,
      title_version: '',
      isrc: track.isrc,
      duration: track.duration,
      track_position: track.track,
      disk_number: track.disc ?? 1,
      explicit_lyrics: false,
      artist: { id: album.artist.id, name: album.artist.name, type: 'artist' },
      ...(withAlbum
        ? { album: { id: album.id, title: album.title, cover_xl: this.#coverUrl(album), release_date: album.releaseDate, type: 'album' } }
        : {}),
      type: 'track',
    }
  }

  #albumJson(album: FakeAlbum) {
    const cover = this.#coverUrl(album)
    return {
      id: album.id,
      title: album.title,
      cover_small: cover.replace('1000x1000', '56x56'),
      cover_medium: cover.replace('1000x1000', '250x250'),
      cover_big: cover.replace('1000x1000', '500x500'),
      cover_xl: cover,
      genres: { data: (album.genres ?? []).map((name, index) => ({ id: index + 1, name })) },
      label: album.label,
      nb_tracks: album.tracks.length,
      duration: album.tracks.reduce((sum, track) => sum + track.duration, 0),
      release_date: album.releaseDate,
      record_type: 'album',
      explicit_lyrics: false,
      artist: { id: album.artist.id, name: album.artist.name, type: 'artist' },
      tracks: { data: album.tracks.map((track) => this.#trackJson(album, track, false)) },
      type: 'album',
    }
  }

  #deezer([kind, id, sub]: string[], send: Send) {
    // Deezer reports unknown ids with HTTP 200 and an error body.
    if (kind === 'search') return send(200, { data: [], total: 0 })
    if (kind === 'album' && id) {
      const album = this.albums.get(Number(id))
      if (!album) return send(200, NO_DATA)
      if (!sub) return send(200, this.#albumJson(album))
      if (sub === 'tracks') {
        return send(200, { data: album.tracks.map((track) => this.#trackJson(album, track, false)), total: album.tracks.length })
      }
    }
    if (kind === 'track' && id && !sub) {
      for (const album of this.albums.values()) {
        const track = album.tracks.find((item) => item.id === Number(id))
        if (track) return send(200, this.#trackJson(album, track, true))
      }
    }
    return send(200, NO_DATA)
  }

  #cover([images, cover, albumId]: string[], send: Send) {
    const album = images === 'images' && cover === 'cover' ? this.albums.get(Number(albumId)) : undefined
    if (!album?.cover) return send(404, { error: 'Not found' })
    return send(200, album.cover, 'image/jpeg')
  }

  // ---------- MusicBrainz ----------

  #musicbrainz([kind, id]: string[], send: Send) {
    if (kind === 'release' && !id) return send(200, { created: new Date().toISOString(), count: 0, offset: 0, releases: [] })
    return send(404, { error: 'Not Found', help: 'For usage, please see: https://musicbrainz.org/development/mmd' })
  }
}
