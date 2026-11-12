import { config } from './config.ts'
import { logger } from './log.ts'
import { getSettings } from './settings.ts'
import { errorMessage } from './util.ts'

const log = logger('jellyfin')
let timer: ReturnType<typeof setTimeout> | undefined

function baseUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}

async function call(url: string, apiKey: string, path: string, method = 'GET') {
  const response = await fetch(`${baseUrl(url)}${path}`, {
    method,
    headers: {
      // Current Jellyfin only accepts the Authorization header; older servers want X-Emby-Token.
      Authorization: `MediaBrowser Client="Seeker", Device="Seeker", DeviceId="seeker", Version="${config.version}", Token="${apiKey}"`,
      'X-Emby-Token': apiKey,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Jellyfin returned HTTP ${response.status}`)
  return response
}

export async function testJellyfin(url: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await call(url, apiKey, '/System/Info')
    const info = (await response.json()) as { ServerName?: string; Version?: string }
    return { ok: true, message: `Connected to ${info.ServerName ?? 'Jellyfin'} ${info.Version ?? ''}`.trim() }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

// Ask Jellyfin to rescan once things have been quiet for a minute.
export function scheduleJellyfinRefresh() {
  const { url, apiKey } = getSettings().jellyfin
  if (!url || !apiKey) return
  clearTimeout(timer)
  timer = setTimeout(async () => {
    try {
      await call(url, apiKey, '/Library/Refresh', 'POST')
      log.info('Asked Jellyfin to rescan its libraries')
    } catch (error) {
      log.warn(`Could not trigger a Jellyfin rescan: ${errorMessage(error)}`)
    }
  }, 60_000)
}
