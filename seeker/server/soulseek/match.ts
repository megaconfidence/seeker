import { dice, normalize, similarity, stripExtras, tokens } from '../match/normalize.ts'
import type { Candidate } from './files.ts'

// ---------- titles ----------

export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([](explicit|clean|explicit version|clean version)[)\]]/gi, '')
    .replace(/\s*[([]\s*(feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .trim()
}

export function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .trim()
}

// A comparison key for titles: drops remaster tags, feat. credits, explicit/clean markers and "version".
export function titleKey(title: string): string {
  return normalize(
    cleanTitle(title)
      .replace(/\s*[([][^)\]]*\b(remaster(ed)?|original (mix|version)|album version|mono|stereo)\b[^)\]]*[)\]]/gi, '')
      .replace(/\s+-\s+[^-]*\b(remaster(ed)?|album version|mono|stereo)\b[^-]*$/i, ''),
  )
    .replace(/\b(version|ver)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const TECH_TAGS =
  /[([{]\s*(flac|mp3|aac|m4a|alac|ogg|opus|wav|lossless|web|cd|vinyl|\d{2,4}\s?kbps|v0|v2|320|24\s?bit|16\s?bit|24-\d+|16-44|hi-?res|\d{2,3}(\.\d)?\s?khz)[^)\]}]*[)\]}]/gi

export interface ParsedName {
  track: number | null
  disc: number | null
  titles: string[]
}

// Turn a Soulseek basename into its track/disc number and plausible titles.
export function parseName(stem: string, context: { artist?: string; album?: string; folderDisc?: number | null }): ParsedName {
  let rest = stem
    .replace(/_\d{15,}$/, '')
    .replace(/[-_][0-9a-f]{8}$/i, '')
    .replace(TECH_TAGS, '')
    .replace(/_/g, ' ')
    .trim()
  let track: number | null = null
  let disc: number | null = context.folderDisc ?? null

  const patterns: [RegExp, (m: RegExpMatchArray) => void][] = [
    [/^(\d)[-.](\d{1,2})(?=[\s.\-)])[\s.\-)]*/, (m) => ((disc = Number(m[1])), (track = Number(m[2])))],
    [/^[([](\d{1,3})[)\]]\s*[-.]?\s*/, (m) => (track = Number(m[1]))],
    [/^track\s*(\d{1,3})\s*[-._:]?\s*/i, (m) => (track = Number(m[1]))],
    [/^([A-H])(\d{1,2})(?=[\s.\-])[\s.\-]+/, (m) => (track = Number(m[2]))],
    [/^(\d{1,3})\s*[-.)_:]\s*/, (m) => (track = Number(m[1]))],
    [/^(\d{1,3})\s+(?=\S)/, (m) => (track = Number(m[1]))],
  ]
  const original = rest
  for (const [pattern, apply] of patterns) {
    const match = rest.match(pattern)
    if (match) {
      apply(match)
      rest = rest.slice(match[0].length).trim()
      break
    }
  }
  if (track !== null && track > 99 && disc === null && String(track).length === 3) {
    disc = Math.floor(track / 100)
    track = track % 100
  }

  const titles = new Set<string>()
  const add = (value: string) => {
    const trimmed = value.replace(/^[\s\-–.]+|[\s\-–.]+$/g, '').trim()
    if (trimmed) titles.add(trimmed)
  }
  add(rest)
  if (track !== null) add(original)
  // "05 5 Ghosts I" or "01 - 1 Ghosts I": the title repeats the track number.
  const repeated = rest.match(/^0*(\d{1,3})\s+(?=\S)/)
  if (track !== null && repeated && Number(repeated[1]) === track) add(rest.slice(repeated[0].length))

  const artistNorm = context.artist ? normalize(context.artist) : ''
  const albumNorm = context.album ? normalize(stripExtras(context.album)) : ''
  const parts = rest.split(/\s+[-–]\s+/)
  if (parts.length > 1) {
    add(parts[parts.length - 1]!)
    const filtered = parts.filter((part) => {
      const n = normalize(part)
      return n !== artistNorm && n !== albumNorm && !/^\d{1,3}$/.test(part.trim())
    })
    if (filtered.length) add(filtered.join(' - '))
    // "Artist - 03 - Title" or "Album - 03 - Title"
    const numbered = parts.findIndex((part) => /^\d{1,3}$/.test(part.trim()))
    if (numbered >= 0 && numbered < parts.length - 1) {
      if (track === null) track = Number(parts[numbered])
      add(parts.slice(numbered + 1).join(' - '))
    }
  }
  if (artistNorm) {
    const lowered = normalize(rest)
    if (lowered.startsWith(`${artistNorm} `)) {
      const words = rest.split(/\s+/)
      add(words.slice(context.artist!.split(/\s+/).length).join(' '))
    }
  }
  return { track, disc, titles: [...titles] }
}

