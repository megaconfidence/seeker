import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { config } from './config.ts'
import { databaseOpenFailed, ensureDataDir } from './folders.ts'

ensureDataDir()

export const db = openDatabase(path.join(config.dataDir, 'seeker.db'))

function openDatabase(file: string): DatabaseSync {
  try {
    const database = new DatabaseSync(file)
    database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
    return database
  } catch (error) {
    return databaseOpenFailed(error)
  }
}

const migrations = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    year INTEGER,
    cover_url TEXT,
    deezer_artist_id INTEGER,
    deezer_album_id INTEGER,
    deezer_track_id INTEGER,
    target TEXT,
    source TEXT,
    origin TEXT NOT NULL DEFAULT 'ui',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    next_retry_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    result TEXT
  );
  CREATE INDEX jobs_status ON jobs(status);
  CREATE INDEX jobs_album ON jobs(deezer_album_id);
  CREATE INDEX jobs_track ON jobs(deezer_track_id);

  CREATE TABLE job_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    track_index INTEGER,
    username TEXT NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    transfer_id TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    remote_state TEXT,
    quality TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    speed REAL NOT NULL DEFAULT 0,
    queue_position INTEGER,
    local_path TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX job_files_job ON job_files(job_id);

  CREATE TABLE job_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX job_log_job ON job_log(job_id);

  CREATE TABLE watch_artists (
    deezer_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    picture TEXT,
    types TEXT NOT NULL,
    since TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_found INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE lib_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    album_id TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    album_artist TEXT NOT NULL,
    track_no INTEGER,
    disc_no INTEGER,
    year INTEGER,
    duration REAL,
    codec TEXT,
    bitrate INTEGER,
    sample_rate INTEGER,
    bit_depth INTEGER,
    lossless INTEGER NOT NULL DEFAULT 0,
    isrc TEXT,
    mb_track_id TEXT,
    mb_album_id TEXT,
    norm_artist TEXT NOT NULL,
    norm_title TEXT NOT NULL,
    has_cover INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL
  );
  CREATE INDEX lib_tracks_album ON lib_tracks(album_id);
  CREATE INDEX lib_tracks_norm ON lib_tracks(norm_artist, norm_title);
  CREATE INDEX lib_tracks_isrc ON lib_tracks(isrc);

  CREATE TABLE lib_albums (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    year INTEGER,
    dir TEXT NOT NULL,
    cover TEXT,
    track_count INTEGER NOT NULL,
    duration REAL,
    format TEXT,
    norm_key TEXT NOT NULL,
    mb_album_id TEXT,
    deezer_album_id INTEGER,
    added_at INTEGER NOT NULL
  );
  CREATE INDEX lib_albums_norm ON lib_albums(norm_key);
  CREATE INDEX lib_albums_deezer ON lib_albums(deezer_album_id);

  CREATE TABLE imports (
    path TEXT PRIMARY KEY,
    deezer_album_id INTEGER,
    deezer_track_id INTEGER,
    job_id TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX imports_album ON imports(deezer_album_id);
  `,
  `
  ALTER TABLE jobs ADD COLUMN mb_release_id TEXT;
  CREATE INDEX jobs_mb ON jobs(mb_release_id);
  ALTER TABLE imports ADD COLUMN mb_release_id TEXT;
  `,
  // Why a downloaded job is waiting to be filed (jobs/store.ts WaitReason); null when it isn't.
  `
  ALTER TABLE jobs ADD COLUMN waiting_for TEXT;
  `,
]

const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
for (let version = current; version < migrations.length; version++) {
  db.exec('BEGIN')
  try {
    db.exec(migrations[version]!)
    db.exec(`PRAGMA user_version = ${version + 1}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

type Param = SQLInputValue | boolean | undefined
type Params = Record<string, Param> | Param[]

function bind(params: Params | undefined): Record<string, SQLInputValue> | SQLInputValue[] {
  const convert = (value: Param): SQLInputValue =>
    value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value
  if (!params) return []
  if (Array.isArray(params)) return params.map(convert)
  const out: Record<string, SQLInputValue> = {}
  for (const [key, value] of Object.entries(params)) out[key] = convert(value)
  return out
}

function run(statement: ReturnType<DatabaseSync['prepare']>, method: 'run' | 'get' | 'all', params?: Params) {
  const bound = bind(params)
  return Array.isArray(bound) ? statement[method](...bound) : statement[method](bound)
}

const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>()
function prepare(sql: string) {
  let statement = cache.get(sql)
  if (!statement) {
    statement = db.prepare(sql)
    cache.set(sql, statement)
  }
  return statement
}

export function all<T>(sql: string, params?: Params): T[] {
  return run(prepare(sql), 'all', params) as T[]
}

export function get<T>(sql: string, params?: Params): T | undefined {
  return run(prepare(sql), 'get', params) as T | undefined
}

export function exec(sql: string, params?: Params) {
  return run(prepare(sql), 'run', params) as { changes: number | bigint; lastInsertRowid: number | bigint }
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getMeta(key: string): string | undefined {
  return get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value
}

export function setMeta(key: string, value: string) {
  exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
}
