import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { ServerEvent, Settings } from '../shared/types.ts'
import {
  checkPassword,
  clearLoginFailures,
  createSession,
  createToken,
  destroySession,
  hasSession,
  listTokens,
  loginBlockedFor,
  recordLoginFailure,
  requireSession,
  revokeToken,
} from './auth.ts'
import {
  albumPage,
  albumYears,
  artistPage,
  mbAlbumPage,
  NotFoundError,
  previewQuery,
  searchCatalog,
  searchMusicBrainz,
} from './catalog.ts'
import { config } from './config.ts'
import { subscribe } from './events.ts'
import { folderProblems } from './folders.ts'
import { testJellyfin } from './jellyfin.ts'
import { testAcoustidKey } from './post/verify.ts'
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
import { albumCover, getAlbum, listAlbums, listArtists, searchTracks, streamTrack } from './library/serve.ts'
import { deezer } from './metadata/deezer.ts'
import { getSettings, updateSettings } from './settings.ts'
import { getManualSearch, startManualSearch } from './soulseek/manual.ts'
import { searchBudget } from './soulseek/search.ts'
import { slskd } from './soulseek/slskd.ts'
import { choiceSchema, recordTypes, settingsSchema } from './schemas.ts'
import { rescanSharesNow } from './shares.ts'
import { appStatus } from './status.ts'
import { checkArtist, checkDueArtists, listWatchlist, unwatchArtist, updateWatch, watchArtist } from './watchlist.ts'

// The login rate limit goes by the connecting address. X-Forwarded-For is ignored on purpose:
// anyone could send a new one with every attempt and dodge the limit.
function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const jobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('album'), albumId: z.number().int(), force: z.boolean().optional() }),
  z.object({ type: z.literal('mbAlbum'), mbid: z.string().uuid(), force: z.boolean().optional() }),
  z.object({ type: z.literal('track'), trackId: z.number().int(), force: z.boolean().optional() }),
  z.object({
    type: z.literal('query'),
    query: z.string().min(1).max(300),
    kind: z.enum(['auto', 'album', 'track']).default('auto'),
    force: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('files'),
    username: z.string().min(1),
    files: z.array(z.object({ filename: z.string().min(1), size: z.number().min(0) })).min(1).max(500),
    albumId: z.number().int().nullable().optional(),
  }),
])

function idParam(c: Context): number {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid id')
  return id
}

class HttpError extends Error {
  status: 400 | 404 | 409
  constructor(status: 400 | 404 | 409, message: string) {
    super(message)
    this.status = status
  }
}

