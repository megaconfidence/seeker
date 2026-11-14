import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { ImportCandidate, Job, LibraryTrack, Settings } from '../shared/types.ts'
import { createToken, listTokens, revokeToken } from './auth.ts'
import { albumPage, albumYears, artistPage, mbAlbumPage, NotFoundError, previewQuery, searchCatalog, searchMusicBrainz } from './catalog.ts'
import { config } from './config.ts'
import { folderProblems } from './folders.ts'
import { testJellyfin } from './jellyfin.ts'
import {
  AlreadyOwnedError,
  cancelJob,
  clearFinished,
  queueAlbum,
  queueFiles,
  queueMbAlbum,
  queueQuery,
  queueTrack,
  removeJob,
  retryJob,
} from './jobs/engine.ts'
import { getJob, listJobs, toDetail } from './jobs/store.ts'
import { identifyImportFolder, identifyLibraryAlbum, importFolder, listImportFolders, rematchLibraryAlbum } from './library/importer.ts'
import { deleteLibraryAlbum, deleteLibraryTrack, upgradeLibraryAlbum } from './library/manage.ts'
import { scanLibrary } from './library/scan.ts'
import { getAlbum, listAlbums, listArtists, searchTracks } from './library/serve.ts'
import { recentProblems } from './log.ts'
import { testAcoustidKey } from './post/verify.ts'
import { recordTypes, settingsSchema } from './schemas.ts'
import { getSettings, updateSettings } from './settings.ts'
import { getManualSearch, startManualSearch } from './soulseek/manual.ts'
import { searchBudget } from './soulseek/search.ts'
import { slskd } from './soulseek/slskd.ts'
import { rescanSharesNow } from './shares.ts'
import { appStatus } from './status.ts'
import { errorMessage, sleep } from './util.ts'
import { checkArtist, checkDueArtists, listWatchlist, unwatchArtist, updateWatch, watchArtist } from './watchlist.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

