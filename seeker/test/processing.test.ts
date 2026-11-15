import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { parseFile } from 'music-metadata'
import { FakeSlskd } from './fakes/slskd.ts'

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-processing-')))
const dirs = { data: path.join(root, 'data'), downloads: path.join(root, 'downloads'), music: path.join(root, 'music'), import: path.join(root, 'import') }
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir)))
const fixture = path.join(root, 'song.mp3')
await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=1:seed=7', '-b:a', '128k', '-metadata', 'artist=Test Artist', '-metadata', 'album=Waiting Album', '-metadata', 'title=Song', fixture])
const fake = await new FakeSlskd({ apiKey: 'seeker-test-key', downloadsDir: dirs.downloads }).start()
Object.assign(process.env, {
  SEEKER_DATA_DIR: dirs.data, SEEKER_DOWNLOADS_DIR: dirs.downloads, SEEKER_MUSIC_DIR: dirs.music, SEEKER_IMPORT_DIR: dirs.import,
  SLSKD_URL: fake.url, SLSKD_API_KEY: 'seeker-test-key', SEEKER_LOG_LEVEL: 'error',
})
delete process.env.ACOUSTID_API_KEY
const { updateSettings } = await import('../server/settings.ts')
updateSettings({ checks: { duration: false, integrity: false, fakeLossless: false }, shares: { autoRescan: false } })
const store = await import('../server/jobs/store.ts')
const engine = await import('../server/jobs/engine.ts')
const { musicFolderProblem, scanLibrary } = await import('../server/library/scan.ts')
const { db, get } = await import('../server/db.ts')
const { writeTags } = await import('../server/post/tag.ts')
after(async () => {
  await fake.close()
  await fs.rm(root, { recursive: true, force: true })
})
const asRoot = process.getuid?.() === 0 && 'root bypasses mode-based permissions'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean) {
  const end = Date.now() + 10_000
  while (!check()) {
    assert.ok(Date.now() < end, 'processing did not reach the expected state')
    await sleep(20)
  }
}

async function downloaded(title: string, count = 1) {
  updateSettings({ naming: { template: `{albumartist}/{album} ${title}/{disctrack} - {title}` } })
  const job = store.insertJob({ kind: 'files', status: 'processing', title, artist: 'Test Artist', origin: 'ui' })
  store.patchJob(job.id, { next_retry_at: Date.now() + 60_000 })
  const dir = path.join(dirs.downloads, 'seeker', job.id)
  await fs.mkdir(dir, { recursive: true })
  const files: string[] = []
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `${i + 1}.mp3`)
    await fs.copyFile(fixture, file)
    files.push(file)
    store.insertFile(job.id, { trackIndex: null, username: 'peer', filename: `Album\\${i + 1}.mp3`, size: (await fs.stat(file)).size, transferId: null, state: 'downloaded' })
  }
  return { job, dir, files }
}

// A one-track album job, so the download is tagged before it's filed.
async function downloadedAlbum(title: string) {
  updateSettings({ naming: { template: '{albumartist}/{album}/{disctrack} - {title}' } })
  const target = {
    album: { title, artist: 'Test Artist', trackCount: 1, discCount: 1, mbChecked: true },
    tracks: [{ index: 0, title: 'Song', artist: 'Test Artist', disc: 1, track: 1, duration: 1 }],
  }
  const job = store.insertJob({ kind: 'album', status: 'processing', title, artist: 'Test Artist', origin: 'ui', target })
  store.patchJob(job.id, { next_retry_at: Date.now() + 60_000 })
  const dir = path.join(dirs.downloads, 'seeker', job.id)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, '01 - Song.mp3')
  await fs.copyFile(fixture, file)
  store.insertFile(job.id, { trackIndex: 0, username: 'peer', filename: 'Album\\01 - Song.mp3', size: (await fs.stat(file)).size, transferId: null, state: 'downloaded' })
  return { job, dir, file, filed: path.join(dirs.music, 'Test Artist', title, '01 - Song.mp3') }
}

// The fixtures share their tags, so both files would be filed under the same name. Retagging the
// second gives it a destination of its own.
async function distinctSecondTrack(jobId: string, file: string) {
  writeTags(file, { title: 'Second Song', artists: ['Test Artist'], albumArtist: 'Test Artist', album: 'Waiting Album', year: null, track: 2, trackCount: 2, disc: 1, discCount: 1, genres: [] })
  store.patchFile(store.jobFiles(jobId)[1]!.id, { size: (await fs.stat(file)).size })
}