export function apiRoutes() {
  const api = new Hono()

  api.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status)
    if (error instanceof AlreadyOwnedError) return c.json({ error: error.message, owned: true }, 409)
    if (error instanceof NotFoundError) return c.json({ error: error.message, suggestions: error.suggestions }, 404)
    if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? 'Invalid request' }, 400)
    console.error(error)
    return c.json({ error: error.message || 'Something went wrong' }, 500)
  })

  api.post('/auth/login', async (c) => {
    const ip = clientIp(c)
    const wait = loginBlockedFor(ip)
    if (wait) return c.json({ error: `Too many attempts. Try again in ${wait} s.` }, 429)
    const body = await c.req.json<{ password?: string }>().catch(() => ({ password: '' }))
    if (!body.password || !checkPassword(body.password)) {
      recordLoginFailure(ip)
      return c.json({ error: 'Wrong password' }, 401)
    }
    clearLoginFailures(ip)
    createSession(c)
    return c.json({ ok: true })
  })

  api.post('/auth/logout', (c) => {
    destroySession(c)
    return c.json({ ok: true })
  })

  api.get('/auth/me', (c) => c.json({ loggedIn: hasSession(c) }))

  api.use('*', requireSession)

  api.get('/status', (c) => c.json(appStatus()))

  api.post('/slskd/connect', async (c) => {
    await slskd.connect()
    return c.json({ ok: true })
  })
  api.post('/slskd/rescan', async (c) => c.json(await rescanSharesNow()))

  api.get('/info', (c) =>
    c.json({
      version: config.version,
      commit: config.commit || null,
      musicDir: config.musicDir,
      downloadsDir: config.downloadsDir,
      importDir: config.importDir,
      folderProblems: folderProblems(),
      slskdUrl: config.slskdUrl,
      acoustidFromEnv: !!config.acoustidKey,
      searchBudget: searchBudget(),
    }),
  )

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = []
      let wake: (() => void) | null = null
      let open = true
      const unsubscribe = subscribe((event) => {
        queue.push(event)
        wake?.()
      })
      stream.onAbort(() => {
        open = false
        unsubscribe()
        wake?.()
      })
      await stream.writeSSE({ data: JSON.stringify({ type: 'status', status: appStatus() }) })
      while (open) {
        if (queue.length === 0) {
          await Promise.race([new Promise<void>((resolve) => (wake = resolve)), stream.sleep(25_000)])
          wake = null
          if (queue.length === 0 && open) {
            await stream.writeSSE({ event: 'ping', data: '' })
            continue
          }
        }
        while (queue.length && open) await stream.writeSSE({ data: JSON.stringify(queue.shift()) })
      }
    }),
  )

  api.get('/catalog/search', async (c) => {
    const q = c.req.query('q')?.trim()
    if (!q) return c.json({ artists: [], albums: [], tracks: [] })
    return c.json(await searchCatalog(q))
  })
  api.get('/catalog/artist/:id', async (c) => c.json(await artistPage(idParam(c))))
  api.get('/catalog/album/:id', async (c) => c.json(await albumPage(idParam(c))))
  api.get('/catalog/track/:id/preview', async (c) => {
    const url = await deezer.previewUrl(idParam(c))
    if (!url) throw new HttpError(404, 'No preview for this song')
    return c.redirect(url, 302)
  })
  api.get('/catalog/preview', async (c) => {
    const q = c.req.query('q')?.trim()
    if (!q) throw new HttpError(400, 'Type something to search for')
    const kind = z.enum(['auto', 'album', 'track']).catch('auto').parse(c.req.query('kind'))
    return c.json(await previewQuery(q, kind))
  })
  api.get('/catalog/years', async (c) => {
    const ids = (c.req.query('ids') ?? '')
      .split(',')
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
    return c.json(await albumYears(ids))
  })
  api.get('/catalog/mb/search', async (c) => {
    const q = c.req.query('q')?.trim()
    return c.json(q ? await searchMusicBrainz(q) : [])
  })
  api.get('/catalog/mb/album/:mbid', async (c) => {
    const mbid = z.string().uuid().parse(c.req.param('mbid'))
    return c.json(await mbAlbumPage(mbid))
  })

  api.get('/jobs', (c) => c.json(listJobs()))
  api.get('/jobs/:id', (c) => {
    const row = getJob(c.req.param('id'))
    if (!row) throw new HttpError(404, 'Download not found')
    return c.json(toDetail(row))
  })
  api.post('/jobs', async (c) => {
    const body = jobSchema.parse(await c.req.json())
    switch (body.type) {
      case 'album':
        return c.json({ job: await queueAlbum(body.albumId, 'ui', { force: body.force }) })
      case 'mbAlbum':
        return c.json({ job: await queueMbAlbum(body.mbid, 'ui', { force: body.force }) })
      case 'track':
        return c.json({ job: await queueTrack(body.trackId, 'ui', { force: body.force }) })
      case 'query':
        return c.json(await queueQuery(body.query, body.kind, 'ui', { force: body.force }))
      case 'files':
        return c.json({ job: await queueFiles(body.username, body.files, { albumId: body.albumId ?? null }, 'manual') })
    }
  })
  api.post('/jobs/clear', (c) => {
    clearFinished()
    return c.json({ ok: true })
  })
  api.post('/jobs/:id/cancel', async (c) => {
    await cancelJob(c.req.param('id'))
    return c.json({ ok: true })
  })
  api.post('/jobs/:id/retry', (c) => {
    retryJob(c.req.param('id'))
    return c.json({ ok: true })
  })
  api.delete('/jobs/:id', async (c) => {
    await removeJob(c.req.param('id'))
    return c.json({ ok: true })
  })

  api.post('/soulseek/search', async (c) => {
    const body = z
      .object({ query: z.string().trim().min(2).max(200), albumId: z.number().int().nullable().optional() })
      .parse(await c.req.json())
    return c.json(startManualSearch(body.query, body.albumId ?? null))
  })
  api.get('/soulseek/search/:id', (c) => {
    const search = getManualSearch(c.req.param('id'))
    if (!search) throw new HttpError(404, 'Search expired')
    return c.json(search)
  })

  api.get('/library/albums', (c) =>
    c.json(listAlbums({ q: c.req.query('q'), artist: c.req.query('artist'), sort: c.req.query('sort') })),
  )
  api.get('/library/albums/:id', (c) => {
    const album = getAlbum(c.req.param('id'))
    if (!album) throw new HttpError(404, 'Album not found')
    return c.json(album)
  })
  api.get('/library/albums/:id/cover', (c) => albumCover(c.req.param('id')))
  api.get('/library/artists', (c) => c.json(listArtists()))
  api.get('/library/tracks', (c) => c.json(searchTracks(c.req.query('q') ?? '')))
  api.get('/library/tracks/:id/stream', (c) => streamTrack(idParam(c), c.req.header('range')))
  api.post('/library/scan', async (c) => {
    const body = await c.req.json<{ force?: unknown }>().catch(() => ({ force: false }))
    void scanLibrary({ force: body.force === true })
    return c.json({ ok: true })
  })
  api.delete('/library/albums/:id', async (c) => c.json({ deleted: await deleteLibraryAlbum(c.req.param('id')) }))
  api.delete('/library/tracks/:id', async (c) => {
    await deleteLibraryTrack(idParam(c))
    return c.json({ ok: true })
  })
  api.post('/library/albums/:id/upgrade', async (c) => c.json({ job: await upgradeLibraryAlbum(c.req.param('id')) }))
  api.get('/library/albums/:id/candidates', async (c) => c.json(await identifyLibraryAlbum(c.req.param('id'))))
  api.post('/library/albums/:id/match', async (c) => {
    const choice = choiceSchema.parse(await c.req.json())
    return c.json({ job: await rematchLibraryAlbum(c.req.param('id'), choice) })
  })

  api.get('/import', async (c) => c.json(await listImportFolders()))
  api.post('/import/:id/identify', async (c) => c.json(await identifyImportFolder(c.req.param('id'))))
  api.post('/import/:id', async (c) => {
    const body = z.object({ choice: choiceSchema, mode: z.enum(['copy', 'move']).default('copy') }).parse(await c.req.json())
    return c.json({ job: await importFolder(c.req.param('id'), body.choice, body.mode) })
  })

  api.get('/watchlist', (c) => c.json(listWatchlist()))
  api.post('/watchlist', async (c) => {
    const body = z.object({ artistId: z.number().int() }).parse(await c.req.json())
    return c.json(await watchArtist(body.artistId))
  })
  api.put('/watchlist/:id', async (c) => {
    const body = z.object({ types: recordTypes.min(1) }).parse(await c.req.json())
    updateWatch(idParam(c), body)
    return c.json({ ok: true })
  })
  api.delete('/watchlist/:id', (c) => {
    unwatchArtist(idParam(c))
    return c.json({ ok: true })
  })
  api.post('/watchlist/check', (c) => {
    void checkDueArtists(true)
    return c.json({ ok: true })
  })
  api.post('/watchlist/:id/check', async (c) => c.json({ queued: await checkArtist(idParam(c)) }))

  api.get('/settings', (c) => c.json(getSettings()))
  api.put('/settings', async (c) => {
    const patch = settingsSchema.parse(await c.req.json()) as Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>
    return c.json(updateSettings(patch))
  })
  api.post('/settings/jellyfin/test', async (c) => {
    const body = z.object({ url: z.string().min(1), apiKey: z.string().min(1) }).parse(await c.req.json())
    return c.json(await testJellyfin(body.url, body.apiKey))
  })
  api.post('/settings/acoustid/test', async () => {
    const key = getSettings().checks.acoustidKey || config.acoustidKey
    return Response.json(await testAcoustidKey(key))
  })

  api.get('/tokens', (c) => c.json(listTokens()))
  api.post('/tokens', async (c) => {
    const body = z.object({ name: z.string().max(60).default('Token') }).parse(await c.req.json())
    return c.json(createToken(body.name))
  })
  api.delete('/tokens/:id', (c) => {
    revokeToken(c.req.param('id'))
    return c.json({ ok: true })
  })

  return api
}
