// The MCP server through the official client, fully offline: every web-app feature has a tool, and
// a sample of tools work end to end. Run with: node --test test/mcp.test.ts
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { FakeMetadata } from './fakes/metadata.ts'
import { FakeSlskd } from './fakes/slskd.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-mcp-test-'))
const dirs = {
  data: path.join(root, 'data'),
  downloads: path.join(root, 'downloads'),
  music: path.join(root, 'music'),
  import: path.join(root, 'import'),
}
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))

const API_KEY = 'seeker-test-key'
const slskd = await new FakeSlskd({ apiKey: API_KEY, downloadsDir: dirs.downloads }).start()
const metadata = await new FakeMetadata().start()

Object.assign(process.env, {
  SLSKD_URL: slskd.url,
  SLSKD_API_KEY: API_KEY,
  SEEKER_DEEZER_URL: metadata.deezerUrl,
  SEEKER_MUSICBRAINZ_URL: metadata.musicbrainzUrl,
  SEEKER_COVERART_URL: metadata.coverArtUrl,
  SEEKER_DATA_DIR: dirs.data,
  SEEKER_DOWNLOADS_DIR: dirs.downloads,
  SEEKER_MUSIC_DIR: dirs.music,
  SEEKER_IMPORT_DIR: dirs.import,
  SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
})
delete process.env.ACOUSTID_API_KEY

const { handleMcp } = await import('../server/mcp.ts')
const store = await import('../server/jobs/store.ts')
const { logger } = await import('../server/log.ts')

// The client talks to the handler directly instead of over a socket.
const transport = new StreamableHTTPClientTransport(new URL('http://seeker.test/mcp'), {
  fetch: (url, init) => handleMcp(new Request(url, init)),
})
const client = new Client({ name: 'seeker-test', version: '1.0.0' })
await client.connect(transport)

after(async () => {
  await client.close()
  await slskd.close()
  await metadata.close()
  await fs.rm(root, { recursive: true, force: true })
})

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
  const text = result.content.map((item) => item.text ?? '').join('\n')
  // Replies are an optional one-line summary followed by one line of JSON.
  let data: unknown = null
  try {
    data = JSON.parse(text.split('\n').at(-1)!)
  } catch {
    // plain-text errors
  }
  return { text, data: data as Record<string, any>, isError: !!result.isError }
}

test('every web-app feature has an MCP tool', async () => {
  const { tools } = await client.listTools()
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'cancel_download',
    'cancel_library_scan',
    'check_new_releases',
    'clear_finished_downloads',
    'create_token',
    'delete_library_album',
    'delete_library_track',
    'download',
    'download_album',
    'download_files',
    'download_track',
    'find_match',
    'get_album',
    'get_artist',
    'get_download',
    'get_library_album',
    'get_match_candidates',
    'get_settings',
    'get_status',
    'import_folder',
    'list_downloads',
    'list_import_folders',
    'list_library',
    'list_tokens',
    'list_watchlist',
    'match_library_album',
    'reconnect_soulseek',
    'remove_download',
    'rescan_library',
    'rescan_shares',
    'retry_download',
    'retry_wishlist',
    'revoke_token',
    'search_library',
    'search_music',
    'search_musicbrainz',
    'search_soulseek',
    'test_acoustid',
    'test_jellyfin',
    'unwatch_artist',
    'update_settings',
    'upgrade_library_album',
    'wait_for_download',
    'watch_artist',
  ])
  for (const name of ['delete_library_album', 'delete_library_track', 'upgrade_library_album', 'revoke_token', 'remove_download']) {
    assert.equal(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint, true, `${name} is marked destructive`)
  }
  for (const name of ['delete_library_album', 'delete_library_track', 'upgrade_library_album']) {
    assert.match(tools.find((tool) => tool.name === name)?.description ?? '', /[Pp]ermanently/)
    assert.match(tools.find((tool) => tool.name === name)?.description ?? '', /recycle bin/)
  }
  // Stopping a scan keeps what it read and removes nothing, so it isn't destructive.
  const cancel = tools.find((tool) => tool.name === 'cancel_library_scan')?.annotations
  assert.deepEqual([cancel?.destructiveHint, cancel?.idempotentHint, cancel?.readOnlyHint ?? false], [false, true, false])
})

