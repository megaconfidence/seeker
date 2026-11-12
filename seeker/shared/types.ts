// Types shared by the server and the web UI.

export type JobKind = 'album' | 'track' | 'files' | 'import'
export type JobStatus =
  | 'queued'
  | 'searching'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'wanted'
  | 'cancelled'
export type JobOrigin = 'ui' | 'watchlist' | 'mcp' | 'cli' | 'manual'

export const ACTIVE_STATUSES: JobStatus[] = ['queued', 'searching', 'downloading', 'processing']

export interface TargetTrack {
  index: number
  title: string
  artist: string
  disc: number
  track: number
  duration: number
  isrc?: string
  deezerId?: number
  mbRecordingId?: string
  mbTrackId?: string
  mbArtistId?: string
}

export interface TargetAlbum {
  title: string
  artist: string
  year?: number
  releaseDate?: string
  label?: string
  genres?: string[]
  upc?: string
  recordType?: string
  trackCount: number
  discCount: number
  coverUrl?: string
  deezerId?: number
  deezerArtistId?: number
  mbReleaseId?: string
  mbReleaseGroupId?: string
  mbArtistId?: string
  mbChecked?: boolean
  originalYear?: number
  compilation?: boolean
}

export interface JobTarget {
  album: TargetAlbum
  tracks: TargetTrack[]
  // For track jobs: which tracks of the album are wanted. Album jobs want all.
  wanted?: number[]
  // Upgrades only accept copies better than this quality rung.
  maxRung?: number
  // Library album whose files the new copy replaces.
  replaceLibraryAlbumId?: string
  // Imports: copy files into the library or move them.
  importMode?: 'copy' | 'move'
}

export interface JobSource {
  username: string
  folder?: string
  quality: string
}

export interface JobFile {
  id: number
  trackIndex: number | null
  username: string
  filename: string
  size: number
  state: string
  bytes: number
  speed: number
  queuePosition: number | null
  error: string | null
}

export interface JobProgress {
  files: number
  done: number
  bytes: number
  size: number
  speed: number
}

export interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  artist: string
  album: string | null
  year: number | null
  coverUrl: string | null
  deezerArtistId: number | null
  deezerAlbumId: number | null
  deezerTrackId: number | null
  mbReleaseId: string | null
  origin: JobOrigin
  attempts: number
  error: string | null
  phase: string | null
  nextRetryAt: number | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  source: JobSource | null
  progress: JobProgress
}

export interface JobLogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface JobDetail extends Job {
  target: JobTarget | null
  files: JobFile[]
  log: JobLogEntry[]
}

export type OwnedState = 'none' | 'partial' | 'complete'
export type RecordType = 'album' | 'ep' | 'single' | 'compile'

export interface CatalogArtist {
  id: number
  name: string
  picture: string | null
  fans?: number
  albums?: number
  watched?: boolean
}

export interface JobRef {
  id: string
  status: JobStatus
}

export interface CatalogAlbum {
  // Deezer album id, or 0 for MusicBrainz releases (see mbid).
  id: number
  mbid: string | null
  source: 'deezer' | 'musicbrainz'
  title: string
  artist: string
  artistId: number
  cover: string | null
  coverSmall: string | null
  year: number | null
  releaseDate: string | null
  type: RecordType
  tracks: number | null
  explicit: boolean
  owned: OwnedState
  job: JobRef | null
}

export interface CatalogTrack {
  id: number
  title: string
  artist: string
  artistId: number
  album: string
  albumId: number
  cover: string | null
  duration: number
  explicit: boolean
  disc: number | null
  track: number | null
  owned: boolean
  libraryTrackId: number | null
  job: JobRef | null
}

export interface CatalogSearchResult {
  artists: CatalogArtist[]
  albums: CatalogAlbum[]
  tracks: CatalogTrack[]
}

// A catalog album or song that "Artist - Title" could mean.
export interface MatchCandidate {
  kind: 'album' | 'track'
  source: 'deezer' | 'musicbrainz'
  id: number
  mbid?: string
  title: string
  artist: string
  album?: string
  albumId?: number
  cover: string | null
  year: number | null
  recordType?: RecordType
  tracks?: number | null
  duration?: number
  confidence: number
  owned: OwnedState
}

