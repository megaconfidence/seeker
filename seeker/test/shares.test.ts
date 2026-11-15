// Share rescans: one per burst of library changes once things are quiet, never while downloads run
// or slskd already scans, a follow-up when a running scan may have missed new music, and manual
// rescans at once. slskd is the in-process fake; status polls run every 50 ms.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { FakeSlskd } from './fakes/slskd.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-shares-'))
const dirs = {
  data: path.join(root, 'data'),
  downloads: path.join(root, 'downloads'),
  music: path.join(root, 'music'),
  import: path.join(root, 'import'),
}
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))

const API_KEY = 'seeker-test-key'
const slskd = await new FakeSlskd({ apiKey: API_KEY, downloadsDir: dirs.downloads }).start()

Object.assign(process.env, {
  SLSKD_URL: slskd.url,
  SLSKD_API_KEY: API_KEY,
  SEEKER_DATA_DIR: dirs.data,
  SEEKER_DOWNLOADS_DIR: dirs.downloads,
  SEEKER_MUSIC_DIR: dirs.music,
  SEEKER_IMPORT_DIR: dirs.import,
  SEEKER_STATUS_MS: '50',
  SEEKER_SHARE_MINUTE_MS: '300',
  SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
})

const { updateSettings } = await import('../server/settings.ts')
const shares = await import('../server/shares.ts')
const store = await import('../server/jobs/store.ts')
const { startStatus } = await import('../server/status.ts')
const { exec } = await import('../server/db.ts')
const { slskd: api, SlskdError } = await import('../server/soulseek/slskd.ts')

// Each minute is shortened to 300 ms, without accepting sub-minute settings.
updateSettings({ shares: { autoRescan: true, quietMinutes: 1 } })
startStatus()