test('status, library and import folders', async () => {
  logger('test').warn('Something went wrong for the test')
  const status = await call('get_status')
  assert.equal(status.isError, false)
  assert.equal(status.data.library.albums, 0)
  assert.equal(typeof status.data.searchBudget.limit, 'number')
  assert.equal(status.data.folders.import, dirs.import)
  assert.deepEqual(
    status.data.recentProblems.map((problem: Record<string, string>) => [problem.level, problem.area, problem.message]).slice(0, 1),
    [['warn', 'test', 'Something went wrong for the test']],
  )

  const library = await call('list_library')
  assert.deepEqual(library.data, { total: 0, albums: [] })

  const folders = await call('list_import_folders')
  assert.equal(folders.data.exists, true)
  assert.deepEqual(folders.data.folders, [])

  assert.deepEqual((await call('list_downloads')).data, [])
  assert.equal((await call('get_library_album', { library_album_id: 'nope' })).isError, true)
})

test('settings: read with keys masked, change one field, reject bad values', async () => {
  const before = await call('get_settings')
  assert.equal(before.data.checks.acoustidKey, 'not set')

  const changed = await call('update_settings', { quality: { minBitrate: 256 }, jellyfin: { apiKey: 'secret-key' } })
  assert.equal(changed.isError, false)
  assert.equal(changed.data.quality.minBitrate, 256)
  assert.deepEqual(changed.data.quality.formats, before.data.quality.formats, 'other fields are kept')
  assert.equal(changed.data.jellyfin.apiKey, 'set', 'the key itself is never returned')
  assert.equal(JSON.stringify(changed.data).includes('secret-key'), false)

  const bad = await call('update_settings', { naming: { template: '{artist}/{album}' } })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /\{title\}/)

  assert.deepEqual(before.data.shares, { autoRescan: true, quietMinutes: 30, rescanOnFirstScan: false })
  const shares = await call('update_settings', { shares: { autoRescan: false } })
  assert.deepEqual(shares.data.shares, { autoRescan: false, quietMinutes: 30, rescanOnFirstScan: false })
  assert.equal((await call('update_settings', { shares: { quietMinutes: 0 } })).isError, true)
  assert.equal((await call('update_settings', { shares: { rescanOnFirstScan: true } })).data.shares.rescanOnFirstScan, true)
})

test('rescan_library says what the scan did, and whether it left the library alone', async () => {
  const result = await call('rescan_library')
  assert.equal(result.isError, false, result.text)
  assert.equal(result.data.scan.outcome, 'done')
  assert.equal(result.data.problem, null)
  assert.equal((await call('get_status')).data.library.problem, null)
})

test('cancel_library_scan stops a running scan, and says so when none is running', async (t) => {
  const idle = await call('cancel_library_scan')
  assert.equal(idle.isError, false, idle.text)
  assert.match(idle.text, /^No library scan is running\./)
  assert.deepEqual([idle.data.scan, idle.data.scanning], [null, false])

  // A scan held up looking at the music folder, as on a share that stopped answering, stops at once.
  const realStat = fs.stat.bind(fs)
  let answer!: () => void
  const unanswered = new Promise<void>((resolve) => (answer = resolve))
  t.mock.method(fs, 'stat', (async (...args: Parameters<typeof fs.stat>) => {
    if (args[0] === dirs.music) await unanswered
    return realStat(...args)
  }) as typeof fs.stat)
  const { scanLibrary } = await import('../server/library/scan.ts')
  const running = scanLibrary()
  const stopped = await call('cancel_library_scan')
  answer()
  assert.equal(stopped.isError, false, stopped.text)
  assert.equal(stopped.data.scan.outcome, 'cancelled')
  assert.match(stopped.text, /^Library scan stopped\. Seeker keeps what it read and continues from there next time\./)
  assert.equal(stopped.data.scanning, false)
  assert.equal((await running).outcome, 'cancelled')
  assert.equal((await call('rescan_library')).data.scan.outcome, 'done', 'the next scan runs normally')
})

