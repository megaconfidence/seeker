import type { Settings } from '../shared/types.ts'
import { all, exec } from './db.ts'

export const DEFAULT_SETTINGS: Settings = {
  quality: {
    formats: ['flac', 'mp3'],
    minBitrate: 320,
    acceptVbr: false,
    hiRes: 'accept',
  },
  naming: {
    template: '{albumartist}/{album} ({year})/{disctrack} - {title}',
  },
  checks: {
    duration: true,
    integrity: true,
    fakeLossless: true,
    acoustidKey: '',
  },
  jellyfin: {
    url: '',
    apiKey: '',
  },
  watchlist: {
    intervalHours: 12,
    types: ['album', 'ep'],
  },
  wishlist: {
    enabled: true,
  },
  shares: {
    autoRescan: true,
    quietMinutes: 30,
    rescanOnFirstScan: false,
  },
}

type Section = keyof Settings

let cached: Settings | null = null
const listeners = new Set<(sections: Section[]) => void>()

export function onSettingsChange(listener: (sections: Section[]) => void) {
  listeners.add(listener)
}

export function getSettings(): Settings {
  if (cached) return cached
  const stored = new Map(all<{ key: string; value: string }>('SELECT key, value FROM settings').map((row) => [row.key, row.value]))
  const settings = structuredClone(DEFAULT_SETTINGS)
  for (const section of Object.keys(DEFAULT_SETTINGS) as Section[]) {
    const raw = stored.get(section)
    if (!raw) continue
    try {
      Object.assign(settings[section], JSON.parse(raw))
    } catch {
      // ignore a corrupt row and fall back to defaults
    }
  }
  normalizeShares(settings)
  cached = settings
  return settings
}

export function updateSettings(patch: Partial<{ [K in Section]: Partial<Settings[K]> }>): Settings {
  const settings = structuredClone(getSettings())
  const sections = (Object.keys(patch) as Section[]).filter((section) => section in DEFAULT_SETTINGS)
  for (const section of sections) {
    Object.assign(settings[section], patch[section])
    if (section === 'shares') normalizeShares(settings)
    exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      section,
      JSON.stringify(settings[section]),
    ])
  }
  cached = settings
  for (const listener of listeners) listener(sections)
  return settings
}

function normalizeShares(settings: Settings) {
  // Older databases may contain zero or sub-minute periods that the API used to accept.
  if (!Number.isFinite(settings.shares.quietMinutes) || settings.shares.quietMinutes < 1) settings.shares.quietMinutes = 1
}