export interface MatchPreview {
  best: MatchCandidate | null
  alternatives: MatchCandidate[]
}

export interface CatalogArtistPage {
  artist: CatalogArtist
  top: CatalogTrack[]
  albums: CatalogAlbum[]
}

export interface CatalogAlbumPage {
  album: CatalogAlbum & { label: string | null; genres: string[]; duration: number }
  tracks: CatalogTrack[]
  libraryAlbumId: string | null
}

export interface SlskFile {
  filename: string
  name: string
  size: number
  ext: string
  bitrate: number | null
  bitDepth: number | null
  sampleRate: number | null
  length: number | null
  vbr: boolean
  matchedTrack: number | null
}

export interface SlskFolder {
  key: string
  username: string
  folder: string
  files: SlskFile[]
  freeSlot: boolean
  speed: number
  queue: number
  quality: string
  acceptable: boolean
  size: number
  matched: number | null
  expected: number | null
  score: number
}

export interface SlskSearch {
  id: string
  query: string
  state: string
  complete: boolean
  responses: number
  files: number
  folders: SlskFolder[]
}

export interface LibraryAlbum {
  id: string
  title: string
  artist: string
  year: number | null
  trackCount: number
  duration: number
  format: string | null
  hasCover: boolean
  addedAt: number
  deezerAlbumId: number | null
  mbAlbumId: string | null
}

export interface LibraryAlbumDetail {
  album: LibraryAlbum
  tracks: LibraryTrack[]
  // False when the files are already in the best quality your settings allow.
  canUpgrade: boolean
  unsorted: boolean
}

export interface LibraryTrack {
  id: number
  title: string
  artist: string
  album: string
  albumId: string
  trackNo: number | null
  discNo: number | null
  duration: number
  codec: string | null
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  lossless: boolean
}

export interface LibraryArtist {
  name: string
  albums: number
  tracks: number
  coverAlbumId: string | null
}

export interface ImportFolder {
  id: string
  path: string
  name: string
  files: number
  size: number
  artist: string | null
  album: string | null
  year: number | null
  formats: string[]
}

export interface ImportCandidate {
  source: 'deezer' | 'musicbrainz'
  id: number
  mbid: string | null
  title: string
  artist: string
  year: number | null
  cover: string | null
  trackCount: number
  matched: number
  files: number
  score: number
}

export type ImportChoice = { albumId: number } | { mbid: string } | { asIs: true }

export interface WatchArtist {
  id: number
  name: string
  picture: string | null
  types: RecordType[]
  since: string
  addedAt: number
  lastCheckedAt: number | null
  lastFound: number
}

export interface SlskdStatus {
  reachable: boolean
  connected: boolean
  loggedIn: boolean
  username: string | null
  state: string | null
  error: string | null
  sharedFiles: number | null
  sharedFolders: number | null
  scanningShares: boolean
}

export interface AppStatus {
  version: string
  commit: string | null
  slskd: SlskdStatus
  jobs: { active: number; wanted: number; failed: number }
  library: { albums: number; tracks: number; scanning: boolean }
}

export type QualityFormat = 'flac' | 'alac' | 'wav' | 'mp3' | 'aac' | 'ogg' | 'opus'

export interface Settings {
  quality: {
    formats: QualityFormat[]
    minBitrate: number
    acceptVbr: boolean
    hiRes: 'prefer' | 'accept' | 'avoid'
  }
  naming: {
    template: string
  }
  checks: {
    duration: boolean
    integrity: boolean
    fakeLossless: boolean
    acoustidKey: string
  }
  jellyfin: {
    url: string
    apiKey: string
  }
  watchlist: {
    intervalHours: number
    types: RecordType[]
  }
  wishlist: {
    enabled: boolean
  }
}

export interface ApiToken {
  id: string
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number | null
}

export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'job-removed'; id: string }
  | { type: 'status'; status: AppStatus }
  | { type: 'library'; albums: number; tracks: number; scanning: boolean }
  | { type: 'watchlist' }