const logOf = (jobId: string) => store.toDetail(store.getJob(jobId)!).log.map((entry) => entry.message)
const REJECT_ALBUMS = "CREATE TEMP TRIGGER reject_album BEFORE INSERT ON lib_albums BEGIN SELECT RAISE(ABORT, 'injected album failure'); END"

const noSpace = (code = 'ENOSPC') => Object.assign(new Error(`${code}: no space left on device`), { code })
const MUSIC = 'Waiting for the music folder'
const SPACE = 'Waiting for free space'

async function waiting(jobId: string, phase = MUSIC) {
  engine.retryJob(jobId)
  await waitFor(() => store.getJob(jobId)?.next_retry_at !== null && !!store.getJob(jobId)?.error)
  const job = store.getJob(jobId)!
  assert.equal(job.status, 'processing')
  assert.equal(store.toJob(job).phase, phase)
  assert.ok(job.next_retry_at! > Date.now())
}

async function resume(jobId: string) {
  const batches = fake.batches.length
  engine.retryJob(jobId)
  await waitFor(() => store.getJob(jobId)?.status === 'completed')
  assert.equal(fake.batches.length, batches, 'resuming must not enqueue another download')
  assert.ok(store.jobFiles(jobId).every((file) => ['imported', 'skipped'].includes(file.state)))
}

test('a populated read-only music folder rejects processing before any move, then resumes', { skip: asRoot }, async (t) => {
  await fs.writeFile(path.join(dirs.music, 'sentinel'), '')
  const { job, files } = await downloaded('Read only')
  await fs.chmod(dirs.music, 0o555)
  const rename = t.mock.method(fs, 'rename')
  try {
    const problem = await musicFolderProblem()
    assert.match(problem ?? '', /permission denied/)
    assert.match(problem ?? '', /New music can’t be filed/)
    assert.match(problem ?? '', /user \d+ and group \d+/)
    await waiting(job.id)
    assert.equal(rename.mock.callCount(), 0)
    assert.deepEqual(store.jobFiles(job.id).map((file) => file.state), ['downloaded'])
    assert.deepEqual(await fs.readFile(files[0]!), await fs.readFile(fixture))
  } finally {
    rename.mock.restore()
    await fs.chmod(dirs.music, 0o755)
  }
  await resume(job.id)
})

for (const empty of [false, true]) {
  test(`an ${empty ? 'empty' : 'unmounted'} music folder preserves downloads until it returns`, async () => {
    const { job, files } = await downloaded(empty ? 'Empty mount' : 'Missing mount')
    await fs.rename(dirs.music, `${dirs.music}.off`)
    if (empty) await fs.mkdir(dirs.music)
    try {
      await waiting(job.id)
      assert.deepEqual(store.jobFiles(job.id).map((file) => file.state), ['downloaded'])
      await fs.access(files[0]!)
    } finally {
      if (empty) await fs.rmdir(dirs.music)
      await fs.rename(`${dirs.music}.off`, dirs.music)
    }
    await resume(job.id)
  })
}

test('a read-only album destination preserves downloaded files', { skip: asRoot }, async () => {
  const { job, files } = await downloaded('Locked album')
  const album = path.join(dirs.music, 'Test Artist', 'Waiting Album Locked album')
  await fs.mkdir(album, { recursive: true })
  await fs.chmod(album, 0o555)
  try {
    await waiting(job.id)
    await fs.access(files[0]!)
    assert.equal(store.jobFiles(job.id)[0]!.state, 'downloaded')
  } finally {
    await fs.chmod(album, 0o755)
  }
  await resume(job.id)
})

const DESTINATION_ERRORS: [string, string][] = [
  ...['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ESTALE', 'EIO', 'ETIMEDOUT', 'ENOTCONN'].map((code): [string, string] => [code, MUSIC]),
  ['ENOSPC', SPACE],
  ['EDQUOT', SPACE],
]

for (const [code, phase] of DESTINATION_ERRORS) {
  test(`a destination ${code} preserves the remaining downloads after a partial import`, async (t) => {
    const { job, files } = await downloaded(`Transient ${code}`, 2)
    // Different filenames without complete tags make the fallback keep both tracks distinct.
    updateSettings({ naming: { template: `{albumartist}/${code}/{title} - {track}` } })
    const realRename = fs.rename.bind(fs)
    let moved = false
    const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (moved) throw Object.assign(new Error(`destination failed: ${code}`), { code })
      await realRename(...args)
      moved = true
    })
    await distinctSecondTrack(job.id, files[1]!)
    try {
      await waiting(job.id, phase)
      assert.deepEqual(store.jobFiles(job.id).map((file) => file.state), ['imported', 'downloaded'])
      await fs.access(files[1]!)
    } finally {
      rename.mock.restore()
    }
    await resume(job.id)
  })
}