// ---------- versions ----------

export type Version =
  | 'live'
  | 'remix'
  | 'acoustic'
  | 'instrumental'
  | 'tempo'
  | 'radio'
  | 'demo'
  | 'extended'
  | 'clean'
  | 'cover'

const VERSION_WORDS: [Version, RegExp][] = [
  ['radio', /\b(radio|single|short|7"?) (edit|version|mix|cut)\b/],
  ['tempo', /\b(slowed|sped up|speed up|nightcore|daycore|reverb(ed)?)\b/],
  ['instrumental', /\b(instrumental|karaoke|minus one|backing track|off vocal|acapella|a cappella)\b/],
  ['acoustic', /\b(acoustic|unplugged|stripped)\b/],
  ['live', /\b(live|concert|in concert|live session|bbc session)\b/],
  ['remix', /\b(remix|rmx|rework|bootleg|mashup|vip|dub mix|club mix|extended mix|\w+ mix|edit)\b/],
  ['demo', /\b(demo|rough mix|unreleased)\b/],
  ['extended', /\b(extended|long version|full length version)\b/],
  ['clean', /\b(clean|censored|edited)\b/],
]

// Versions only count where they're written as qualifiers: inside brackets or after " - ".
// Parts that contain one of `exclude` (the wanted title, artist or album) are skipped, so a song
// called "Live Forever" isn't mistaken for a live recording.
export function detectVersions(text: string, exclude: string[] = []): Set<Version> {
  const found = new Set<Version>()
  const skip = exclude.map((value) => normalize(value)).filter(Boolean)
  const qualifying: string[] = []
  for (const match of text.matchAll(/[([{]([^)\]}]*)[)\]}]/g)) qualifying.push(match[1]!)
  const dash = text.replace(/[([{][^)\]}]*[)\]}]/g, ' ').split(/\s+[-–]\s+/)
  if (dash.length > 1) qualifying.push(...dash.slice(1))
  for (const raw of qualifying) {
    const normalized = normalize(raw)
    if (!normalized || skip.some((value) => ` ${normalized} `.includes(` ${value} `))) continue
    const part = raw.toLowerCase()
    if (/\boriginal (mix|version)\b/.test(part)) continue
    for (const [version, pattern] of VERSION_WORDS) {
      if (pattern.test(part)) {
        found.add(version)
        if (version === 'radio') break
      }
    }
  }
  if (found.has('radio')) found.delete('remix')
  return found
}

const COVER_WORDS = /\b(tribute|karaoke|made famous|in the style of|cover version|originally performed)\b/

const HARD_VERSIONS: Version[] = ['live', 'remix', 'acoustic', 'instrumental', 'tempo', 'cover']
const SOFT_PENALTY: Partial<Record<Version, number>> = { radio: 0.06, demo: 0.12, extended: 0.05, clean: 0.06 }

// ---------- track scoring ----------

export interface TrackWant {
  title: string
  artist: string
  album?: string
  duration?: number
  track?: number
  disc?: number
}

const JUNK_FOLDERS = new Set(['various artists', 'va', 'various', 'unknown artist', 'unknown album', 'various artist'])

export function wordsIn(needle: string[], haystack: string): boolean {
  if (needle.length === 0) return false
  const hay = new Set(normalize(haystack).split(' '))
  return needle.every((word) => hay.has(word))
}

// Artist words without a leading "The", so "The Beatles" matches "Beatles" and "Beatles, The".
export function artistTokens(artist: string): string[] {
  const words = tokens(cleanArtist(artist))
  return words.length > 1 && words[0] === 'the' ? words.slice(1) : words
}

const compact = (value: string) => normalize(value).replace(/\s+/g, '')