test('rescan_shares asks slskd to rescan right away', async () => {
  const before = slskd.shareRescans
  const result = await call('rescan_shares')
  assert.equal(result.isError, false, result.text)
  assert.equal(result.data.started, true)
  assert.equal(slskd.shareRescans, before + 1)
  assert.equal((await call('get_status')).data.shareRescan.running, true)
})

test('tokens: create, list, revoke', async () => {
  const created = await call('create_token', { name: 'Test client' })
  assert.match(created.data.token, /^seeker_/)
  const listed = await call('list_tokens')
  assert.ok((listed.data as unknown as { id: string }[]).some((token) => token.id === created.data.id))
  assert.equal((await call('revoke_token', { token_id: created.data.id })).isError, false)
  const after = await call('list_tokens')
  assert.equal((after.data as unknown as { id: string }[]).some((token) => token.id === created.data.id), false)
  assert.equal((await call('revoke_token', { token_id: created.data.id })).isError, true)
})

test('download progress: percent, speed and time left, per job and per file, and waiting for the end', async () => {
  const MB = 1024 * 1024
  const track = (index: number, title: string) => ({ index, title, artist: 'Tester', disc: 1, track: index + 1, duration: 100 })
  const job = store.insertJob({
    kind: 'album',
    status: 'downloading',
    title: 'Progress Test',
    artist: 'Tester',
    origin: 'watchlist',
    target: { album: { title: 'Progress Test', artist: 'Tester', trackCount: 3, discCount: 1 }, tracks: [track(0, 'One'), track(1, 'Two'), track(2, 'Three')] },
  })
  store.insertFile(job.id, { trackIndex: 0, username: 'peer', filename: 'Music\\Album\\01 One.flac', size: 10 * MB, transferId: null, state: 'downloaded' })
  const second = store.insertFile(job.id, { trackIndex: 1, username: 'peer', filename: 'Music\\Album\\02 Two.flac', size: 10 * MB, transferId: null, state: 'downloading' })
  store.patchFile(second, { bytes: 5 * MB, speed: MB })
  for (const message of ['Queued', 'Searched', 'Downloading 2 tracks']) store.logJob(job.id, 'info', message)

  const active = await call('list_downloads', { status: 'active' })
  const listed = (active.data as unknown as Record<string, any>[]).find((item) => item.id === job.id)!
  assert.deepEqual(listed.progress, { percent: 75, tracks: '1/3 tracks', speed: '1.0 MB/s', timeLeft: 'under a minute' })
  assert.equal(listed.origin, 'watchlist')
  assert.equal(listed.attempts, 0)
  assert.match(listed.createdAt, /^\d{4}-\d{2}-\d{2}T/)

  const detail = await call('get_download', { job_id: job.id, log_lines: 2 })
  assert.deepEqual(
    detail.data.files.map((file: Record<string, unknown>) => [file.track, file.file, file.state, file.percent, file.speed]),
    [
      ['1. One', '01 One.flac', 'downloaded', 100, undefined],
      ['2. Two', '02 Two.flac', 'downloading', 50, '1.0 MB/s'],
    ],
  )
  assert.deepEqual(detail.data.missingTracks, ['3. Three'])
  assert.equal(detail.data.log.length, 2)
  assert.match(detail.data.log[1], /Downloading 2 tracks$/)

  const running = await call('wait_for_download', { job_id: job.id, timeout_seconds: 1 })
  assert.equal(running.data.finished, false)

  store.patchJob(job.id, { status: 'completed' })
  const started = Date.now()
  const done = await call('wait_for_download', { job_id: job.id, timeout_seconds: 30 })
  assert.equal(done.data.finished, true)
  assert.equal(done.data.progress.percent, 100)
  assert.ok(Date.now() - started < 2000, 'returns as soon as the download has finished')

  assert.equal((await call('wait_for_download', { job_id: 'missing' })).isError, true)
})

test('finding music that isn’t in the catalog explains itself', async () => {
  const preview = await call('find_match', { query: 'Nobody - Nothing At All' })
  assert.deepEqual(preview.data, { best: null, alternatives: [] })
  const download = await call('download', { query: 'Nobody - Nothing At All' })
  assert.equal(download.isError, true)
  assert.match(download.text, /No album or song matching/)
})