test('no space while tagging a copy of a read-only download keeps it, and the reason survives a restart', { skip: asRoot }, async (t) => {
  const { job, file, filed } = await downloadedAlbum('Full data folder')
  await fs.chmod(file, 0o444)
  const realCopy = fs.copyFile.bind(fs)
  // The tagged copy goes to Seeker's data folder, which is full.
  const copy = t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
    if (String(args[1]).startsWith(dirs.data)) throw noSpace()
    return realCopy(...args)
  })
  try {
    await waiting(job.id, SPACE)
    assert.match(store.getJob(job.id)!.error ?? '', /There isn’t enough free space to file new music: ENOSPC/)
    assert.equal(store.jobFiles(job.id)[0]!.state, 'downloaded')
    assert.deepEqual(await fs.readFile(file), await fs.readFile(fixture))
    // After a restart only the stored reason is left to say why the job waits.
    store.setPhase(job.id, null)
    assert.equal(store.toJob(store.getJob(job.id)!).phase, SPACE)
  } finally {
    copy.mock.restore()
  }
  await resume(job.id)
  assert.equal((await parseFile(filed)).common.album, 'Full data folder', 'the filed copy has the new tags')
})

for (const code of ['ENOSPC', 'EDQUOT']) {
  test(`${code} while tagging a download in place keeps it instead of filing it with its old tags`, async (t) => {
    const { job, file, filed } = await downloadedAlbum(`Tag ${code}`)
    // node-taglib-sharp writes through fs.writeSync.
    const write = t.mock.method(fsSync, 'writeSync', () => {
      throw noSpace(code)
    })
    try {
      await waiting(job.id, SPACE)
      assert.equal(store.jobFiles(job.id)[0]!.state, 'downloaded')
      await fs.access(file)
      await assert.rejects(fs.access(filed), 'nothing was filed')
    } finally {
      write.mock.restore()
    }
    await resume(job.id)
    assert.equal((await parseFile(filed)).common.album, `Tag ${code}`)
  })
}

test('no space during a copy-mode import keeps the job waiting and the originals untouched', async (t) => {
  updateSettings({ naming: { template: '{albumartist}/{album}/{disctrack} - {title}' } })
  const original = path.join(dirs.import, 'Copy Import', '01 - Song.mp3')
  await fs.mkdir(path.dirname(original), { recursive: true })
  await fs.copyFile(fixture, original)
  const target = {
    album: { title: 'Copy Import', artist: 'Test Artist', trackCount: 1, discCount: 1, mbChecked: true },
    tracks: [{ index: 0, title: 'Song', artist: 'Test Artist', disc: 1, track: 1, duration: 1 }],
    importMode: 'copy' as const,
  }
  const job = store.insertJob({ kind: 'import', status: 'processing', title: 'Copy Import', artist: 'Test Artist', origin: 'ui', target })
  store.patchJob(job.id, { next_retry_at: Date.now() + 60_000 })
  const row = store.insertFile(job.id, { trackIndex: 0, username: 'local', filename: original, size: (await fs.stat(original)).size, transferId: null, state: 'downloaded' })
  store.patchFile(row, { local_path: original })
  const realCopy = fs.copyFile.bind(fs)
  const copy = t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
    if (String(args[1]).startsWith(dirs.data)) throw noSpace()
    return realCopy(...args)
  })
  try {
    await waiting(job.id, SPACE)
    assert.equal(store.jobFiles(job.id)[0]!.state, 'downloaded')
  } finally {
    copy.mock.restore()
  }
  await resume(job.id)
  assert.deepEqual(await fs.readFile(original), await fs.readFile(fixture), 'copy mode leaves the original alone')
  await fs.access(path.join(dirs.music, 'Test Artist', 'Copy Import', '01 - Song.mp3'))
})