// Whole-word match, plus a squashed match for multi-word names ("AC/DC" in "ACDC - Back in Black").
// Single-word names need a whole word, so "Muse" doesn't match "Museum".
export function artistInText(artist: string, text: string): boolean {
  const words = artistTokens(artist)
  if (wordsIn(words, text)) return true
  if (words.length < 2) return false
  const needle = words.join('')
  return needle.length >= 4 && compact(text).includes(needle)
}

export function durationScore(expected: number | undefined, actual: number | null): number {
  if (!expected || !actual) return 0.5
  const delta = Math.abs(expected - actual)
  if (delta <= 5) return 1
  return Math.max(0, 1 - (delta / Math.max(expected, actual)) * 5)
}

export interface TrackScore {
  score: number
  reject?: string
  titleExact: boolean
}

export function scoreTrack(want: TrackWant, file: Candidate): TrackScore {
  const reject = (reason: string): TrackScore => ({ score: 0, reject: reason, titleExact: false })
  const artist = cleanArtist(want.artist)
  const wantsVarious = JUNK_FOLDERS.has(normalize(artist))
  const segments = file.segments
  const lastDir = segments[segments.length - 1] ?? ''

  if (!wantsVarious && segments.some((segment) => JUNK_FOLDERS.has(normalize(segment)))) return reject('various/unknown folder')

  const searchable = [...segments, file.stem]
  const artistInSegment = searchable.some((segment) => artistInText(artist, segment))
  const artistScore = artistInSegment ? 1 : Math.max(0, ...searchable.map((segment) => dice(artist, segment) * 0.7))

  const parsed = parseName(file.stem, { artist, album: want.album })
  const wantKey = titleKey(want.title)
  const titleExact = parsed.titles.some((title) => titleKey(title) === wantKey)
  let titleScore = titleExact ? 1 : Math.max(0, ...parsed.titles.map((title) => similarity(cleanTitle(title), cleanTitle(want.title))))
  const cleanWant = normalize(cleanTitle(want.title))
  if (!titleExact && cleanWant && ` ${normalize(file.stem)} `.includes(` ${cleanWant} `)) titleScore = Math.max(titleScore, 0.85)

  let albumBonus = 0
  if (want.album) {
    const album = stripExtras(want.album)
    const best = Math.max(0, ...segments.map((segment) => similarity(album, segment.replace(/^\d{4}\s*[-.]\s*/, ''))))
    albumBonus = best >= 0.85 ? 0.1 : best >= 0.6 ? 0.03 : 0
  }

  if (titleScore < 0.3) return reject('title does not match')
  if (artistScore < 0.25) return reject('artist does not match')
  if (!artistInSegment && !(titleExact && albumBonus >= 0.1)) return reject('artist not in path')

  if (want.duration && file.length) {
    const delta = Math.abs(want.duration - file.length)
    if (delta > Math.max(20, want.duration * 0.12)) return reject(`duration off by ${Math.round(delta)} s`)
  }

  const exclude = [cleanTitle(want.title), artist, ...(want.album ? [stripExtras(want.album)] : [])]
  const fileVersions = detectVersions(`${file.stem} (${lastDir})`, exclude)
  const wantVersions = detectVersions(`${want.title} ${want.album ? `(${want.album})` : ''}`)
  const pathText = normalize(file.filename)
  const wantText = normalize(`${want.title} ${want.artist} ${want.album ?? ''}`)
  const coverMatch = pathText.match(COVER_WORDS)
  if (coverMatch && !COVER_WORDS.test(wantText)) return reject('cover or karaoke version')
  let penalty = 0
  for (const version of fileVersions) {
    if (wantVersions.has(version)) continue
    if (HARD_VERSIONS.includes(version)) return reject(`${version} version`)
    penalty += SOFT_PENALTY[version] ?? 0
  }
  for (const version of wantVersions) {
    if (HARD_VERSIONS.includes(version) && !fileVersions.has(version) && version !== 'cover') penalty += 0.2
  }

  let score = 0.45 * titleScore + 0.4 * artistScore + 0.15 * durationScore(want.duration, file.length)
  if (cleanWant.length <= 5 && artistScore < 0.5) score *= 0.4
  score = Math.min(1, score + albumBonus) - penalty
  return { score, titleExact }
}

export const TRACK_THRESHOLD = 0.58
