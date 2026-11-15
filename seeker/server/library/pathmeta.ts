import path from 'node:path'
import { normalize } from '../match/normalize.ts'

// What a file's place in the music folder says about it, for files without tags (music copied in by
// hand): Artist/Album (2008)/CD 2/01 - Title.flac, "Artist - Album" folders (also under _Unsorted),
// and compilations whose file names carry the artist ("07 - Artist - Title").
export interface PathMetadata {
  albumArtist: string | null
  artist: string | null
  album: string | null
  title: string
  track: number | null
  disc: number | null
  year: number | null
}

const DISC_FOLDER = /^(?:cd|dis[ck])[\s._-]*(\d{1,2})\b/i
const VARIOUS = /^(?:various(?: artists)?|va|compilations?|soundtracks?)$/i
// Release details that downloaded folders end with: "[FLAC]", "(320)", "[24-96 WEB]".
const DETAILS =
  /\s*[([][^()[\]]*\b(?:flac|mp3|aac|alac|ogg|opus|wav|aiff|ape|wv|320|256|192|v0|v2|kbps|lossless|hi-?res|(?:16|24)[- ]?bit|\d{2}[-/ ]\d{2,3}(?:k(?:hz)?)?|web|vinyl)\b[^()[\]]*[)\]]\s*$/i
const LEADING_YEAR = /^(?:[([]((?:19|20)\d{2})[)\]]\s*|((?:19|20)\d{2})\s*[-–.]\s+)(.+)$/
const TRAILING_YEAR = /^(.+?)\s*(?:[([]((?:19|20)\d{2})[)\]]|\s[-–]\s((?:19|20)\d{2}))$/
// "1-01 Title", "2.05 - Title": a disc number, then a track number of at least two digits.
const DISC_TRACK = /^(\d)[-.](\d{2,3})(?:\s*[-–._)]\s*|\s+)(.+)$/
// "01 - Title", "1. Title", "01_Title", and "01 Title" (two digits or more, so "2 Become 1" stays a title).
const TRACK = /^(\d{1,3})\s*[-–._)]\s*(.+)$|^(\d{2,3})\s+(.+)$/

function clean(name: string): string {
  const spaced = name.includes(' ') ? name : name.replace(/_/g, ' ')
  return spaced.replace(/\s+/g, ' ').trim()
}

const same = (a: string, b: string) => normalize(a) === normalize(b)

function takeYear(text: string): { text: string; year: number | null } {
  const leading = LEADING_YEAR.exec(text)
  if (leading) return { text: leading[3]!.trim(), year: Number(leading[1] ?? leading[2]) }
  const trailing = TRAILING_YEAR.exec(text)
  if (trailing) return { text: trailing[1]!.trim(), year: Number(trailing[2] ?? trailing[3]) }
  return { text, year: null }
}

// Splits "Before - After" at the first spaced dash.
function splitDash(text: string): [string, string] | null {
  const at = text.indexOf(' - ')
  if (at <= 0) return null
  const before = text.slice(0, at).trim()
  const after = text.slice(at + 3).trim()
  return before && after ? [before, after] : null
}

export function metadataFromPath(file: string, root: string): PathMetadata {
  const relative = path.relative(root, file)
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
  const folders = inside ? relative.split(path.sep).slice(0, -1) : []
  let disc: number | null = null
  const discFolder = DISC_FOLDER.exec(folders.at(-1) ?? '')
  // A disc folder needs an album folder above it.
  if (discFolder && folders.length > 1) {
    disc = Number(discFolder[1])
    folders.pop()
  }
  const albumFolder = folders.at(-1)
  const artistFolder = folders.at(-2)
  // Folders like Seeker's own _Unsorted aren't artists.
  let albumArtist = artistFolder && !artistFolder.startsWith('_') ? clean(artistFolder) : null
  let album: string | null = null
  let year: number | null = null

  if (albumFolder) {
    let name = clean(albumFolder)
    for (let stripped = name.replace(DETAILS, ''); stripped !== name && stripped; stripped = name.replace(DETAILS, '')) name = stripped
    ;({ text: name, year } = takeYear(name))
    const split = splitDash(name)
    if (split && !albumArtist) [albumArtist, name] = split
    else if (split && same(split[0], albumArtist!)) name = split[1]
    // "Artist - 2008 - Album"
    if (year === null) ({ text: name, year } = takeYear(name))
    album = name || null
  }

  let title = clean(path.basename(file, path.extname(file)))
  let track: number | null = null
  const discTrack = DISC_TRACK.exec(title)
  const numbered = discTrack ? null : TRACK.exec(title)
  if (discTrack) {
    disc ??= Number(discTrack[1])
    track = Number(discTrack[2])
    title = discTrack[3]!.trim()
  } else if (numbered) {
    track = Number(numbered[1] ?? numbered[3])
    title = (numbered[2] ?? numbered[4])!.trim()
  }

  let artist = albumArtist
  const split = splitDash(title)
  if (split && albumArtist && same(split[0], albumArtist)) title = split[1]
  else if (split && (!albumArtist || VARIOUS.test(albumArtist))) [artist, title] = split

  return { albumArtist, artist, album, title, track: track || null, disc: disc || null, year }
}
