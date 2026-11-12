import type { Settings, TargetAlbum, TargetTrack } from '../../shared/types.ts'
import { normalize, similarity, stripExtras, tokens } from '../match/normalize.ts'
import { candidateKey, splitRemote, type Candidate } from './files.ts'
import { artistInText, cleanArtist, detectVersions, parseName, titleKey, wordsIn } from './match.ts'
import { qualityOf, type Quality } from './quality.ts'

const DISC_FOLDER = /^(cd|disc|disk|vol(ume)?)[\s._-]*(\d{1,2})\b/i

export interface Folder {
  key: string
  username: string
  dir: string
  name: string
  files: Candidate[]
  discOf: Map<string, number>
}

// Group files by (user, album folder). "Album/CD1" and "Album/CD2" become one folder.
export function groupFolders(candidates: Candidate[]): Folder[] {
  const folders = new Map<string, Folder>()
  for (const file of candidates) {
    const parts = splitRemote(file.dir)
    let albumDir = file.dir
    let disc: number | null = null
    const last = parts[parts.length - 1] ?? ''
    const discMatch = last.match(DISC_FOLDER)
    if (discMatch && parts.length > 1) {
      disc = Number(discMatch[3])
      const cut = file.dir.length - last.length - 1
      albumDir = file.dir.slice(0, Math.max(0, cut))
    }
    const key = `${file.username}\u0000${albumDir}`
    let folder = folders.get(key)
    if (!folder) {
      const albumParts = splitRemote(albumDir)
      folder = { key, username: file.username, dir: albumDir, name: albumParts[albumParts.length - 1] ?? albumDir, files: [], discOf: new Map() }
      folders.set(key, folder)
    }
    if (!folder.files.some((existing) => existing.filename === file.filename)) {
      folder.files.push(file)
      if (disc !== null) folder.discOf.set(file.filename, disc)
    }
  }
  return [...folders.values()]
}

interface Edge {
  file: Candidate
  rank: number
  durationTier: number
  gap: number
  rung: number
}

export interface Assignment {
  pairs: Map<number, Candidate>
  coverage: number
}

function trackEdges(
  track: TargetTrack,
  files: { file: Candidate; quality: Quality }[],
  context: { artist: string; album: string; folder: Folder; multiDisc: boolean; countsMatch: boolean },
): Edge[] {
  const edges: Edge[] = []
  const wantKey = titleKey(track.title)
  for (const { file, quality } of files) {
    const parsed = parseName(file.stem, {
      artist: context.artist,
      album: context.album,
      folderDisc: context.folder.discOf.get(file.filename) ?? null,
    })
    const exact = parsed.titles.some((title) => titleKey(title) === wantKey)
    const numberKnown = parsed.track !== null
    const discOk = !context.multiDisc || parsed.disc === null || parsed.disc === track.disc
    const numberAgrees = numberKnown && parsed.track === track.track && discOk
    // Lower is stronger: exact title + number, exact title, close title + number, renumbered exact title,
    // close title, close title with a different number, then number and length alone.
    let rank = -1
    if (exact) rank = numberAgrees ? 0 : numberKnown ? 3 : 1
    else {
      const fuzzy = Math.max(0, ...parsed.titles.map((title) => similarity(title, track.title)))
      if (fuzzy >= 0.8) rank = numberAgrees ? 2 : numberKnown ? 5 : 4
      else if (numberAgrees && context.countsMatch && track.duration && file.length && Math.abs(track.duration - file.length) <= 3) {
        rank = 6
      }
    }
    if (rank < 0) continue
    const gap = track.duration && file.length ? Math.abs(track.duration - file.length) : Number.POSITIVE_INFINITY
    const durationTier = !track.duration || !file.length ? 1 : gap <= 15 ? 0 : 2
    if (durationTier === 2 && gap > Math.max(30, track.duration * 0.2)) continue
    edges.push({ file, rank, durationTier, gap, rung: quality.rung })
  }
  edges.sort((a, b) => a.rank - b.rank || a.durationTier - b.durationTier || a.rung - b.rung || a.gap - b.gap)
  return edges
}