function ok(data: unknown, summary?: string): ToolResult {
  const json = JSON.stringify(data)
  return { content: [{ type: 'text', text: summary ? `${summary}\n${json}` : json }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof AlreadyOwnedError) return fail(`${error.message}. Pass force: true to download it again.`)
    if (error instanceof NotFoundError) {
      return fail(`${error.message}.${error.suggestions.length ? ` Closest matches: ${error.suggestions.join('; ')}` : ''}`)
    }
    if (error instanceof z.ZodError) return fail(error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
    return fail(errorMessage(error))
  }
}

const FINAL = new Set(['completed', 'failed', 'wanted', 'cancelled'])

function rate(bytesPerSecond: number): string | undefined {
  if (bytesPerSecond < 1024) return undefined
  return bytesPerSecond >= 1024 * 1024 ? `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1024)} KB/s`
}

function remaining(seconds: number): string {
  if (seconds < 60) return 'under a minute'
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`
  return `about ${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
}

// The same numbers the web app shows: percent done, speed and time left.
function jobProgress(job: Job) {
  const { files, done, bytes, size, speed } = job.progress
  const percent =
    job.status === 'completed' ? 100 : size > 0 && bytes > 0 ? (bytes / size) * 100 : files > 0 ? (done / files) * 100 : 0
  const downloading = job.status === 'downloading' && speed >= 1024 && size > bytes
  return {
    percent: Math.min(100, Math.round(percent)),
    tracks: `${done}/${files} ${job.kind === 'import' ? 'files' : 'tracks'}`,
    speed: job.status === 'downloading' ? rate(speed) : undefined,
    timeLeft: downloading ? remaining((size - bytes) / speed) : undefined,
  }
}

function compactJob(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    title: job.title,
    artist: job.artist,
    album: job.album,
    phase: job.phase,
    error: job.error,
    progress: jobProgress(job),
    source: job.source ? `${job.source.username} (${job.source.quality})` : null,
    // Who asked for it: ui, mcp, or watchlist (a new release).
    origin: job.origin,
    attempts: job.attempts,
    nextRetry: job.nextRetryAt ? new Date(job.nextRetryAt).toISOString() : null,
    createdAt: new Date(job.createdAt).toISOString(),
    endedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
    updatedAt: new Date(job.updatedAt).toISOString(),
  }
}

const LIVE_OR_DONE = new Set(['queued', 'downloading', 'downloaded', 'imported', 'skipped'])

function downloadDetail(jobId: string, logLines = 25) {
  const row = getJob(jobId)
  if (!row) return null
  const detail = toDetail(row)
  const tracks = detail.target?.tracks ?? []
  const label = (index: number | null) => {
    const track = index === null ? undefined : tracks[index]
    return track ? `${track.disc > 1 ? `${track.disc}-` : ''}${track.track}. ${track.title}` : undefined
  }
  const wanted = detail.target?.wanted ?? tracks.map((track) => track.index)
  const covered = new Set(detail.files.filter((file) => LIVE_OR_DONE.has(file.state)).map((file) => file.trackIndex))
  return {
    ...compactJob(detail),
    // Tracks of the album or song that no file is downloading or has delivered yet.
    missingTracks: tracks.length ? wanted.filter((index) => !covered.has(index)).map(label).filter(Boolean) : undefined,
    files: detail.files.map((file) => ({
      track: label(file.trackIndex),
      file: file.filename.split(/[\\/]/).pop(),
      user: file.username,
      state: file.state,
      percent: ['downloaded', 'imported', 'skipped'].includes(file.state)
        ? 100
        : file.size > 0
          ? Math.min(100, Math.round((file.bytes / file.size) * 100))
          : 0,
      size: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
      speed: file.state === 'downloading' ? rate(file.speed) : undefined,
      queuePosition: file.queuePosition ?? undefined,
      error: file.error ?? undefined,
    })),
    log: detail.log.slice(-logLines).map((entry) => `${new Date(entry.at).toISOString()} ${entry.level === 'info' ? '' : `${entry.level}: `}${entry.message}`),
  }
}

function trackQuality(track: LibraryTrack): string {
  const codec = (track.codec ?? '').split(' ')[0]?.toUpperCase() || 'unknown'
  if (track.lossless && track.bitDepth && track.sampleRate) return `${codec} ${track.bitDepth}/${track.sampleRate / 1000}`
  return track.bitrate ? `${codec} ${track.bitrate} kbps` : codec
}

function candidates(list: ImportCandidate[]) {
  return list.map((candidate) => ({
    catalog_album_id: candidate.source === 'deezer' ? candidate.id : undefined,
    musicbrainz_id: candidate.mbid ?? undefined,
    title: candidate.title,
    artist: candidate.artist,
    year: candidate.year,
    album_tracks: candidate.trackCount,
    files_matched: `${candidate.matched}/${candidate.files}`,
    score: Math.round(candidate.score * 100) / 100,
  }))
}

// Keys stay out of chat transcripts; tools only say whether they're set.
function maskedSettings(settings: Settings) {
  return {
    ...settings,
    checks: {
      ...settings.checks,
      acoustidKey: settings.checks.acoustidKey ? 'set' : config.acoustidKey ? 'set by ACOUSTID_API_KEY' : 'not set',
    },
    jellyfin: { ...settings.jellyfin, apiKey: settings.jellyfin.apiKey ? 'set' : 'not set' },
  }
}

const JOB_GROUPS: Record<string, string[]> = {
  active: ['queued', 'searching', 'downloading', 'processing'],
  wanted: ['wanted'],
  failed: ['failed'],
  completed: ['completed'],
  cancelled: ['cancelled'],
}

const albumChoice = {
  catalog_album_id: z.number().int().optional().describe('Catalog (Deezer) album id'),
  musicbrainz_id: z.string().uuid().optional().describe('MusicBrainz release id'),
}

function choiceFrom(input: { catalog_album_id?: number; musicbrainz_id?: string; as_is?: boolean }) {
  if (input.catalog_album_id) return { albumId: input.catalog_album_id }
  if (input.musicbrainz_id) return { mbid: input.musicbrainz_id }
  if (input.as_is) return { asIs: true as const }
  return null
}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'seeker', version: config.version },
    {
      instructions: [
        'Seeker downloads music from Soulseek into the user’s library, tags it and files it. Everything the web app does is available here.',
        'Getting music: call download with "Artist - Album" or "Artist - Song" (find_match previews what that resolves to without downloading), ' +
          'or search_music / search_musicbrainz first and then download_album / download_track with an id. Downloads run in the background; ' +
          'list_downloads and get_download show progress, and things that can’t be found yet wait in the wishlist (status "wanted") and are retried automatically.',
        'Library: list_library, search_library and get_library_album show what the user owns; upgrade_library_album finds a better copy; ' +
          'get_match_candidates + match_library_album fix badly tagged albums; delete_library_album and delete_library_track delete files.',
        'Importing: list_import_folders, get_match_candidates (with folder_id), then import_folder.',
        'Also: watchlist tools for new releases, get_settings / update_settings, and status, connection and token tools.',
      ].join('\n'),
    },
  )
  const read = { readOnlyHint: true, openWorldHint: true }
  const local = { readOnlyHint: true, openWorldHint: false }
  const destructive = { destructiveHint: true, openWorldHint: false }

  // ---------- finding music ----------

  server.registerTool(
    'search_music',
    {
      title: 'Search the music catalog',
      description: 'Search artists, albums and songs. Results include ids for download_album / download_track and whether the user already owns them.',
      inputSchema: { query: z.string().min(1) },
      annotations: read,
    },
    async ({ query }) =>
      guard(async () => {
        const result = await searchCatalog(query)
        const albums = result.albums.slice(0, 12)
        const years = await albumYears(albums.filter((album) => album.year === null).map((album) => album.id))
        return ok({
          artists: result.artists.slice(0, 5).map((artist) => ({ id: artist.id, name: artist.name, watched: artist.watched })),
          albums: albums.map((album) => ({
            id: album.id,
            title: album.title,
            artist: album.artist,
            year: album.year ?? years[album.id] ?? null,
            type: album.type,
            tracks: album.tracks,
            owned: album.owned,
            download: album.job?.status ?? null,
          })),
          tracks: result.tracks.slice(0, 10).map((track) => ({ id: track.id, title: track.title, artist: track.artist, album: track.album, owned: track.owned })),
        })
      }),
  )

  server.registerTool(
    'find_match',
    {
      title: 'Preview a download',
      description: 'Show what "Artist - Album" or "Artist - Song" would download (the best match and alternatives), without downloading anything.',
      inputSchema: { query: z.string().min(1), kind: z.enum(['auto', 'album', 'track']).default('auto') },
      annotations: read,
    },
    async ({ query, kind }) =>
      guard(async () => {
        const preview = await previewQuery(query, kind)
        const show = (item: NonNullable<typeof preview.best>) => ({
          kind: item.kind,
          source: item.source,
          catalog_id: item.source === 'deezer' ? item.id : undefined,
          musicbrainz_id: item.mbid,
          title: item.title,
          artist: item.artist,
          album: item.album,
          year: item.year,
          tracks: item.tracks ?? undefined,
          confidence: Math.round(item.confidence * 100) / 100,
          owned: item.owned,
        })
        return ok({ best: preview.best ? show(preview.best) : null, alternatives: preview.alternatives.map(show) })
      }),
  )

  server.registerTool(
    'search_musicbrainz',
    {
      title: 'Search MusicBrainz',
      description: 'Find albums the main catalog doesn’t have. Download them with download_album and musicbrainz_id.',
      inputSchema: { query: z.string().min(1).describe('For example "Artist - Album"') },
      annotations: read,
    },
    async ({ query }) =>
      guard(async () =>
        ok(
          (await searchMusicBrainz(query)).map((album) => ({
            musicbrainz_id: album.mbid,
            title: album.title,
            artist: album.artist,
            year: album.year,
            type: album.type,
            tracks: album.tracks,
            owned: album.owned,
          })),
        ),
      ),
  )

  server.registerTool(
    'get_artist',
    {
      title: 'Artist discography',
      description: 'An artist’s popular songs and their albums, EPs and singles, with what the user owns and what is downloading.',
      inputSchema: { artist_id: z.number().int() },
      annotations: read,
    },
    async ({ artist_id }) =>
      guard(async () => {
        const page = await artistPage(artist_id)
        return ok({
          artist: page.artist,
          popular: page.top.map((track) => ({ id: track.id, title: track.title, album: track.album, album_id: track.albumId, owned: track.owned })),
          releases: page.albums.map((album) => ({
            id: album.id,
            title: album.title,
            year: album.year,
            type: album.type,
            tracks: album.tracks,
            owned: album.owned,
            download: album.job?.status ?? undefined,
          })),
        })
      }),
  )

  server.registerTool(
    'get_album',
    {
      title: 'Album details',
      description: 'Tracklist of a catalog album (album_id) or MusicBrainz release (musicbrainz_id), which tracks the user owns, and any download in progress.',
      inputSchema: { album_id: z.number().int().optional(), musicbrainz_id: z.string().uuid().optional() },
      annotations: read,
    },
    async ({ album_id, musicbrainz_id }) =>
      guard(async () => {
        if (!album_id && !musicbrainz_id) return fail('Pass album_id or musicbrainz_id')
        const page = album_id ? await albumPage(album_id) : await mbAlbumPage(musicbrainz_id!)
        return ok({
          album: {
            id: page.album.id || undefined,
            musicbrainz_id: page.album.mbid ?? undefined,
            title: page.album.title,
            artist: page.album.artist,
            year: page.album.year,
            type: page.album.type,
            label: page.album.label,
            genres: page.album.genres.length ? page.album.genres : undefined,
            seconds: Math.round(page.album.duration),
            owned: page.album.owned,
            library_album_id: page.libraryAlbumId,
            download: page.album.job,
          },
          tracks: page.tracks.map((track) => ({
            id: track.id || undefined,
            number: track.track,
            disc: track.disc,
            title: track.title,
            artist: track.artist !== page.album.artist ? track.artist : undefined,
            seconds: Math.round(track.duration),
            owned: track.owned,
          })),
        })
      }),
  )

  // ---------- downloading ----------

  server.registerTool(
    'download',
    {
      title: 'Download music',
      description:
        'Find an album or song in the catalog and download it from Soulseek. Use "Artist - Album" or "Artist - Song". kind "auto" decides whether it is an album or a song.',
      inputSchema: {
        query: z.string().min(1).describe('For example "Radiohead - In Rainbows" or a Deezer album/track URL'),
        kind: z.enum(['auto', 'album', 'track']).default('auto'),
        force: z.boolean().default(false).describe('Download even if it is already in the library'),
      },
    },
    async ({ query, kind, force }) =>
      guard(async () => {
        const { job, resolved } = await queueQuery(query, kind, 'mcp', { force })
        return ok(compactJob(job), `Queued ${resolved.kind} “${resolved.title}” by ${resolved.artist}.`)
      }),
  )

  server.registerTool(
    'download_album',
    {
      title: 'Download an album',
      description: 'Download an album by catalog id (from search_music or get_artist), or by MusicBrainz release id for albums the catalog lacks.',
      inputSchema: { album_id: z.number().int().optional(), musicbrainz_id: z.string().uuid().optional(), force: z.boolean().default(false) },
    },
    async ({ album_id, musicbrainz_id, force }) =>
      guard(async () => {
        if (album_id) return ok(compactJob(await queueAlbum(album_id, 'mcp', { force })), 'Queued.')
        if (musicbrainz_id) return ok(compactJob(await queueMbAlbum(musicbrainz_id, 'mcp', { force })), 'Queued.')
        return fail('Pass album_id or musicbrainz_id')
      }),
  )

  server.registerTool(
    'download_track',
    {
      title: 'Download a song',
      description: 'Download a single song by catalog id.',
      inputSchema: { track_id: z.number().int(), force: z.boolean().default(false) },
    },
    async ({ track_id, force }) => guard(async () => ok(compactJob(await queueTrack(track_id, 'mcp', { force })), 'Queued.')),
  )

  server.registerTool(
    'search_soulseek',
    {
      title: 'Search Soulseek directly',
      description:
        'Raw Soulseek search grouped by user folder. Slow (15-40 s) and uses the shared search budget, so prefer download unless the user wants to pick a specific copy. Pass album_id to see how well each folder matches the album.',
      inputSchema: { query: z.string().min(2), album_id: z.number().int().optional() },
      annotations: read,
    },
    async ({ query, album_id }) =>
      guard(async () => {
        const started = startManualSearch(query, album_id ?? null)
        const deadline = Date.now() + 90_000
        let search = getManualSearch(started.id)
        while (search && !search.complete && Date.now() < deadline) {
          await sleep(1000)
          search = getManualSearch(started.id)
        }
        if (!search) return fail('Search expired')
        return ok({
          state: search.state,
          responses: search.responses,
          folders: search.folders.slice(0, 15).map((folder) => ({
            username: folder.username,
            folder: folder.folder,
            quality: folder.quality,
            matched: folder.matched === null ? undefined : `${folder.matched}/${folder.expected}`,
            freeSlot: folder.freeSlot,
            queue: folder.queue,
            files: folder.files.slice(0, 30).map((file) => ({ filename: file.filename, size: file.size })),
          })),
        })
      }),
  )

  server.registerTool(
    'download_files',
    {
      title: 'Download specific Soulseek files',
      description: 'Download exact files from one user (from search_soulseek). Pass album_id to tag and file them under that album.',
      inputSchema: {
        username: z.string(),
        files: z.array(z.object({ filename: z.string(), size: z.number() })).min(1),
        album_id: z.number().int().optional(),
      },
    },
    async ({ username, files, album_id }) =>
      guard(async () => ok(compactJob(await queueFiles(username, files, { albumId: album_id ?? null }, 'mcp')), 'Queued.')),
  )

  // ---------- downloads and wishlist ----------

  server.registerTool(
    'list_downloads',
    {
      title: 'List downloads',
      description:
        'Downloads in progress (with percent, speed and time left), waiting to retry (the wishlist, status "wanted"), failed, finished or cancelled.',
      inputSchema: {
        status: z.enum(['active', 'wanted', 'failed', 'completed', 'cancelled', 'all']).default('all'),
        limit: z.number().int().min(1).max(300).default(50),
      },
      annotations: local,
    },
    async ({ status, limit }) =>
      guard(async () => ok(listJobs().filter((job) => status === 'all' || JOB_GROUPS[status]!.includes(job.status)).slice(0, limit).map(compactJob))),
  )

  server.registerTool(
    'get_download',
    {
      title: 'Download details',
      description:
        'Progress (percent, speed, time left), which tracks are still missing, each file’s track, state and queue position, and the step-by-step log of one download.',
      inputSchema: { job_id: z.string(), log_lines: z.number().int().min(1).max(500).default(25).describe('How much of the log to include, newest last') },
      annotations: local,
    },
    async ({ job_id, log_lines }) =>
      guard(async () => {
        const detail = downloadDetail(job_id, log_lines)
        return detail ? ok(detail) : fail('No download with that id')
      }),
  )

  server.registerTool(
    'wait_for_download',
    {
      title: 'Wait for a download',
      description:
        'Wait until a download finishes (completed, failed, waiting in the wishlist or cancelled), up to timeout_seconds, then return its details. ' +
        'Returns early when it finishes; finished: false means it is still running, so call again to keep following it.',
      inputSchema: { job_id: z.string(), timeout_seconds: z.number().int().min(1).max(120).default(45) },
      annotations: local,
    },
    async ({ job_id, timeout_seconds }) =>
      guard(async () => {
        const deadline = Date.now() + timeout_seconds * 1000
        let detail = downloadDetail(job_id)
        while (detail && !FINAL.has(detail.status) && Date.now() < deadline) {
          await sleep(1000)
          detail = downloadDetail(job_id)
        }
        if (!detail) return fail('No download with that id')
        return ok({ finished: FINAL.has(detail.status), ...detail })
      }),
  )

  server.registerTool(
    'cancel_download',
    {
      title: 'Cancel a download',
      description: 'Stop a download and remove its partial files.',
      inputSchema: { job_id: z.string() },
      annotations: destructive,
    },
    async ({ job_id }) =>
      guard(async () => {
        await cancelJob(job_id)
        return ok({ cancelled: job_id })
      }),
  )

  server.registerTool(
    'retry_download',
    { title: 'Retry a download', description: 'Try a failed, cancelled or waiting download again now.', inputSchema: { job_id: z.string() } },
    async ({ job_id }) =>
      guard(async () => {
        retryJob(job_id)
        const row = getJob(job_id)
        return row ? ok(compactJob(toDetail(row))) : fail('No download with that id')
      }),
  )

  server.registerTool(
    'retry_wishlist',
    { title: 'Retry the wishlist', description: 'Try every download in the wishlist (status "wanted") again now.', inputSchema: {} },
    async () =>
      guard(async () => {
        const wanted = listJobs().filter((job) => job.status === 'wanted')
        for (const job of wanted) retryJob(job.id)
        return ok({ retrying: wanted.length })
      }),
  )

  server.registerTool(
    'remove_download',
    {
      title: 'Remove a download',
      description: 'Remove a download from the list (and the wishlist), cancelling it first if it is still running.',
      inputSchema: { job_id: z.string() },
      annotations: destructive,
    },
    async ({ job_id }) =>
      guard(async () => {
        if (!getJob(job_id)) return fail('No download with that id')
        await removeJob(job_id)
        return ok({ removed: job_id })
      }),
  )

  server.registerTool(
    'clear_finished_downloads',
    { title: 'Clear finished downloads', description: 'Remove finished and cancelled downloads from the list.', inputSchema: {}, annotations: destructive },
    async () =>
      guard(async () => {
        const count = listJobs().filter((job) => job.status === 'completed' || job.status === 'cancelled').length
        clearFinished()
        return ok({ cleared: count })
      }),
  )

  // ---------- library ----------

  server.registerTool(
    'list_library',
    {
      title: 'Browse the library',
      description: 'Albums (optionally for one artist) or artists in the user’s library.',
      inputSchema: {
        view: z.enum(['albums', 'artists']).default('albums'),
        artist: z.string().optional().describe('Only albums by this album artist'),
        sort: z.enum(['recent', 'artist', 'title', 'year']).default('recent'),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: local,
    },
    async ({ view, artist, sort, limit, offset }) =>
      guard(async () => {
        if (view === 'artists') {
          const artists = listArtists()
          return ok({ total: artists.length, artists: artists.slice(offset, offset + limit).map((item) => ({ name: item.name, albums: item.albums, tracks: item.tracks })) })
        }
        const albums = listAlbums({ sort, artist })
        return ok({
          total: albums.length,
          albums: albums.slice(offset, offset + limit).map((album) => ({
            id: album.id,
            title: album.title,
            artist: album.artist,
            year: album.year,
            tracks: album.trackCount,
            format: album.format,
            catalog_album_id: album.deezerAlbumId ?? undefined,
            musicbrainz_id: album.mbAlbumId ?? undefined,
          })),
        })
      }),
  )

  server.registerTool(
    'search_library',
    {
      title: 'Search the library',
      description: 'Find albums and songs the user already has. Album ids work with the other library tools.',
      inputSchema: { query: z.string().min(1) },
      annotations: local,
    },
    async ({ query }) =>
      guard(async () =>
        ok({
          albums: listAlbums({ q: query })
            .slice(0, 20)
            .map((album) => ({ id: album.id, title: album.title, artist: album.artist, year: album.year, tracks: album.trackCount, format: album.format })),
          tracks: searchTracks(query, 20).map((track) => ({ id: track.id, title: track.title, artist: track.artist, album: track.album, library_album_id: track.albumId })),
        }),
      ),
  )

  server.registerTool(
    'get_library_album',
    {
      title: 'Library album details',
      description: 'Tracks and file quality of an album in the library, whether a better copy can be downloaded, and its catalog link.',
      inputSchema: { library_album_id: z.string() },
      annotations: local,
    },
    async ({ library_album_id }) =>
      guard(async () => {
        const detail = getAlbum(library_album_id)
        if (!detail) return fail('No album with that id in the library')
        return ok({
          album: {
            id: detail.album.id,
            title: detail.album.title,
            artist: detail.album.artist,
            year: detail.album.year,
            format: detail.album.format,
            catalog_album_id: detail.album.deezerAlbumId ?? undefined,
            musicbrainz_id: detail.album.mbAlbumId ?? undefined,
            seconds: Math.round(detail.album.duration),
            has_cover: detail.album.hasCover,
            added: new Date(detail.album.addedAt).toISOString(),
            can_upgrade: detail.canUpgrade,
            needs_matching: detail.unsorted || (!detail.album.deezerAlbumId && !detail.album.mbAlbumId),
          },
          tracks: detail.tracks.map((track) => ({
            id: track.id,
            disc: track.discNo,
            number: track.trackNo,
            title: track.title,
            artist: track.artist,
            seconds: Math.round(track.duration),
            quality: trackQuality(track),
          })),
        })
      }),
  )

  server.registerTool(
    'upgrade_library_album',
    {
      title: 'Find a better copy',
      description: 'Download a better-quality copy of a library album (by your quality settings) and replace the old files.',
      inputSchema: { library_album_id: z.string() },
    },
    async ({ library_album_id }) => guard(async () => ok(compactJob(await upgradeLibraryAlbum(library_album_id)), 'Looking for a better copy.')),
  )

  server.registerTool(
    'get_match_candidates',
    {
      title: 'Suggest matching albums',
      description:
        'Catalog albums that a library album (library_album_id) or an import folder (folder_id) could be, with how many of its files match. Use with match_library_album or import_folder.',
      inputSchema: { library_album_id: z.string().optional(), folder_id: z.string().optional() },
      annotations: read,
    },
    async ({ library_album_id, folder_id }) =>
      guard(async () => {
        if (library_album_id) return ok(candidates(await identifyLibraryAlbum(library_album_id)))
        if (folder_id) return ok(candidates(await identifyImportFolder(folder_id)))
        return fail('Pass library_album_id or folder_id')
      }),
  )

  server.registerTool(
    'match_library_album',
    {
      title: 'Match an album to the catalog',
      description: 'Re-tag, rename and re-file a library album as the given catalog album or MusicBrainz release.',
      inputSchema: { library_album_id: z.string(), ...albumChoice },
    },
    async ({ library_album_id, ...input }) =>
      guard(async () => {
        const choice = choiceFrom(input)
        if (!choice) return fail('Pass catalog_album_id or musicbrainz_id')
        return ok(compactJob(await rematchLibraryAlbum(library_album_id, choice)), 'Re-tagging the album.')
      }),
  )

  server.registerTool(
    'delete_library_album',
    {
      title: 'Delete an album',
      description: 'Delete an album’s files from the music folder. This can’t be undone.',
      inputSchema: { library_album_id: z.string() },
      annotations: destructive,
    },
    async ({ library_album_id }) => guard(async () => ok({ deletedFiles: await deleteLibraryAlbum(library_album_id) })),
  )

  server.registerTool(
    'delete_library_track',
    {
      title: 'Delete a song',
      description: 'Delete one song’s file from the music folder (track ids come from get_library_album or search_library). This can’t be undone.',
      inputSchema: { track_id: z.number().int() },
      annotations: destructive,
    },
    async ({ track_id }) =>
      guard(async () => {
        await deleteLibraryTrack(track_id)
        return ok({ deleted: track_id })
      }),
  )

  server.registerTool(
    'rescan_library',
    { title: 'Rescan the library', description: 'Re-read the music folder, e.g. after changing files outside Seeker.', inputSchema: {} },
    async () =>
      guard(async () => {
        await scanLibrary()
        return ok(appStatus().library, 'Library rescanned.')
      }),
  )

  // ---------- importing ----------

  server.registerTool(
    'list_import_folders',
    {
      title: 'Music waiting to be imported',
      description: 'Album folders in the import folder, with what their tags say.',
      inputSchema: {},
      annotations: local,
    },
    async () =>
      guard(async () => {
        const result = await listImportFolders()
        return ok({
          import_dir: result.dir,
          exists: result.exists,
          folders: result.folders.map((folder) => ({
            folder_id: folder.id,
            path: folder.path,
            artist: folder.artist,
            album: folder.album,
            year: folder.year,
            files: folder.files,
            formats: folder.formats,
          })),
        })
      }),
  )

  server.registerTool(
    'import_folder',
    {
      title: 'Import a folder',
      description:
        'Tag and file an import folder in the library as a catalog album or MusicBrainz release (see get_match_candidates), or as_is with the files’ own tags. mode "copy" keeps the originals.',
      inputSchema: {
        folder_id: z.string(),
        ...albumChoice,
        as_is: z.boolean().optional().describe('Keep the files’ own tags'),
        mode: z.enum(['copy', 'move']).default('copy'),
      },
    },
    async ({ folder_id, mode, ...input }) =>
      guard(async () => {
        const choice = choiceFrom(input)
        if (!choice) return fail('Pass catalog_album_id, musicbrainz_id or as_is: true')
        return ok(compactJob(await importFolder(folder_id, choice, mode)), `${mode === 'copy' ? 'Copying' : 'Moving'} the files into the library.`)
      }),
  )

  // ---------- watchlist ----------

  server.registerTool(
    'list_watchlist',
    { title: 'Followed artists', description: 'Artists whose new releases are downloaded automatically.', inputSchema: {}, annotations: local },
    async () => guard(async () => ok(listWatchlist())),
  )

  server.registerTool(
    'watch_artist',
    {
      title: 'Follow an artist',
      description: 'Automatically download an artist’s new releases. types picks which releases count; following again just updates types.',
      inputSchema: { artist_id: z.number().int(), types: recordTypes.min(1).optional() },
    },
    async ({ artist_id, types }) =>
      guard(async () => {
        const existing = listWatchlist().find((artist) => artist.id === artist_id)
        if (existing) {
          if (types) updateWatch(artist_id, { types })
          return ok(listWatchlist().find((artist) => artist.id === artist_id), 'Already following; updated.')
        }
        return ok(await watchArtist(artist_id, { types }), 'Following.')
      }),
  )

  server.registerTool(
    'unwatch_artist',
    { title: 'Unfollow an artist', description: 'Stop following an artist.', inputSchema: { artist_id: z.number().int() } },
    async ({ artist_id }) =>
      guard(async () => {
        unwatchArtist(artist_id)
        return ok({ unwatched: artist_id })
      }),
  )

  server.registerTool(
    'check_new_releases',
    {
      title: 'Check for new releases',
      description: 'Look for new releases now: from one followed artist (artist_id), or from everyone (runs in the background).',
      inputSchema: { artist_id: z.number().int().optional() },
    },
    async ({ artist_id }) =>
      guard(async () => {
        if (artist_id) return ok({ queued: await checkArtist(artist_id) })
        void checkDueArtists(true)
        return ok({ checking: listWatchlist().length }, 'Checking every followed artist in the background.')
      }),
  )

  // ---------- settings, status and access ----------

  server.registerTool(
    'get_status',
    {
      title: 'Seeker status',
      description:
        'Soulseek connection and sharing, download counts, library size, the search budget, where files live and whether Seeker can write there, and the latest server warnings and errors (the first place to look when something isn’t working).',
      inputSchema: {},
      annotations: local,
    },
    async () =>
      guard(async () =>
        ok({
          ...appStatus(),
          searchBudget: searchBudget(),
          folders: { music: config.musicDir, downloads: config.downloadsDir, import: config.importDir },
          folderProblems: folderProblems(),
          slskdUrl: config.slskdUrl,
          recentProblems: recentProblems(10).map((problem) => ({
            at: new Date(problem.at).toISOString(),
            level: problem.level,
            area: problem.scope,
            message: problem.message,
          })),
        }),
      ),
  )

  server.registerTool(
    'get_settings',
    {
      title: 'Settings',
      description:
        'Quality, file naming, download checks, Jellyfin, watchlist, wishlist and share rescan settings. Keys are shown as set or not set.',
      inputSchema: {},
      annotations: local,
    },
    async () => guard(async () => ok(maskedSettings(getSettings()))),
  )

  server.registerTool(
    'update_settings',
    {
      title: 'Change settings',
      description:
        'Change any settings; only the fields you pass change. quality.formats is the preferred format order. naming.template uses {albumartist} {artist} {album} {year} {track} {disctrack} {title}. shares.autoRescan and shares.quietMinutes control the share rescan Seeker asks slskd for once the library has stopped changing; turn it off for big libraries where rescans make slskd unresponsive.',
      inputSchema: settingsSchema.shape,
    },
    async (patch) =>
      guard(async () => {
        const parsed = settingsSchema.parse(patch) as Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>
        return ok(maskedSettings(updateSettings(parsed)), 'Saved.')
      }),
  )

  server.registerTool(
    'test_jellyfin',
    {
      title: 'Test Jellyfin',
      description: 'Check that Seeker can reach Jellyfin, with the saved settings or the url and api_key given.',
      inputSchema: { url: z.string().optional(), api_key: z.string().optional() },
      annotations: read,
    },
    async ({ url, api_key }) =>
      guard(async () => {
        const saved = getSettings().jellyfin
        const target = url || saved.url
        const key = api_key || saved.apiKey
        if (!target || !key) return fail('Jellyfin isn’t set up; pass url and api_key, or set them with update_settings')
        return ok(await testJellyfin(target, key))
      }),
  )

  server.registerTool(
    'test_acoustid',
    { title: 'Test the AcoustID key', description: 'Check that AcoustID accepts the configured key for fingerprint checks.', inputSchema: {}, annotations: read },
    async () => guard(async () => ok(await testAcoustidKey(getSettings().checks.acoustidKey || config.acoustidKey))),
  )

  server.registerTool(
    'reconnect_soulseek',
    { title: 'Reconnect to Soulseek', description: 'Ask slskd to log in to the Soulseek network again.', inputSchema: {} },
    async () =>
      guard(async () => {
        await slskd.connect()
        return ok({ ok: true }, 'Reconnecting.')
      }),
  )

  server.registerTool(
    'rescan_shares',
    {
      title: 'Rescan shared folders',
      description:
        'Ask slskd to rescan the folders it shares on Soulseek, right away. On a big library this can take minutes, and slskd may not respond meanwhile. Seeker also asks by itself once new music has stopped arriving (settings: shares).',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const result = await rescanSharesNow()
        return ok(result, result.message)
      }),
  )

  server.registerTool(
    'list_tokens',
    { title: 'Access tokens', description: 'Tokens that MCP clients use to reach Seeker.', inputSchema: {}, annotations: local },
    async () => guard(async () => ok(listTokens())),
  )

  server.registerTool(
    'create_token',
    {
      title: 'Create an access token',
      description: 'Create a token for another MCP client. The token is only shown once.',
      inputSchema: { name: z.string().min(1).max(60) },
    },
    async ({ name }) =>
      guard(async () => {
        const { token, info } = createToken(name)
        return ok({ ...info, token }, 'Save this token now; it can’t be shown again.')
      }),
  )

  server.registerTool(
    'revoke_token',
    {
      title: 'Revoke an access token',
      description: 'Revoke a token; clients using it lose access immediately.',
      inputSchema: { token_id: z.string() },
      annotations: destructive,
    },
    async ({ token_id }) =>
      guard(async () => {
        if (!listTokens().some((token) => token.id === token_id)) return fail('No token with that id')
        revokeToken(token_id)
        return ok({ revoked: token_id })
      }),
  )

  return server
}

export async function handleMcp(request: Request): Promise<Response> {
  const server = buildServer()
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    void transport.close()
    void server.close()
  }
}