test('a download that vanishes just before the move fails instead of waiting for the music folder', async (t) => {
  const { job } = await downloaded('Vanished')
  const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await fs.rm(String(args[0]), { force: true })
    throw Object.assign(new Error('ENOENT: no such file or directory, rename'), { code: 'ENOENT' })
  })
  try {
    engine.retryJob(job.id)
    await waitFor(() => store.getJob(job.id)?.status === 'failed')
  } finally {
    rename.mock.restore()
  }
  const row = store.jobFiles(job.id)[0]!
  assert.equal(row.state, 'failed')
  assert.match(row.error ?? '', /disappeared before Seeker could file it/)
  assert.equal(store.getJob(job.id)!.next_retry_at, null)
})

test('a library index failure after filing completes the job in one pass; a later scan indexes the files', async (t) => {
  const { job, files } = await downloaded('Index fails', 2)
  updateSettings({ naming: { template: '{albumartist}/Index fails/{title} - {track}' } })
  await distinctSecondTrack(job.id, files[1]!)
  const rename = t.mock.method(fs, 'rename')
  db.exec(REJECT_ALBUMS)
  try {
    engine.retryJob(job.id)
    await waitFor(() => store.getJob(job.id)?.status === 'completed')
    assert.equal(rename.mock.callCount(), 2, 'each file is moved once: no second processing pass')
    assert.ok(logOf(job.id).some((line) => line.includes('couldn’t add them to the library index (injected album failure)')))
    assert.equal(logOf(job.id).some((line) => line.startsWith('Post-processing failed')), false)
  } finally {
    rename.mock.restore()
    db.exec('DROP TRIGGER reject_album')
  }
  const filed = store.jobFiles(job.id).map((file) => file.local_path!)
  for (const file of filed) await fs.access(file)
  assert.equal((await scanLibrary()).outcome, 'done')
  for (const file of filed) assert.ok(get('SELECT id FROM lib_tracks WHERE path = ?', [file]), `${file} is indexed`)
})

test('a library index failure doesn’t lose a wait for the music folder', async (t) => {
  const { job, files } = await downloaded('Index fails waiting', 2)
  updateSettings({ naming: { template: '{albumartist}/Index fails waiting/{title} - {track}' } })
  await distinctSecondTrack(job.id, files[1]!)
  const realRename = fs.rename.bind(fs)
  let calls = 0
  const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (++calls > 1) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    await realRename(...args)
  })
  db.exec(REJECT_ALBUMS)
  try {
    await waiting(job.id)
    await sleep(200)
    assert.equal(calls, 2, 'one pass: the first file filed, the second waits')
    assert.equal(logOf(job.id).some((line) => line.startsWith('Post-processing failed')), false)
    assert.deepEqual(store.jobFiles(job.id).map((file) => file.state), ['imported', 'downloaded'])
  } finally {
    rename.mock.restore()
    db.exec('DROP TRIGGER reject_album')
  }
  await resume(job.id)
})

test('processing that keeps failing backs off instead of spinning, and keeps the downloads', async () => {
  const { job, files } = await downloaded('Keeps failing')
  // A database read in the music-folder check fails, before anything is filed.
  db.exec('ALTER TABLE lib_albums RENAME TO lib_albums_gone')
  try {
    engine.retryJob(job.id)
    await waitFor(() => store.getJob(job.id)?.next_retry_at !== null)
    await sleep(300)
    assert.equal(logOf(job.id).filter((line) => line.startsWith('Post-processing failed')).length, 1, 'tried once, not in a loop')
    const row = store.getJob(job.id)!
    assert.equal(row.status, 'processing')
    assert.ok(row.next_retry_at! > Date.now())
    assert.equal(row.waiting_for, 'retry')
    assert.equal(store.toJob(row).phase, 'Waiting to try again')
    assert.match(row.error ?? '', /^Processing failed: no such table: lib_albums/)
    assert.deepEqual(store.jobFiles(job.id).map((file) => file.state), ['downloaded'])
    await fs.access(files[0]!)
  } finally {
    db.exec('ALTER TABLE lib_albums_gone RENAME TO lib_albums')
  }
  await resume(job.id)
})

test('explicit cancellation may remove downloads waiting for the music folder', async () => {
  const { job, dir } = await downloaded('Cancel waiting')
  await fs.rename(dirs.music, `${dirs.music}.off`)
  try {
    await waiting(job.id)
    await engine.cancelJob(job.id)
    assert.equal(store.getJob(job.id)?.status, 'cancelled')
    await assert.rejects(fs.access(dir))
  } finally {
    await fs.rename(`${dirs.music}.off`, dirs.music)
  }
})