after(async () => {
  await slskd.close()
  await fs.rm(root, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(what: string, check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(shares.shareRescanStatus())}`)
    await sleep(20)
  }
}

// Each test starts with nothing planned, pending or running.
async function quiet() {
  await waitFor('earlier rescans to settle', () => {
    const status = shares.shareRescanStatus()
    return !status.pending && !status.running && status.scheduledAt === null && !slskd.scanningShares
  })
}

test('a burst of imports leads to one rescan, once the library has been quiet for a while', async () => {
  await quiet()
  const before = slskd.shareRescans
  for (let i = 0; i < 5; i++) {
    shares.noteLibraryChange()
    await sleep(50)
  }
  assert.equal(slskd.shareRescans, before, 'nothing is asked while music keeps arriving')
  assert.ok(shares.shareRescanStatus().scheduledAt, 'a rescan is planned')
  await waitFor('the rescan', () => slskd.shareRescans === before + 1)
  await sleep(700)
  assert.equal(slskd.shareRescans, before + 1, 'and only one')
  assert.equal(shares.shareRescanStatus().pending, false)
})

test('a scan already running (409) may have missed new music, so Seeker asks again once it ends', async () => {
  await quiet()
  const before = { started: slskd.shareRescans, conflicts: slskd.shareRescanConflicts }
  slskd.startShareScan(400)
  shares.noteLibraryChange()
  const result = await shares.rescanSharesNow()
  assert.deepEqual(result, { started: false, message: 'slskd is already rescanning its shares.' })
  assert.equal(slskd.shareRescanConflicts, before.conflicts + 1)
  assert.equal(shares.shareRescanStatus().pending, true, 'the new music isn’t taken as shared')
  await waitFor('a rescan after the running one', () => slskd.shareRescans === before.started + 1)
  assert.equal(slskd.shareRescanConflicts, before.conflicts + 1, 'no request while it was still scanning')
})

test('slskd’s own rescan is waited out instead of interrupted, then followed by one for the new music', async () => {
  await quiet()
  const before = { started: slskd.shareRescans, conflicts: slskd.shareRescanConflicts }
  slskd.startShareScan(800)
  await waitFor('Seeker to see slskd scanning', () => shares.shareRescanStatus().running)
  shares.noteLibraryChange()
  // The quiet period passes while slskd is still scanning.
  await sleep(500)
  assert.deepEqual([slskd.shareRescans, slskd.shareRescanConflicts], [before.started, before.conflicts])
  await waitFor('a rescan once slskd’s own one ends', () => slskd.shareRescans === before.started + 1)
})

test('a rescan waits while downloads are in progress and follows once they finish', async () => {
  await quiet()
  const before = slskd.shareRescans
  const job = store.insertJob({ kind: 'album', status: 'downloading', title: 'Busy Album', artist: 'Busy Artist', origin: 'ui' })
  shares.noteLibraryChange()
  await waitFor('Seeker to wait for the downloads', () => shares.shareRescanStatus().waitingForDownloads)
  await sleep(300)
  assert.equal(slskd.shareRescans, before, 'nothing is asked while downloading')
  store.patchJob(job.id, { status: 'completed', completed_at: Date.now() })
  await waitFor('the rescan', () => slskd.shareRescans === before + 1)
})

test('with automatic rescans off, changes wait; turning them back on asks for the rescan', async () => {
  await quiet()
  updateSettings({ shares: { autoRescan: false } })
  const before = slskd.shareRescans
  shares.noteLibraryChange()
  await sleep(700)
  assert.equal(slskd.shareRescans, before)
  const status = shares.shareRescanStatus()
  assert.deepEqual([status.pending, status.scheduledAt], [true, null])
  updateSettings({ shares: { autoRescan: true } })
  await waitFor('the rescan once they’re back on', () => slskd.shareRescans === before + 1)
})

test('manual rescans start at once, even with automatic rescans off', async () => {
  await quiet()
  updateSettings({ shares: { autoRescan: false } })
  try {
    const before = slskd.shareRescans
    assert.deepEqual(await shares.rescanSharesNow(), { started: true, message: 'slskd is rescanning its shares.' })
    assert.equal(slskd.shareRescans, before + 1)
  } finally {
    updateSettings({ shares: { autoRescan: true } })
  }
})

for (const fresh of [false, true]) {
  test(`a timeout with ${fresh ? 'fresh' : 'stale'} idle evidence ${fresh ? 'covers the change' : 'keeps the rescan pending'}`, async (t) => {
    await quiet()
    shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now() - (fresh ? 0 : 1000) })
    shares.noteLibraryChange()
    const before = slskd.shareRescans
    const request = t.mock.method(api, 'rescanShares', async () => { throw new SlskdError('timed out', 0, true) })
    try {
      await shares.rescanSharesNow()
      assert.equal(shares.shareRescanStatus().pending, !fresh)
    } finally {
      request.mock.restore()
    }
    shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now() + 1 })
    if (!fresh) {
      assert.ok(shares.shareRescanStatus().scheduledAt! > Date.now(), 'follow-up must wait, not loop immediately')
      await waitFor('the follow-up rescan', () => slskd.shareRescans === before + 1)
    } else {
      assert.equal(shares.shareRescanStatus().scheduledAt, null)
    }
    await quiet()
  })
}

test('shares count as lost when they drop to nothing, or are nothing at the first look; not while they stay empty', () => {
  assert.equal(shares.sharesLost(42, 0), true)
  assert.equal(shares.sharesLost(null, 0), true)
  assert.equal(shares.sharesLost(0, 0), false)
  assert.equal(shares.sharesLost(null, 42), false)
  assert.equal(shares.sharesLost(0, 42), false)
})

// The library needs music for lost shares to matter.
async function withLibraryTrack(run: () => Promise<void>) {
  exec(
    `INSERT INTO lib_tracks (path, album_id, mtime, size, title, artist, album, album_artist, norm_artist, norm_title, has_cover, added_at)
     VALUES (?, 'album', 0, 0, 'Song', 'Artist', 'Album', 'Artist', 'artist', 'song', 0, 0)`,
    [path.join(dirs.music, 'song.mp3')],
  )
  try {
    await run()
  } finally {
    slskd.sharedFiles = 42
    exec('DELETE FROM lib_tracks')
  }
}

test('slskd losing its shares asks for one rescan, not one per poll', async () => {
  await quiet()
  await withLibraryTrack(async () => {
    const before = slskd.shareRescans
    slskd.sharedFiles = 0
    await waitFor('a rescan for the lost shares', () => slskd.shareRescans === before + 1)
    // Polls every 50 ms keep reporting nothing shared, long past the 300 ms quiet period.
    await sleep(800)
    assert.equal(slskd.shareRescans, before + 1)
    assert.equal(shares.shareRescanStatus().scheduledAt, null)
  })
})

test('nothing shared while slskd is scanning isn’t taken as lost shares', async () => {
  await quiet()
  await withLibraryTrack(async () => {
    const before = slskd.shareRescans
    slskd.startShareScan(500)
    slskd.sharedFiles = 0
    await sleep(250)
    slskd.sharedFiles = 42
    await waitFor('slskd’s scan to end', () => !slskd.scanningShares && !shares.shareRescanStatus().running)
    await sleep(500)
    assert.equal(slskd.shareRescans, before)
  })
})

test('legacy zero quiet periods are normalized and never schedule an immediate follow-up', async () => {
  await quiet()
  const settings = updateSettings({ shares: { quietMinutes: 0 } })
  assert.equal(settings.shares.quietMinutes, 1)
  shares.noteLibraryChange()
  const at = shares.shareRescanStatus().scheduledAt!
  assert.ok(at >= Date.now() + 200)
  updateSettings({ shares: { autoRescan: false } })
  await shares.rescanSharesNow()
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now() + 1 })
  updateSettings({ shares: { autoRescan: true } })
})