// One-to-one assignment of expected tracks to files (Kuhn's augmenting paths).
export function assignTracks(
  tracks: TargetTrack[],
  files: { file: Candidate; quality: Quality }[],
  context: { artist: string; album: string; folder: Folder },
): Assignment {
  const multiDisc = new Set(tracks.map((track) => track.disc)).size > 1
  const countsMatch = Math.abs(files.length - tracks.length) <= 1
  const edgesByTrack = new Map<number, Edge[]>()
  for (const track of tracks) {
    edgesByTrack.set(track.index, trackEdges(track, files, { ...context, multiDisc, countsMatch }))
  }
  const owner = new Map<string, number>()
  const pairs = new Map<number, Candidate>()

  const tryAssign = (trackIndex: number, visited: Set<string>, maxRank: number): boolean => {
    for (const edge of edgesByTrack.get(trackIndex) ?? []) {
      if (edge.rank > maxRank) continue
      const key = candidateKey(edge.file)
      if (visited.has(key)) continue
      visited.add(key)
      const current = owner.get(key)
      if (current === undefined || tryAssign(current, visited, maxRank)) {
        owner.set(key, trackIndex)
        pairs.set(trackIndex, edge.file)
        return true
      }
    }
    return false
  }

  // Match in passes from the strongest evidence to the weakest, so a file whose title and number
  // both agree with a track isn't taken by another track with the same title ("Interlude", "Ghosts I").
  const order = [...tracks].sort((a, b) => (edgesByTrack.get(a.index)?.length ?? 0) - (edgesByTrack.get(b.index)?.length ?? 0))
  for (let maxRank = 0; maxRank <= 6; maxRank++) {
    for (const track of order) if (!pairs.has(track.index)) tryAssign(track.index, new Set(), maxRank)
  }
  // Kuhn's algorithm can leave stale pairs behind when a track is re-routed; rebuild from owners.
  pairs.clear()
  for (const [key, trackIndex] of owner) {
    const file = files.find(({ file }) => candidateKey(file) === key)?.file
    if (file) pairs.set(trackIndex, file)
  }
  return { pairs, coverage: tracks.length ? pairs.size / tracks.length : 0 }
}

const VARIANT_WORDS = ['remix', 'rmx', 'acapella', 'instrumental', 'karaoke', 'live', 'demo', 'extended']
const EDITION_WORDS = ['deluxe', 'expanded', 'anniversary', 'special', 'platinum', 'bonus', 'remaster', 'remastered', 'edition', 'version']

function folderNameVariants(folder: Folder, artist: string): string[] {
  const variants = new Set<string>()
  const base = folder.name
  const strip = (value: string) =>
    value
      .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
      .replace(/^\s*\d{4}\s*[-.]?\s*/, '')
      .replace(/\s*[-.]?\s*\d{4}\s*$/, '')
      .replace(/^\s*\d{1,2}\s*[-.]\s+/, '')
      .trim()
  variants.add(base)
  variants.add(strip(base))
  const artistNorm = normalize(artist)
  for (const part of base.split(/\s+[-–]\s+/)) {
    if (normalize(part) !== artistNorm && !/^\d{4}$/.test(part.trim())) variants.add(strip(part))
  }
  const normalizedBase = normalize(base)
  if (artistNorm && normalizedBase.startsWith(artistNorm)) variants.add(normalizedBase.slice(artistNorm.length))
  return [...variants].filter(Boolean)
}

export interface FolderScore {
  folder: Folder
  score: number
  coverage: number
  albumScore: number
  artistScore: number
  rung: number
  label: string
  size: number
  pairs: Map<number, Candidate>
  eligible: boolean
  reason?: string
}

