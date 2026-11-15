import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
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
const { musicFolderProblem } = await import('../server/library/scan.ts')
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

async function waiting(jobId: string) {
  engine.retryJob(jobId)
  await waitFor(() => store.getJob(jobId)?.next_retry_at !== null && !!store.getJob(jobId)?.error)
  const job = store.getJob(jobId)!
  assert.equal(job.status, 'processing')
  assert.equal(store.toJob(job).phase, 'Waiting for the music folder')
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

for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ESTALE', 'EIO']) {
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
    // Both files otherwise resolve to the same destination; give the second a distinct title.
    const { writeTags } = await import('../server/post/tag.ts')
    writeTags(files[1]!, { title: 'Second Song', artists: ['Test Artist'], albumArtist: 'Test Artist', album: 'Waiting Album', year: null, track: 2, trackCount: 2, disc: 1, discCount: 1, genres: [] })
    store.patchFile(store.jobFiles(job.id)[1]!.id, { size: (await fs.stat(files[1]!)).size })
    try {
      await waiting(job.id)
      assert.deepEqual(store.jobFiles(job.id).map((file) => file.state), ['imported', 'downloaded'])
      await fs.access(files[1]!)
    } finally {
      rename.mock.restore()
    }
    await resume(job.id)
  })
}

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
