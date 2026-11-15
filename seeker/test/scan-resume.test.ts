// Long library scans: what they read is saved in batches as they go, and a first scan cut off part
// way is still the first scan when it resumes.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-scan-resume-')))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const dirs = { data: path.join(root, 'data'), music: path.join(root, 'music'), downloads: path.join(root, 'downloads'), import: path.join(root, 'import') }
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))
const ff = (...args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

// MP3s of two lengths. Reads of the longer one are slowed down below, told apart by its size.
const quick = path.join(root, 'quick.mp3')
const slow = path.join(root, 'slow.mp3')
for (const [file, seconds, title] of [[quick, 1, 'Quick'], [slow, 2, 'Slow']] as const) {
  await ff('-f', 'lavfi', '-i', `anoisesrc=d=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k', '-metadata', `title=${title}`, file)
}
const sizes = { slow: (await fs.stat(slow)).size }

Object.assign(process.env, {
  SEEKER_DATA_DIR: dirs.data, SEEKER_MUSIC_DIR: dirs.music, SEEKER_DOWNLOADS_DIR: dirs.downloads, SEEKER_IMPORT_DIR: dirs.import,
  SLSKD_URL: 'http://127.0.0.1:9', SLSKD_API_KEY: 'seeker-test-key', SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
  // A batch at least every 150 ms instead of 15 s.
  SEEKER_SCAN_BATCH_MS: '150',
})
const { exec, getMeta } = await import('../server/db.ts')
const { updateSettings } = await import('../server/settings.ts')
updateSettings({ shares: { autoRescan: false } })
const { libraryCounts, libraryStatus, scanLibrary } = await import('../server/library/scan.ts')
const { listAlbums } = await import('../server/library/serve.ts')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000
  while (!check()) {
    assert.ok(Date.now() < deadline, message)
    await sleep(5)
  }
}
async function put(relative: string, fixture: string) {
  const file = path.join(dirs.music, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.copyFile(fixture, file)
  return file
}
async function reset() {
  await fs.rm(dirs.music, { recursive: true, force: true })
  await fs.mkdir(dirs.music)
  exec('DELETE FROM lib_tracks')
  exec('DELETE FROM lib_albums')
  exec("DELETE FROM meta WHERE key IN ('library_indexed', 'shares_pending')")
}
const pad = (n: number) => String(n).padStart(2, '0')
// noteLibraryChange() saves that slskd's shares need a rescan, every time it's called.
const sharesTold = () => getMeta('shares_pending') === '1'
const forgetShares = () => exec("DELETE FROM meta WHERE key = 'shares_pending'")

// Bytes are read through FileHandle.read. A slow file's first read waits `slowMs`, so each takes
// that long however many reads its tags need.
const handle = await fs.open(quick)
const FileHandle = Object.getPrototypeOf(handle)
await handle.close()
const realRead = FileHandle.read
const handleSizes = new WeakMap<object, number>()
const started = new WeakSet<object>()
let slowMs = 0
FileHandle.read = async function (this: { stat(): Promise<{ size: number }> }, ...args: unknown[]) {
  let size = handleSizes.get(this)
  if (size === undefined) {
    size = (await this.stat()).size
    handleSizes.set(this, size)
  }
  if (size === sizes.slow && slowMs && !started.has(this)) {
    started.add(this)
    await sleep(slowMs)
  }
  return realRead.apply(this, args)
}

test('a long scan saves what it has read in batches while it goes on reading', async () => {
  await reset()
  for (let i = 1; i <= 12; i++) await put(`A Quick/Album ${Math.ceil(i / 4)}/${pad(i)} - Quick.mp3`, quick)
  for (let i = 1; i <= 6; i++) await put(`Z Slow/Album/${pad(i)} - Slow.mp3`, slow)
  slowMs = 800
  try {
    const scan = scanLibrary()
    await until(() => libraryCounts().tracks >= 12, 'the quick files were never saved during the scan')
    // Saved with their albums, while the slow files are still being read.
    const status = libraryStatus()
    assert.equal(status.scanning, true)
    assert.equal(status.progress?.phase, 'reading')
    assert.ok(status.progress.read < 18, JSON.stringify(status.progress))
    assert.match(status.progress.current ?? '', /^Z Slow\/Album\/\d\d - Slow\.mp3$/)
    assert.deepEqual(
      listAlbums({ sort: 'title' }).map((album) => [album.title, album.trackCount]),
      [['Album 1', 4], ['Album 2', 4], ['Album 3', 4]],
    )
    assert.equal(getMeta('library_indexed'), '0', 'a first scan isn’t finished until it’s done')
    const done = await scan
    assert.equal(done.outcome, 'done', done.message)
    assert.equal(done.updated, 18)
  } finally {
    slowMs = 0
  }
  assert.equal(libraryCounts().tracks, 18)
  assert.equal(libraryCounts().albums, 4)
  assert.equal(getMeta('library_indexed'), '1')
})

test('a first scan cut off after its last batch still finishes as the first scan, with nothing left to read', async () => {
  await reset()
  for (let i = 1; i <= 3; i++) await put(`Album/${pad(i)} - Quick.mp3`, quick)
  assert.equal((await scanLibrary()).updated, 3)
  // As if Seeker restarted after the last batch was saved, before the final commit.
  exec("UPDATE meta SET value = '0' WHERE key = 'library_indexed'")
  updateSettings({ shares: { rescanOnFirstScan: true } })
  forgetShares()
  const done = await scanLibrary()
  assert.deepEqual([done.outcome, done.updated, done.removed], ['done', 0, 0])
  assert.equal(getMeta('library_indexed'), '1')
  assert.equal(sharesTold(), true, 'the end of the first scan was announced')
  updateSettings({ shares: { rescanOnFirstScan: false } })
})
