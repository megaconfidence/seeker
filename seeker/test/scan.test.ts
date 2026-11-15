// Library scan speed: tags only (no covers, no whole files), several folders and files at a time,
// NAS folders skipped, progress reported, and imports indexed while a full scan runs.
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
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-scan-')))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const dirs = { data: path.join(root, 'data'), music: path.join(root, 'music'), downloads: path.join(root, 'downloads'), import: path.join(root, 'import') }
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))
const ff = (...args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

// Fixtures: a cover image of about 4 MB (noise barely compresses), a FLAC with it embedded, plain
// MP3s of two lengths (the longer one stands for slow files below), and an MP3 made 48 MB long.
const art = path.join(root, 'art.png')
await ff('-f', 'lavfi', '-i', 'nullsrc=s=1200x1200,geq=random(1)*255:random(1)*255:random(1)*255', '-frames:v', '1', art)
const flacWithArt = path.join(root, 'art.flac')
await ff('-f', 'lavfi', '-i', 'anoisesrc=d=2', '-i', art, '-map', '0', '-map', '1', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata', 'title=Painted', flacWithArt)
const mp3 = path.join(root, 'plain.mp3')
await ff('-f', 'lavfi', '-i', 'anoisesrc=d=2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', 'title=Plain', mp3)
const slowMp3 = path.join(root, 'slow.mp3')
await ff('-f', 'lavfi', '-i', 'anoisesrc=d=3', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', 'title=Slow', slowMp3)
const longMp3 = path.join(root, 'long.mp3')
await fs.copyFile(mp3, longMp3)
await fs.truncate(longMp3, 48 * 1024 * 1024)
const sizes = { art: (await fs.stat(art)).size, slow: (await fs.stat(slowMp3)).size }

Object.assign(process.env, {
  SEEKER_DATA_DIR: dirs.data, SEEKER_MUSIC_DIR: dirs.music, SEEKER_DOWNLOADS_DIR: dirs.downloads, SEEKER_IMPORT_DIR: dirs.import,
  SLSKD_URL: 'http://127.0.0.1:9', SLSKD_API_KEY: 'seeker-test-key', SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
})
const { updateSettings } = await import('../server/settings.ts')
updateSettings({ shares: { autoRescan: false } })
const { scanLibrary, scanFiles, libraryStatus, COVER_UNCHECKED } = await import('../server/library/scan.ts')
const { albumCover, listAlbums } = await import('../server/library/serve.ts')
const { all, get, exec } = await import('../server/db.ts')
const { subscribe } = await import('../server/events.ts')
const { writeTags } = await import('../server/post/tag.ts')
const { eachLimit } = await import('../server/util.ts')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
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
}
const row = (file: string) => get<{ title: string; has_cover: number }>('SELECT title, has_cover FROM lib_tracks WHERE path = ?', [file])

// Every byte read from files goes through FileHandle.read (music-metadata reads through strtok3).
const handle = await fs.open(art)
const FileHandle = Object.getPrototypeOf(handle)
await handle.close()
const realRead = FileHandle.read
let bytesRead = 0
let slowReads = false
const handleSizes = new WeakMap<object, number>()
FileHandle.read = async function (this: { stat(): Promise<{ size: number }> }, ...args: unknown[]) {
  if (slowReads) {
    let size = handleSizes.get(this)
    if (size === undefined) {
      size = (await this.stat()).size
      handleSizes.set(this, size)
    }
    if (size === sizes.slow) await sleep(40)
  }
  const result = await realRead.apply(this, args)
  bytesRead += result.bytesRead
  return result
}

test('a scan reads tags, not cover images or whole files', async () => {
  await reset()
  const flac = await put('Painter/Canvas/01 - Painted.flac', flacWithArt)
  const long = await put('Long Player/Endless/01 - Long.mp3', longMp3)
  bytesRead = 0
  const scan = await scanLibrary()
  assert.equal(scan.outcome, 'done', scan.message)
  assert.equal(scan.updated, 2)
  // The FLAC's cover alone is about 4 MB, and the MP3 is 48 MB long.
  assert.ok(sizes.art > 3_000_000, `cover fixture is ${sizes.art} bytes`)
  assert.ok(bytesRead < 256 * 1024, `the scan read ${bytesRead} bytes`)
  assert.equal(row(flac)?.title, 'Painted')
  assert.equal(row(long)?.title, 'Plain')
  // Covers aren't looked at while scanning.
  assert.equal(row(flac)?.has_cover, COVER_UNCHECKED)
})

test('embedded covers are looked for when an album is shown, and the answer is kept', async () => {
  // Continues from the scan above: neither album has a cover image in its folder.
  const albums = listAlbums({ sort: 'title' })
  assert.deepEqual(albums.map((album) => [album.title, album.hasCover]), [['Canvas', true], ['Endless', true]])
  const [canvas, endless] = albums
  const found = await albumCover(canvas!.id)
  assert.equal(found.status, 200)
  assert.ok((await found.arrayBuffer()).byteLength > 1_000_000)
  const missing = await albumCover(endless!.id)
  assert.equal(missing.status, 404)
  assert.deepEqual(
    listAlbums({ sort: 'title' }).map((album) => [album.title, album.hasCover]),
    [['Canvas', true], ['Endless', false]],
  )
  assert.deepEqual(all<{ has_cover: number }>('SELECT has_cover FROM lib_tracks ORDER BY path').map((track) => track.has_cover), [0, 1])
})

test('folders NAS systems keep next to the music are skipped', async () => {
  await reset()
  const kept = await put('Artist/Album/01 - Kept.mp3', mp3)
  for (const relative of [
    'Artist/Album/@eaDir/01 - Kept.mp3/SYNOAUDIO.mp3',
    'Artist/@EaDir/thumb.mp3',
    '#recycle/Artist/Old/01.mp3',
    '#snapshot/GMT+00_2026-11-01/Artist/Album/01 - Kept.mp3',
    '@Recycle/01.mp3',
    '$RECYCLE.BIN/01.mp3',
    'lost+found/01.mp3',
  ]) {
    await put(relative, mp3)
  }
  const scan = await scanLibrary()
  assert.equal(scan.outcome, 'done', scan.message)
  assert.deepEqual(all<{ path: string }>('SELECT path FROM lib_tracks').map((track) => track.path), [kept])
})

test('a scan reports its progress: listing, then reading, then done', async () => {
  await reset()
  for (let i = 1; i <= 30; i++) await put(`Artist/Album ${i % 3}/${String(i).padStart(2, '0')} - Track.mp3`, mp3)
  const seen: ScanProgress[] = []
  const stop = subscribe((event: ServerEvent) => {
    if (event.type === 'library' && event.progress) seen.push(event.progress)
  })
  try {
    assert.equal((await scanLibrary()).updated, 30)
  } finally {
    stop()
  }
  assert.ok(seen.some((progress) => progress.phase === 'listing'), JSON.stringify(seen))
  assert.ok(seen.some((progress) => progress.phase === 'reading' && progress.found === 30 && progress.toRead === 30), JSON.stringify(seen))
  assert.equal(libraryStatus().progress, null)
})

test('a rescan with nothing changed lists each folder once and reads no files', async (t) => {
  // Continues from the scan above: Artist and three album folders under the music folder.
  const readdir = t.mock.method(fs, 'readdir')
  bytesRead = 0
  const scan = await scanLibrary()
  assert.equal(scan.updated, 0)
  assert.equal(readdir.mock.callCount(), 5, 'the music folder, Artist and three albums')
  assert.equal(bytesRead, 0)
})

test('an import during a full scan is indexed without waiting for it, and the scan doesn’t undo it', async () => {
  await reset()
  const imported = await put('A Import/Album/01 - Track.mp3', mp3)
  const slow: string[] = []
  for (let i = 1; i <= 24; i++) slow.push(await put(`Z Slow/Album/${String(i).padStart(2, '0')} - Slow.mp3`, slowMp3))
  await scanLibrary()
  // Everything changes, so the next full scan reads it all: the imported file early, then the slow
  // files hold the scan up.
  writeTags(imported, { title: 'Mid Title', artists: ['Importer'], albumArtist: 'Importer', album: 'Imports', year: null, track: 1, trackCount: 1, disc: 1, discCount: 1, genres: [] })
  const later = new Date(Date.now() + 60_000)
  for (const file of slow) await fs.utimes(file, later, later)
  slowReads = true
  try {
    const scan = scanLibrary()
    const deadline = Date.now() + 10_000
    while ((libraryStatus().progress?.read ?? 0) < 1) {
      assert.ok(Date.now() < deadline, 'the scan never read a file')
      await sleep(10)
    }
    // Then an import replaces it and indexes it, while the scan is still reading the slow files.
    writeTags(imported, { title: 'New Title', artists: ['Importer'], albumArtist: 'Importer', album: 'Imports', year: null, track: 1, trackCount: 1, disc: 1, discCount: 1, genres: [] })
    await scanFiles([imported])
    assert.equal(libraryStatus().scanning, true, 'indexed before the scan finished')
    assert.equal(row(imported)?.title, 'New Title')
    assert.equal((await scan).outcome, 'done')
  } finally {
    slowReads = false
  }
  assert.equal(row(imported)?.title, 'New Title', 'the scan kept what the import indexed')
  assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM lib_tracks')!.n, 25)
})

test('eachLimit runs at most `limit` at once, takes items added on the way, and stops at the first error', async () => {
  let running = 0
  let most = 0
  const done: number[] = []
  await eachLimit([1, 2, 3], 2, async (item, add) => {
    running++
    most = Math.max(most, running)
    if (item < 3) add(item + 10)
    await sleep(5)
    done.push(item)
    running--
  })
  assert.equal(most, 2)
  assert.deepEqual(done.sort((a, b) => a - b), [1, 2, 3, 11, 12])

  const started: number[] = []
  await assert.rejects(
    eachLimit([1, 2, 3, 4, 5], 1, async (item) => {
      started.push(item)
      if (item === 2) throw new Error('second failed')
    }),
    /second failed/,
  )
  assert.deepEqual(started, [1, 2])
})
