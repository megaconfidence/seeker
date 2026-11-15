// Library scans never empty the index because the music folder isn't there: a missing, unreadable
// or empty folder, or one with most tracks gone, leaves the library as it was unless forced.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { FakeSlskd } from './fakes/slskd.ts'

const run = promisify(execFile)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-library-')))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const dirs = {
  data: path.join(root, 'data'),
  downloads: path.join(root, 'downloads'),
  music: path.join(root, 'music'),
  import: path.join(root, 'import'),
  parked: path.join(root, 'parked'),
}
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))

// One second of tone, copied into every track: the scan indexes paths, so the audio can repeat.
const fixture = path.join(root, 'tone.mp3')
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-b:a', '64k', fixture])

const slskd = await new FakeSlskd({ apiKey: 'seeker-test-key', downloadsDir: dirs.downloads }).start()
Object.assign(process.env, {
  SLSKD_URL: slskd.url,
  SLSKD_API_KEY: 'seeker-test-key',
  SEEKER_DATA_DIR: dirs.data,
  SEEKER_DOWNLOADS_DIR: dirs.downloads,
  SEEKER_MUSIC_DIR: dirs.music,
  SEEKER_IMPORT_DIR: dirs.import,
  SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
})

const { updateSettings } = await import('../server/settings.ts')
const { scanLibrary, libraryStatus, musicFolderProblem } = await import('../server/library/scan.ts')
const { get } = await import('../server/db.ts')
const { recentProblems } = await import('../server/log.ts')
updateSettings({ shares: { autoRescan: false } })

after(() => slskd.close())

const asRoot = process.getuid?.() === 0 && 'root can read anywhere'
const indexed = () => get<{ n: number }>('SELECT COUNT(*) AS n FROM lib_tracks')!.n
const albumDir = (n: number) => path.join(dirs.music, `Artist ${n}`, `Album ${n}`)
const exists = (file: string) => fs.access(file).then(
  () => true,
  () => false,
)

// 8 albums of 25 tracks.
for (let album = 1; album <= 8; album++) {
  await fs.mkdir(albumDir(album), { recursive: true })
  for (let track = 1; track <= 25; track++) {
    await fs.copyFile(fixture, path.join(albumDir(album), `${String(track).padStart(2, '0')} - Track ${track}.mp3`))
  }
}

test('a scan indexes the library', async () => {
  const scan = await scanLibrary()
  assert.equal(scan.outcome, 'done', scan.message)
  assert.equal(scan.files, 200)
  assert.equal(indexed(), 200)
  assert.equal(libraryStatus().problem, null)
  assert.equal(await musicFolderProblem(), null)
})

test('a missing music folder keeps the index, even forced, and isn’t created', async () => {
  await fs.rename(dirs.music, `${dirs.music}.off`)
  try {
    for (const force of [false, true]) {
      const scan = await scanLibrary({ force })
      assert.equal(scan.outcome, 'refused')
      assert.match(scan.message, /can’t read the music folder, .*music \(it doesn’t exist\)\. If it’s a network share, check that it’s mounted\. Seeker kept the library as it was\./)
      assert.equal(indexed(), 200)
    }
    assert.equal(await exists(dirs.music), false, 'the scan didn’t create the folder')
    assert.deepEqual(libraryStatus().problem && { ...libraryStatus().problem, message: '' }, { message: '', missing: 200, canForce: false })
    assert.match((await musicFolderProblem()) ?? '', /can’t read the music folder/)
  } finally {
    await fs.rename(`${dirs.music}.off`, dirs.music)
  }
})

test('an empty music folder keeps the index unless forced', async () => {
  await fs.rename(dirs.music, `${dirs.music}.off`)
  await fs.mkdir(dirs.music)
  try {
    const scan = await scanLibrary()
    assert.equal(scan.outcome, 'refused')
    assert.match(scan.message, /is empty, but the library has 200 tracks/)
    assert.equal(indexed(), 200)
    assert.equal(libraryStatus().problem?.canForce, true)
    assert.match((await musicFolderProblem()) ?? '', /is empty, but the library has 200 tracks/)
  } finally {
    await fs.rmdir(dirs.music)
    await fs.rename(`${dirs.music}.off`, dirs.music)
  }
})

test('an unreadable music folder keeps the index', { skip: asRoot }, async () => {
  await fs.chmod(dirs.music, 0o000)
  try {
    const scan = await scanLibrary()
    assert.equal(scan.outcome, 'refused')
    assert.match(scan.message, /can’t read the music folder, .* \(permission denied\)/)
    assert.equal(indexed(), 200)
  } finally {
    await fs.chmod(dirs.music, 0o755)
  }
})

