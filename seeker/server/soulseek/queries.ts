import type { TargetAlbum, TargetTrack } from '../../shared/types.ts'
import { normalize, stripBrackets, stripExtras } from '../match/normalize.ts'
import { cleanArtist, cleanTitle } from './match.ts'

// Title-only searches reach every peer on the network; short ones flood home routers with connections.
const TITLE_ONLY_MIN_LENGTH = 12

function tidy(query: string): string {
  return query
    .replace(/[^\p{L}\p{N}'’&$\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function unique(queries: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const query of queries) {
    if (!query) continue
    const value = tidy(query)
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

export function albumQueries(album: TargetAlbum): string[] {
  const artist = cleanArtist(album.artist)
  const title = stripExtras(album.title)
  const isVarious = /^various( artists)?$/i.test(artist)
  if (normalize(artist) === normalize(title)) {
    return unique([album.year ? `${artist} ${album.year}` : null, title])
  }
  return unique([
    isVarious ? title : `${artist} ${title}`,
    stripBrackets(title) !== title ? `${artist} ${stripBrackets(title)}` : null,
    title.length >= TITLE_ONLY_MIN_LENGTH ? title : null,
  ]).slice(0, 3)
}

export function trackQueries(track: TargetTrack, album: TargetAlbum): string[] {
  const artist = cleanArtist(track.artist || album.artist)
  const title = cleanTitle(track.title)
  const stripped = stripExtras(title)
  const nonAscii = /[^\u0000-\u007f]/.test(`${track.artist}${track.title}`)
  return unique([
    nonAscii ? `${track.artist} ${track.title}` : null,
    `${artist} ${title}`,
    stripped !== title ? `${artist} ${stripped}` : null,
    title.length >= TITLE_ONLY_MIN_LENGTH ? title : null,
  ]).slice(0, 3)
}
