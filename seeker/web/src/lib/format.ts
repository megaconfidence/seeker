export function duration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '–:––'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

// Playback position: counts from 0:00 and rounds down, like every other player.
export function elapsed(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0))
  return total === 0 ? '0:00' : duration(total)
}

export function longDuration(seconds: number | null | undefined): string {
  if (!seconds) return ''
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} hr ${m} min` : `${h} hr`
}

export function bytes(value: number | null | undefined): string {
  if (!value) return '0 MB'
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function speed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || bytesPerSecond < 1) return ''
  if (bytesPerSecond < 1024 * 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
}

export function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) return ''
  const diff = timestamp - Date.now()
  const abs = Math.abs(diff)
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60_000, 'second'],
    [3_600_000, 'minute'],
    [86_400_000, 'hour'],
    [604_800_000, 'day'],
    [2_629_800_000, 'week'],
    [31_557_600_000, 'month'],
    [Infinity, 'year'],
  ]
  const divisors: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_629_800_000,
    year: 31_557_600_000,
  }
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [limit, unit] of units) {
    if (abs < limit) {
      if (unit === 'second' && abs < 45_000) return diff < 0 ? 'just now' : 'in a moment'
      return format.format(Math.round(diff / divisors[unit]!), unit)
    }
  }
  return ''
}

export function timeLeft(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return 'under a minute left'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return minutes ? `${hours} h ${minutes} min left` : `${hours} h left`
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`
}

export const recordTypeLabel: Record<string, string> = {
  album: 'Album',
  ep: 'EP',
  single: 'Single',
  compile: 'Compilation',
}