test('an unreadable album folder keeps its tracks while the rest is scanned', { skip: asRoot }, async () => {
  await fs.chmod(albumDir(8), 0o000)
  try {
    const scan = await scanLibrary()
    assert.equal(scan.outcome, 'done', scan.message)
    assert.equal(scan.removed, 0)
    assert.equal(indexed(), 200)
  } finally {
    await fs.chmod(albumDir(8), 0o755)
  }
})

test('an entirely unreadable tree is not empty and cannot be forced away', { skip: asRoot }, async () => {
  for (let album = 1; album <= 8; album++) await fs.chmod(albumDir(album), 0o000)
  try {
    for (const force of [false, true]) {
      const result = await scanLibrary({ force })
      assert.equal(result.outcome, 'refused')
      assert.match(result.message, /couldn’t read folders or files/)
      assert.equal(libraryStatus().problem?.canForce, false)
      assert.equal(indexed(), 200)
    }
  } finally {
    for (let album = 1; album <= 8; album++) await fs.chmod(albumDir(album), 0o755)
  }
  assert.equal((await scanLibrary()).outcome, 'done')
})

for (const code of ['EACCES', 'EIO', 'ESTALE']) {
  test(`file-level stat ${code} keeps the indexed track until access returns`, async (t) => {
    const file = path.join(albumDir(8), '01 - Track 1.mp3')
    const original = fs.stat.bind(fs)
    const stat = t.mock.method(fs, 'stat', (async (...args: Parameters<typeof fs.stat>) => {
      if (args[0] === file) throw Object.assign(new Error(code), { code })
      return original(...args)
    }) as typeof fs.stat)
    try {
      const scan = await scanLibrary()
      assert.equal(scan.removed, 0)
      assert.equal(indexed(), 200)
      assert.ok(get('SELECT path FROM lib_tracks WHERE path = ?', [file]))
      assert.ok(recentProblems().some((problem) => problem.message.includes(file)), 'the unreadable path must be logged')
    } finally {
      stat.mock.restore()
    }
    await fs.utimes(file, new Date(), new Date(Date.now() + 1000))
    const scan = await scanLibrary()
    assert.equal(scan.updated, 1)
    assert.equal(scan.removed, 0)
  })
}

test('an unreadable audio file remains indexed when metadata reading fails', { skip: asRoot }, async () => {
  const file = path.join(albumDir(8), '02 - Track 2.mp3')
  await fs.utimes(file, new Date(), new Date(Date.now() + 2000))
  await fs.chmod(file, 0o000)
  try {
    // chmod prevents reading the file, but generally does not prevent stat.
    const scan = await scanLibrary()
    assert.equal(scan.removed, 0)
    assert.equal(indexed(), 200)
  } finally {
    await fs.chmod(file, 0o644)
  }
  assert.equal((await scanLibrary()).updated, 1)
})

test('deleting one album removes just that album', async () => {
  await fs.rm(path.join(dirs.music, 'Artist 1'), { recursive: true })
  const scan = await scanLibrary()
  assert.equal(scan.outcome, 'done', scan.message)
  assert.equal(scan.removed, 25)
  assert.equal(indexed(), 175)
  assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM lib_tracks WHERE path LIKE ?', [`${albumDir(1)}%`])!.n, 0)
  assert.equal(libraryStatus().problem, null)
})

test('most of the library going missing is refused until forced, and comes back when the files do', async () => {
  // 125 of 175 tracks: more than the 100 (or half the library) a scan removes without asking.
  for (const album of [2, 3, 4, 5, 6]) await fs.rename(path.join(dirs.music, `Artist ${album}`), path.join(dirs.parked, `Artist ${album}`))
  const refused = await scanLibrary()
  assert.equal(refused.outcome, 'refused')
  assert.match(refused.message, /125 of the library’s 175 tracks are missing from the music folder/)
  assert.equal(indexed(), 175)
  const problem = libraryStatus().problem
  assert.deepEqual([problem?.missing, problem?.canForce], [125, true])

  const forced = await scanLibrary({ force: true })
  assert.equal(forced.outcome, 'done', forced.message)
  assert.equal(forced.removed, 125)
  assert.equal(indexed(), 50)
  assert.equal(libraryStatus().problem, null)

  for (const album of [2, 3, 4, 5, 6]) await fs.rename(path.join(dirs.parked, `Artist ${album}`), path.join(dirs.music, `Artist ${album}`))
  const restored = await scanLibrary()
  assert.equal(restored.outcome, 'done', restored.message)
  assert.equal(restored.updated, 125)
  assert.equal(indexed(), 175)
})
