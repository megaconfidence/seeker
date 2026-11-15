// Long library scans: what they read is saved in batches as they go, a stopped scan (a first scan
// too) keeps it and the next one picks up from there, and SEEKER_SCAN_CONCURRENCY sets how many
// files are read at once.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { ScanProgress, ServerEvent } from '../shared/types.ts'

const run = promisify(execFile)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-scan-resume-')))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const dirs = { data: path.join(root, 'data'), music: path.join(root, 'music'), downloads: path.join(root, 'downloads'), import: path.join(root, 'import') }
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))
const ff = (...args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

// MP3s of three lengths. Reads of the two longer ones are slowed down or held up below, told
// apart by their size.
const quick = path.join(root, 'quick.mp3')
const slow = path.join(root, 'slow.mp3')
const stuck = path.join(root, 'stuck.mp3')
for (const [file, seconds, title] of [[quick, 1, 'Quick'], [slow, 2, 'Slow'], [stuck, 3, 'Stuck']] as const) {
  await ff('-f', 'lavfi', '-i', `anoisesrc=d=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k', '-metadata', `title=${title}`, file)
}
const sizes = { slow: (await fs.stat(slow)).size, stuck: (await fs.stat(stuck)).size }

Object.assign(process.env, {
  SEEKER_DATA_DIR: dirs.data, SEEKER_MUSIC_DIR: dirs.music, SEEKER_DOWNLOADS_DIR: dirs.downloads, SEEKER_IMPORT_DIR: dirs.import,
  SLSKD_URL: 'http://127.0.0.1:9', SLSKD_API_KEY: 'seeker-test-key', SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
  // A batch at least every 150 ms instead of 15 s, and three files read at once.
  SEEKER_SCAN_BATCH_MS: '150',
  SEEKER_SCAN_CONCURRENCY: '3',
})
const { parseScanConcurrency } = await import('../server/config.ts')
const { exec, get, getMeta } = await import('../server/db.ts')
const { updateSettings } = await import('../server/settings.ts')
updateSettings({ shares: { autoRescan: false } })
const { cancelLibraryScan, libraryCounts, libraryStatus, networkFilesystem, scanLibrary } = await import('../server/library/scan.ts')
const { listAlbums } = await import('../server/library/serve.ts')
const shares = await import('../server/shares.ts')
const { subscribe } = await import('../server/events.ts')

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
const row = (file: string) => get<{ title: string; mtime: number }>('SELECT title, mtime FROM lib_tracks WHERE path = ?', [file])
// noteLibraryChange() saves that slskd's shares need a rescan, every time it's called.
const sharesTold = () => getMeta('shares_pending') === '1'
const forgetShares = () => exec("DELETE FROM meta WHERE key = 'shares_pending'")

// Bytes are read through FileHandle.read. A slow file's first read waits `slowMs`, so each takes
// that long however many reads its tags need; a stuck file's reads wait until `stuckReads` settles.
const handle = await fs.open(quick)
const FileHandle = Object.getPrototypeOf(handle)
await handle.close()
const realRead = FileHandle.read
const handleSizes = new WeakMap<object, number>()
const started = new WeakSet<object>()
let slowMs = 0
let stuckReads: Promise<void> | null = null
let slowNow = 0
let slowMost = 0
FileHandle.read = async function (this: { stat(): Promise<{ size: number }> }, ...args: unknown[]) {
  let size = handleSizes.get(this)
  if (size === undefined) {
    size = (await this.stat()).size
    handleSizes.set(this, size)
  }
  if (size === sizes.slow && slowMs && !started.has(this)) {
    started.add(this)
    slowMost = Math.max(slowMost, ++slowNow)
    await sleep(slowMs)
    slowNow--
  }
  if (size === sizes.stuck && stuckReads) await stuckReads
  return realRead.apply(this, args)
}
function holdStuckFiles(): () => void {
  let answer!: () => void
  stuckReads = new Promise((resolve) => (answer = resolve))
  return () => {
    stuckReads = null
    answer()
  }
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

test('a stopped first scan keeps what it saved and removes nothing; the next scan picks up from there', async () => {
  await reset()
  // With this on, the end of a first scan (noteInitialLibrary) asks for a share rescan right away,
  // so the stopped scans below show that they didn't tell the share rescans anything.
  updateSettings({ shares: { rescanOnFirstScan: true } })
  const quickFiles: string[] = []
  for (let i = 1; i <= 12; i++) quickFiles.push(await put(`A Quick/Album ${Math.ceil(i / 4)}/${pad(i)} - Quick.mp3`, quick))
  for (let i = 1; i <= 6; i++) await put(`Z Slow/Album/${pad(i)} - Slow.mp3`, slow)
  slowMs = 800
  try {
    // Stopped once the quick files are saved, while the slow ones are being read.
    forgetShares()
    const first = scanLibrary()
    await until(() => libraryCounts().tracks >= 12, 'the quick files were never saved during the scan')
    const stopped = await cancelLibraryScan()
    assert.equal(stopped?.outcome, 'cancelled')
    assert.equal(stopped.message, 'Library scan stopped. Seeker keeps what it read and continues from there next time.')
    assert.equal((await first).outcome, 'cancelled')
    assert.equal(libraryStatus().scanning, false)
    assert.ok(libraryCounts().tracks >= 12 && libraryCounts().tracks < 18, `${libraryCounts().tracks} tracks saved`)
    assert.equal(libraryCounts().albums, 3)
    assert.equal(getMeta('library_indexed'), '0', 'still the first scan')
    assert.equal(sharesTold(), false, 'a first scan tells the share rescans once it’s done, not before')

    // A saved file is deleted. The resumed scan, stopped again, keeps its track.
    await fs.rm(quickFiles[0]!)
    const second = scanLibrary()
    await until(() => libraryStatus().progress?.phase === 'reading', 'the second scan never started reading')
    assert.equal((await cancelLibraryScan())?.outcome, 'cancelled')
    assert.equal((await second).removed, 0)
    assert.ok(row(quickFiles[0]!), 'a stopped scan removes nothing')
    assert.equal(getMeta('library_indexed'), '0')
    assert.equal(sharesTold(), false)
  } finally {
    slowMs = 0
  }

  // The next scan reads only the files not saved yet, removes the deleted one, and finishes the
  // first scan. Without rescanOnFirstScan, and before slskd has said what it shares, the end of a
  // first scan waits to hear from slskd, where a later scan would ask for a rescan at once.
  updateSettings({ shares: { rescanOnFirstScan: false } })
  // (The first test's first scan is still waiting to hear; this settles it.)
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 42 })
  shares.noteSlskdShares({ reachable: false, scanning: false, at: Date.now() })
  const saved = libraryCounts().tracks
  const seen: ScanProgress[] = []
  const stop = subscribe((event: ServerEvent) => {
    if (event.type === 'library' && event.progress) seen.push(event.progress)
  })
  let done
  try {
    done = await scanLibrary()
  } finally {
    stop()
  }
  assert.equal(done.outcome, 'done', done.message)
  assert.equal(done.updated, 18 - saved, 'only what the stopped scans hadn’t saved')
  assert.ok(seen.some((progress) => progress.phase === 'reading' && progress.toRead === 18 - saved), JSON.stringify(seen))
  assert.ok(seen.some((progress) => progress.phase === 'committing'), 'the final commit shows as committing')
  assert.equal(done.removed, 1)
  assert.equal(libraryCounts().tracks, 17)
  assert.equal(getMeta('library_indexed'), '1')
  assert.equal(sharesTold(), false, 'treated as the first scan, not as new music')
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 0 })
  assert.equal(sharesTold(), true, 'the finished first scan was waiting to hear what slskd shares')

  // Later scans aren't first scans: new music needs a share rescan even though slskd shares plenty.
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 42 })
  forgetShares()
  await put('A Quick/Album 4/01 - New.mp3', quick)
  assert.equal((await scanLibrary()).updated, 1)
  assert.equal(sharesTold(), true)
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

test('stopping a scan abandons reads that don’t answer, and drops the scan queued after it', async () => {
  await reset()
  for (let i = 1; i <= 3; i++) await put(`Stuck/Album/${pad(i)} - Stuck.mp3`, stuck)
  const answer = holdStuckFiles()
  try {
    const scan = scanLibrary()
    await until(() => !!libraryStatus().progress?.current, 'the scan never started reading')
    assert.equal((await scanLibrary()).outcome, 'queued')
    const stoppingAt = Date.now()
    const stopped = await cancelLibraryScan()
    assert.equal(stopped?.outcome, 'cancelled')
    // The reads never answer: stopping abandons them rather than waiting.
    assert.ok(Date.now() - stoppingAt < 1000, `stopping took ${Date.now() - stoppingAt} ms`)
    assert.equal((await scan).outcome, 'cancelled')
    await sleep(20)
    assert.equal(libraryStatus().scanning, false, 'the queued scan was dropped')
    assert.equal(libraryCounts().tracks, 0)
    assert.equal(await cancelLibraryScan(), null, 'nothing left to stop')
  } finally {
    answer()
  }
})

test('a scan reads as many files at once as SEEKER_SCAN_CONCURRENCY says', async () => {
  await reset()
  for (let i = 1; i <= 8; i++) await put(`Slow/Album/${pad(i)} - Slow.mp3`, slow)
  // Reads that stopped scans abandoned go on in the background for a while.
  await until(() => slowNow === 0, 'reads abandoned by earlier tests never finished')
  slowMs = 40
  slowMost = 0
  try {
    assert.equal((await scanLibrary()).updated, 8)
  } finally {
    slowMs = 0
  }
  assert.equal(slowMost, 3)
})

test('SEEKER_SCAN_CONCURRENCY is a number from 1 to 64; network filesystems are told apart by their statfs type', () => {
  assert.equal(parseScanConcurrency(''), null)
  assert.equal(parseScanConcurrency('8'), 8)
  assert.equal(parseScanConcurrency('1'), 1)
  assert.equal(parseScanConcurrency('2.5'), 2)
  assert.equal(parseScanConcurrency('500'), 64)
  for (const value of ['0', '-4', 'lots']) assert.equal(parseScanConcurrency(value), null, value)

  assert.equal(networkFilesystem(0x6969), 'NFS')
  assert.equal(networkFilesystem(0x517b), 'SMB')
  assert.equal(networkFilesystem(0xfe534d42), 'SMB2')
  assert.equal(networkFilesystem(0x65735546), 'FUSE')
  assert.equal(networkFilesystem(0xff534d42), 'CIFS')
  assert.equal(networkFilesystem(0xff534d42 | 0), 'CIFS', 'reported as a negative 32-bit number')
  assert.equal(networkFilesystem(0xef53), null, 'ext4')
  assert.equal(networkFilesystem(0x01021994), null, 'tmpfs')
  assert.equal(networkFilesystem(0x9123683e), null, 'Btrfs')
})
