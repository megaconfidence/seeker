import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { announcePassword, removeCliToken, verifyToken } from './auth.ts'
import { startBackups } from './backup.ts'
import { config } from './config.ts'
import { db } from './db.ts'
import { startEngine } from './jobs/engine.ts'
import { rebuildOwnedIndex } from './library/owned.ts'
import { startLibraryScanner } from './library/scan.ts'
import { logger } from './log.ts'
import { handleMcp } from './mcp.ts'
import { apiRoutes } from './routes.ts'
import { startStatus } from './status.ts'
import { startWatchlist } from './watchlist.ts'

const log = logger('seeker')
const app = new Hono()

app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
  c.header('X-Frame-Options', 'DENY')
})

app.get('/healthz', (c) => c.text('ok'))
app.route('/api', apiRoutes())

app.all('/mcp', async (c) => {
  if (!verifyToken(c.req.header('authorization'))) {
    return c.json({ error: 'A Seeker token is required (Settings → MCP)' }, 401, {
      'WWW-Authenticate': 'Bearer realm="seeker"',
    })
  }
  return handleMcp(c.req.raw)
})

const webRoot = path.relative(process.cwd(), config.webDir) || '.'
const indexHtml = path.join(config.webDir, 'index.html')

if (fs.existsSync(indexHtml)) {
  app.use(
    '/*',
    serveStatic({
      root: webRoot,
      onFound: (file, c) => {
        if (file.includes(`${path.sep}assets${path.sep}`) || file.includes('/assets/')) {
          c.header('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    }),
  )
  app.get('*', (c) => c.html(fs.readFileSync(indexHtml, 'utf8')))
} else {
  app.get('/', (c) => c.text('The web UI is not built. Run `npm run build`, or use the Vite dev server.'))
}

announcePassword()
removeCliToken()
rebuildOwnedIndex()
startStatus()
startLibraryScanner()
startEngine()
startWatchlist()
startBackups()

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  log.info(`Seeker ${config.version}${config.commit ? ` (${config.commit})` : ''} listening on http://localhost:${info.port}`)
  log.info(`Library: ${config.musicDir} · Downloads: ${config.downloadsDir} · slskd: ${config.slskdUrl}`)
})

function shutdown() {
  log.info('Shutting down')
  server.close()
  try {
    db.close()
  } catch {
    // already closed
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
