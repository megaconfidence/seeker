import path from 'node:path'

function env(name: string, fallback = ''): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function num(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const config = {
  version: '0.2.0',
  // Short commit id baked into published images; empty in development.
  commit: env('SEEKER_COMMIT').slice(0, 7),
  port: num('SEEKER_PORT', 7335),
  dataDir: path.resolve(env('SEEKER_DATA_DIR', '/data')),
  downloadsDir: path.resolve(env('SEEKER_DOWNLOADS_DIR', '/downloads')),
  musicDir: path.resolve(env('SEEKER_MUSIC_DIR', '/music')),
  importDir: path.resolve(env('SEEKER_IMPORT_DIR', '/import')),
  password: env('SEEKER_PASSWORD'),
  acoustidKey: env('ACOUSTID_API_KEY'),
  slskdUrl: env('SLSKD_URL', 'http://slskd:5030').replace(/\/+$/, ''),
  slskdApiKey: env('SLSKD_API_KEY'),
  webDir: path.resolve(import.meta.dirname, '../web/dist'),
  dev: env('NODE_ENV') === 'development',
  // Overridable so tests can point Seeker at local fakes.
  deezerUrl: env('SEEKER_DEEZER_URL', 'https://api.deezer.com').replace(/\/+$/, ''),
  musicbrainzUrl: env('SEEKER_MUSICBRAINZ_URL', 'https://musicbrainz.org/ws/2').replace(/\/+$/, ''),
  coverArtUrl: env('SEEKER_COVERART_URL', 'https://coverartarchive.org').replace(/\/+$/, ''),
  timing: {
    pollMs: num('SEEKER_POLL_MS', 2000),
    albumStallMs: num('SEEKER_ALBUM_STALL_MS', 180_000),
    trackQueueMs: num('SEEKER_TRACK_QUEUE_MS', 90_000),
    giveUpMs: num('SEEKER_GIVE_UP_MS', 30 * 60_000),
    missingMs: num('SEEKER_MISSING_MS', 90_000),
    searchGapMs: num('SEEKER_SEARCH_GAP_MS', 2000),
    searchIdleMs: num('SEEKER_SEARCH_IDLE_MS', 12_000),
    locateMs: num('SEEKER_LOCATE_MS', 30_000),
  },
}
