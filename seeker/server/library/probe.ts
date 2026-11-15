import { execFile } from 'node:child_process'
import type { IAudioMetadata } from 'music-metadata'

interface ProbeOutput {
  format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> }
  streams?: {
    codec_type?: string
    codec_name?: string
    sample_rate?: string
    bit_rate?: string
    bits_per_raw_sample?: string
    bits_per_sample?: number
    tags?: Record<string, string>
  }[]
}

const LOSSLESS = /^(?:flac|alac|wavpack|ape|tta|mlp|truehd|wmalossless|pcm_\w+)$/
const CODECS: Record<string, string> = { mp3: 'MP3', flac: 'FLAC', alac: 'ALAC', aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis', wavpack: 'WavPack', ape: 'Monkey’s Audio' }

// The file couldn't be read (permissions, a share that went away, a cancelled read), as opposed to
// music-metadata not making sense of what it read. Unreadable files keep what the index has.
export function isReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const name = (error as Error | null)?.name
  return (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) || name === 'AbortError' || name === 'TimeoutError'
}

const positive = (value: string | number | undefined) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function pair(value: string | undefined): { no: number | null; of: number | null } {
  const [no, of] = (value ?? '').split('/').map((part) => Number.parseInt(part, 10))
  return { no: no !== undefined && Number.isFinite(no) ? no : null, of: of !== undefined && Number.isFinite(of) ? of : null }
}

// A second opinion for files music-metadata can't parse, such as a tag whose header understates its
// size so the audio seems to start inside the cover art: ffprobe, which is in the image, searches
// past that. Only for files that failed, as it starts a process and may read more of the file.
export async function probeTags(file: string, signal?: AbortSignal): Promise<IAudioMetadata | null> {
  const args = ['-v', 'error', '-show_entries', 'format=format_name,duration,bit_rate:format_tags:stream=codec_type,codec_name,sample_rate,bit_rate,bits_per_raw_sample,bits_per_sample:stream_tags', '-of', 'json', file]
  const output = await new Promise<string | null>((resolve) => {
    execFile('ffprobe', args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, signal }, (error, stdout) => resolve(error ? null : String(stdout)))
  })
  let parsed: ProbeOutput
  try {
    parsed = JSON.parse(output ?? '') as ProbeOutput
  } catch {
    return null
  }
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
  if (!audio) return null
  // Names depend on the format: ID3 frames show as "album_artist" or a TXXX description, Vorbis
  // comments as "ALBUMARTIST".
  const tags = new Map<string, string>()
  for (const source of [parsed.format?.tags, audio.tags]) {
    for (const [key, value] of Object.entries(source ?? {})) if (value.trim()) tags.set(key.toLowerCase(), value.trim())
  }
  const tag = (...names: string[]) => names.map((name) => tags.get(name)).find((value) => value !== undefined)
  const date = tag('date', 'year', 'originaldate')
  const year = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN
  const isrc = tag('tsrc', 'isrc')
  const codec = audio.codec_name ?? ''
  return {
    common: {
      track: pair(tag('track', 'tracknumber')),
      disk: pair(tag('disc', 'discnumber')),
      movementIndex: { no: null, of: null },
      title: tag('title'),
      artist: tag('artist'),
      albumartist: tag('album_artist', 'albumartist', 'album artist'),
      album: tag('album'),
      year: Number.isFinite(year) && year > 0 ? year : undefined,
      date,
      isrc: isrc ? [isrc] : undefined,
      musicbrainz_recordingid: tag('musicbrainz_trackid', 'musicbrainz track id'),
      musicbrainz_albumid: tag('musicbrainz_albumid', 'musicbrainz album id'),
    },
    format: {
      trackInfo: [],
      tagTypes: [],
      container: parsed.format?.format_name,
      codec: CODECS[codec] ?? (codec.toUpperCase() || undefined),
      lossless: LOSSLESS.test(codec),
      duration: positive(parsed.format?.duration),
      bitrate: positive(audio.bit_rate ?? parsed.format?.bit_rate),
      sampleRate: positive(audio.sample_rate),
      bitsPerSample: positive(audio.bits_per_raw_sample ?? audio.bits_per_sample),
    },
    native: {},
    quality: { warnings: [] },
  }
}
