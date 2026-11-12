import type { QualityFormat, Settings } from '../../shared/types.ts'
import type { Candidate } from './files.ts'

export type Format = QualityFormat | 'other'

const LOSSLESS: Format[] = ['flac', 'alac', 'wav']

export function formatOf(file: Pick<Candidate, 'ext' | 'bitDepth' | 'bitrate'>): Format {
  switch (file.ext) {
    case 'flac':
      return 'flac'
    case 'mp3':
      return 'mp3'
    case 'wav':
    case 'wave':
    case 'aiff':
    case 'aif':
    case 'aifc':
      return 'wav'
    case 'alac':
      return 'alac'
    case 'm4a':
    case 'mp4':
      return file.bitDepth || (file.bitrate && file.bitrate >= 500) ? 'alac' : 'aac'
    case 'aac':
      return 'aac'
    case 'ogg':
    case 'oga':
      return 'ogg'
    case 'opus':
      return 'opus'
    default:
      return 'other'
  }
}

export function effectiveBitrate(file: Pick<Candidate, 'bitrate' | 'size' | 'length'>): number | null {
  if (file.bitrate) return file.bitrate
  if (file.size && file.length) return Math.round((file.size * 8) / file.length / 1000)
  return null
}

export interface Quality {
  rung: number
  tier: number
  label: string
  format: Format
  lossless: boolean
}

function trimRate(sampleRate: number): string {
  return (sampleRate / 1000).toFixed(1).replace(/\.0$/, '')
}

export function qualityLabel(file: Candidate): string {
  const format = formatOf(file)
  const bitrate = effectiveBitrate(file)
  if (LOSSLESS.includes(format)) {
    const name = format === 'wav' ? 'WAV' : format.toUpperCase()
    if (file.bitDepth && file.sampleRate) return `${name} ${file.bitDepth}/${trimRate(file.sampleRate)}`
    if (file.bitDepth) return `${name} ${file.bitDepth}-bit`
    return name
  }
  const name = format === 'other' ? file.ext.toUpperCase() : format === 'ogg' ? 'Vorbis' : format === 'opus' ? 'Opus' : format.toUpperCase()
  if (!bitrate) return name
  if (format === 'mp3' && file.vbr) return `MP3 VBR ~${bitrate}`
  return `${name} ${bitrate}`
}

function isHiRes(file: Candidate): boolean {
  return (file.bitDepth ?? 16) >= 24 || (file.sampleRate ?? 44_100) > 48_000
}

// Lower rung is better. Returns null when the file isn't acceptable under the user's settings.
export function qualityOf(file: Candidate, settings: Settings['quality']): Quality | null {
  const format = formatOf(file)
  const bitrate = effectiveBitrate(file)
  const lossless = LOSSLESS.includes(format)
  let rung = 0
  for (const wanted of settings.formats) {
    if (LOSSLESS.includes(wanted)) {
      const hiResRungs = settings.hiRes === 'prefer' ? 2 : 1
      if (wanted === format) {
        const hiRes = isHiRes(file)
        if (settings.hiRes === 'avoid' && hiRes) return null
        const offset = settings.hiRes === 'prefer' && !hiRes ? 1 : 0
        const hiResBonus = Math.min((file.sampleRate ?? 44_100) / 192_000, 1) * 20 + (Math.max((file.bitDepth ?? 16) - 16, 0) / 8) * 10
        return {
          rung: rung + offset,
          // When hi-res is merely accepted, smaller CD-quality copies win ties.
          tier: settings.hiRes === 'prefer' ? 100 + hiResBonus : 100 - hiResBonus,
          label: qualityLabel(file),
          format,
          lossless,
        }
      }
      rung += hiResRungs
      continue
    }
    if (wanted === format) {
      let ok: boolean
      if (format === 'mp3') {
        ok = !!bitrate && (bitrate >= settings.minBitrate - 5 || (settings.acceptVbr && file.vbr && bitrate >= 220))
      } else if (format === 'aac') {
        ok = !bitrate || bitrate >= Math.min(settings.minBitrate, 256) - 5
      } else {
        ok = !bitrate || bitrate >= Math.min(settings.minBitrate, format === 'opus' ? 128 : 192) - 5
      }
      if (!ok) return null
      const base = format === 'mp3' ? 50 : format === 'aac' ? 60 : format === 'opus' ? 65 : 70
      return { rung, tier: base + Math.min((bitrate ?? 0) / 320, 1) * 10, label: qualityLabel(file), format, lossless }
    }
    rung += 1
  }
  return null
}
