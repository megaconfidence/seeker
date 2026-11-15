import path from 'node:path'

function env(name: string, fallback = ''): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function num(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// SEEKER_SCAN_CONCURRENCY: how many files a library scan reads at once, 1 to 64 (more is capped).
// Null when it isn't set or isn't a number: scans then go by the music folder's filesystem.
export function parseScanConcurrency(value: string): number | null {
  const count = Number(value)
  return Number.isFinite(count) && count >= 1 ? Math.min(64, Math.floor(count)) : null
}

// The container entrypoint applies UMASK to the process; files moved into the library get the
// matching mode, 644 by default.
function fileMode(): number {
  const umask = env('UMASK', '022')
  return /^[0-7]{3,4}$/.test(umask) ? 0o666 & ~Number.parseInt(umask, 8) : 0o644
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
  fileMode: fileMode(),
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
  scanConcurrency: parseScanConcurrency(env('SEEKER_SCAN_CONCURRENCY')),
  timing: {
    pollMs: num('SEEKER_POLL_MS', 2000),
    // How often slskd's status (connection, sharing, share scans) is read.
    statusMs: num('SEEKER_STATUS_MS', 10_000),
    // Shortened by offline tests without allowing unsafe quiet-period settings.
    shareMinuteMs: num('SEEKER_SHARE_MINUTE_MS', 60_000),
    albumStallMs: num('SEEKER_ALBUM_STALL_MS', 180_000),
    trackQueueMs: num('SEEKER_TRACK_QUEUE_MS', 90_000),
    giveUpMs: num('SEEKER_GIVE_UP_MS', 30 * 60_000),
    missingMs: num('SEEKER_MISSING_MS', 90_000),
    searchGapMs: num('SEEKER_SEARCH_GAP_MS', 2000),
    searchIdleMs: num('SEEKER_SEARCH_IDLE_MS', 12_000),
    locateMs: num('SEEKER_LOCATE_MS', 30_000),
    // How long slskd may take to move a finished download into place (it copies across file systems).
    moveWaitMs: num('SEEKER_MOVE_WAIT_MS', 60 * 60_000),
    // A full library scan saves what it has read at least this often, and every 200 tracks.
    scanBatchMs: num('SEEKER_SCAN_BATCH_MS', 15_000),
    // How long a scan waits for one file's tags before it skips the file until the next scan.
    scanReadMs: num('SEEKER_SCAN_READ_MS', 60_000),
  },
}
