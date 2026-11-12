// Text normalization and fuzzy matching helpers.

export function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokens(value: string): string[] {
  const normalized = normalize(value)
  return normalized ? normalized.split(' ') : []
}

const EXTRA_WORDS =
  /\b(remaster(ed)?|deluxe|edition|version|expanded|anniversary|bonus|special|collector'?s?|super|reissue|explicit|clean|mono|stereo|remix(es)?|edit|single|album|ep|lp)\b/i

// Remove "(Remastered 2011)", "[Deluxe Edition]", " - Single Version", "feat. X" and similar noise.
export function stripExtras(title: string): string {
  let result = title
    .replace(/\s*[([]([^)\]]*)[)\]]/g, (match, inner: string) =>
      EXTRA_WORDS.test(inner) || /\b(feat|ft|featuring|with)\b\.?/i.test(inner) || /^\s*\d{4}\s*$/.test(inner)
        ? ''
        : match,
    )
    .replace(/\s+-\s+[^-]*\b(remaster(ed)?|version|edit|mono|stereo|mix)\b[^-]*$/i, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .trim()
  if (!result) result = title.trim()
  return result
}

// Strip every bracketed part, used for a broader fallback query.
export function stripBrackets(title: string): string {
  return title.replace(/\s*[([{][^)\]}]*[)\]}]/g, '').trim() || title.trim()
}

function bigrams(value: string): Map<string, number> {
  const compact = ` ${value} `
  const grams = new Map<string, number>()
  for (let i = 0; i < compact.length - 1; i++) {
    const gram = compact.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  return grams
}

// Sørensen–Dice coefficient over character bigrams of the normalized strings.
export function dice(a: string, b: string): number {
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const leftGrams = bigrams(left)
  const rightGrams = bigrams(right)
  let overlap = 0
  let total = 0
  for (const [gram, count] of leftGrams) {
    total += count
    const other = rightGrams.get(gram)
    if (other) overlap += Math.min(count, other)
  }
  for (const count of rightGrams.values()) total += count
  return (2 * overlap) / total
}

// Share of `wanted` tokens that appear in `haystack` tokens.
export function containment(wanted: string[], haystack: string[] | Set<string>): number {
  if (wanted.length === 0) return 0
  const set = haystack instanceof Set ? haystack : new Set(haystack)
  let hits = 0
  for (const token of wanted) if (set.has(token)) hits++
  return hits / wanted.length
}

export function similarity(a: string, b: string): number {
  const left = tokens(a)
  const right = tokens(b)
  if (left.length === 0 || right.length === 0) return 0
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  let shared = 0
  for (const token of leftSet) if (rightSet.has(token)) shared++
  const jaccard = shared / (leftSet.size + rightSet.size - shared)
  return Math.max(jaccard, dice(a, b))
}

// Some catalogs number every title ("01 Ghosts I"). When most of an album does that, drop the number.
const LEADING_NUMBER = /^0*(\d{1,3})(?:\s*[-.)]\s*|\s+)(?=\S)/

export function cleanTitles<T extends { title: string; track: number }>(tracks: T[]): T[] {
  const numbered = tracks.filter((track) => Number(track.title.match(LEADING_NUMBER)?.[1]) === track.track).length
  if (numbered < Math.max(2, Math.ceil(tracks.length / 2))) return tracks
  return tracks.map((track) =>
    Number(track.title.match(LEADING_NUMBER)?.[1]) === track.track ? { ...track, title: track.title.replace(LEADING_NUMBER, '') } : track,
  )
}

export function albumKey(artist: string, album: string): string {
  return `${normalize(artist)}\u0000${normalize(stripExtras(album))}`
}