export function scoreFolder(
  album: TargetAlbum,
  tracks: TargetTrack[],
  folder: Folder,
  quality: Settings['quality'],
  wanted?: number[],
  maxRung?: number,
): FolderScore {
  const artist = cleanArtist(album.artist)
  const albumTitle = stripExtras(album.title)
  const acceptable = folder.files
    .map((file) => ({ file, quality: qualityOf(file, quality) }))
    .filter(
      (entry): entry is { file: Candidate; quality: Quality } =>
        entry.quality !== null && (maxRung === undefined || entry.quality.rung < maxRung),
    )
  const wantedTracks = wanted ? tracks.filter((track) => wanted.includes(track.index)) : tracks
  const empty: FolderScore = {
    folder,
    score: 0,
    coverage: 0,
    albumScore: 0,
    artistScore: 0,
    rung: Number.POSITIVE_INFINITY,
    label: '',
    size: 0,
    pairs: new Map(),
    eligible: false,
  }
  if (acceptable.length === 0) {
    return { ...empty, reason: maxRung === undefined ? 'no files in an accepted format' : 'no better quality than what you have' }
  }

  const assignment = assignTracks(tracks, acceptable, { artist, album: albumTitle, folder })
  const pairs = new Map([...assignment.pairs].filter(([index]) => wantedTracks.some((track) => track.index === index)))
  const coverage = wantedTracks.length ? pairs.size / wantedTracks.length : 0

  const variants = folderNameVariants(folder, artist)
  const pathSegments = splitRemote(folder.dir).filter((segment) => !segment.startsWith('@@'))
  let albumScore = Math.max(0, ...variants.map((variant) => similarity(albumTitle, variant)))
  const albumTokens = tokens(albumTitle)
  if (albumTokens.length && wordsIn(albumTokens, folder.name)) albumScore = Math.max(albumScore, 0.9)
  const artistScore = pathSegments.some((segment) => artistInText(artist, segment))
    ? 1
    : Math.max(0, ...pathSegments.map((segment) => similarity(artist, segment) * 0.8))

  const audioCount = folder.files.length
  const diff = Math.abs(audioCount - tracks.length)
  const countScore = diff === 0 ? 1 : diff <= 2 ? 0.75 : diff <= 5 ? 0.35 : 0
  const yearScore = album.year && folder.dir.includes(String(album.year)) ? 1 : 0.5
  const qualityCount = Math.min(1, acceptable.length / Math.max(1, tracks.length))
  const peer = folder.files[0]!.peer
  const peerScore = (peer.freeSlot ? 0.5 : 0) + Math.min(peer.speed / 2_000_000, 1) * 0.3 + (peer.queue === 0 ? 0.2 : peer.queue < 10 ? 0.1 : 0)

  const folderWords = new Set(normalize(folder.name).split(' '))
  const albumWords = new Set(normalize(album.title).split(' '))
  let penalty = 0
  for (const word of VARIANT_WORDS) if (folderWords.has(word) && !albumWords.has(word)) penalty += 0.12
  for (const word of EDITION_WORDS) if (folderWords.has(word) && !albumWords.has(word)) penalty += 0.06
  const versions = detectVersions(`(${folder.name})`, [albumTitle])
  if (versions.has('live') && !albumWords.has('live')) penalty += 0.12
  penalty = Math.min(0.3, penalty)

  const score = Math.max(
    0,
    Math.min(
      1,
      0.24 * albumScore +
        0.16 * artistScore +
        0.16 * countScore +
        0.28 * coverage +
        0.06 * yearScore +
        0.06 * qualityCount +
        0.04 * peerScore -
        penalty,
    ),
  )

  const chosen = [...pairs.values()]
  const rungs = chosen.map((file) => acceptable.find((entry) => entry.file === file)!.quality)
  const rung = rungs.length ? Math.max(...rungs.map((q) => q.rung)) : Number.POSITIVE_INFINITY
  const labelCounts = new Map<string, number>()
  for (const q of rungs) labelCounts.set(q.label, (labelCounts.get(q.label) ?? 0) + 1)
  const label = [...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  const size = chosen.reduce((sum, file) => sum + file.size, 0)

  const minCoverage = wantedTracks.length <= 3 ? 1 : 0.8
  const albumGate = coverage === 1 && artistScore >= 0.9 && wantedTracks.length >= 3 ? 0.4 : 0.65
  let reason: string | undefined
  if (coverage < minCoverage) reason = `only ${pairs.size} of ${wantedTracks.length} tracks`
  else if (albumScore < albumGate) reason = 'folder name does not match the album'
  else if (score < 0.62) reason = 'weak overall match'
  return { folder, score, coverage, albumScore, artistScore, rung, label, size, pairs, eligible: !reason, reason }
}

// Healthier peers first; between equally healthy peers, smaller (CD-quality) copies download faster.
function peerKey(score: FolderScore): number[] {
  const peer = score.folder.files[0]!.peer
  const hiRes = /\b24\/|\/(88\.2|96|176\.4|192)\b/.test(score.label) ? 1 : 0
  return [peer.freeSlot ? 1 : 0, -peer.queue, -hiRes, peer.speed]
}

// Best quality first, then complete folders, then score; within a small band prefer the healthier peer.
export function rankFolders(scores: FolderScore[]): FolderScore[] {
  const sorted = [...scores].sort(
    (a, b) => a.rung - b.rung || Number(b.coverage === 1) - Number(a.coverage === 1) || b.score - a.score,
  )
  const ordered: FolderScore[] = []
  while (sorted.length) {
    const leader = sorted[0]!
    const band = sorted.filter(
      (item) => item.rung === leader.rung && (item.coverage === 1) === (leader.coverage === 1) && leader.score - item.score <= 0.06,
    )
    band.sort((a, b) => {
      const ka = peerKey(a)
      const kb = peerKey(b)
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!
      return b.score - a.score
    })
    ordered.push(...band)
    for (const item of band) sorted.splice(sorted.indexOf(item), 1)
  }
  return ordered
}
