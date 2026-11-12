import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { parseFile } from 'music-metadata'
import type { FileRow, JobRow } from '../server/jobs/store.ts'
import type { JobStatus } from '../shared/types.ts'
import { FakeMetadata, type FakeAlbum } from './fakes/metadata.ts'
import { FakeSlskd, type Behaviour, type SharedFile } from './fakes/slskd.ts'

// Integration tests for the download engine. The job state machine, replacements, stall handling and
// post-processing (ffmpeg checks, tagging, filing into the library) are all real; slskd, Deezer,
// MusicBrainz and the Cover Art Archive are local fakes, and every folder is a temp dir.
// Set SEEKER_LOG_LEVEL=info to see the engine's log, SEEKER_TEST_KEEP=1 to keep the temp dir.

const run = promisify(execFile)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------- folders and audio fixtures ----------

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-engine-')))
// On exit rather than in after(), so the folder also goes when setup fails.
if (!process.env.SEEKER_TEST_KEEP) process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const dirs = {
  data: path.join(root, 'data'),
  downloads: path.join(root, 'downloads'),
  music: path.join(root, 'music'),
  import: path.join(root, 'import'),
  fixtures: path.join(root, 'fixtures'),
}
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))

// Pink noise is broadband, so the fake-lossless check (which analyses audio after 15 s) has real
// high-frequency content to measure. Track lengths in the fake Deezer catalog match these exactly.
async function noise(name: string, seconds: number, options: { hiRes?: boolean; transcoded?: boolean } = {}) {
  const file = path.join(dirs.fixtures, name)
  // Seeded, so every run (and every machine) analyses exactly the same audio.
  const seed = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 2_147_483_647, 7)
  const source = options.transcoded ? path.join(dirs.fixtures, `${name}.source.flac`) : file
  await run('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=pink:r=${options.hiRes ? 96_000 : 44_100}:a=0.25:seed=${seed}`],
    ...['-ac', '2'],
    ...(options.hiRes ? ['-sample_fmt', 's32', '-bits_per_raw_sample', '24'] : ['-sample_fmt', 's16']),
    source,
  ])
  if (options.transcoded) {
    // A real MP3 round trip: the encoder's steep low-pass is what the fake-lossless check looks for.
    const mp3 = path.join(dirs.fixtures, `${name}.mp3`)
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-codec:a', 'libmp3lame', '-b:a', '128k', mp3])
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp3, '-sample_fmt', 's16', file])
  }
  return file
}

async function image(name: string) {
  const file = path.join(dirs.fixtures, name)
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x320:rate=1', '-frames:v', '1', file])
  return fs.readFile(file)
}

const [s16, s17, s18, s19, s20, hiRes16, transcoded18, cover] = await Promise.all([
  noise('16s.flac', 16),
  noise('17s.flac', 17),
  noise('18s.flac', 18),
  noise('19s.flac', 19),
  noise('20s.flac', 20),
  noise('16s-24bit-96khz.flac', 16, { hiRes: true }),
  noise('18s-transcoded.flac', 18, { transcoded: true }),
  image('cover.jpg'),
])
const sizes = new Map<string, number>()
for (const file of [s16, s17, s18, s19, s20, hiRes16, transcoded18]) sizes.set(file, (await fs.stat(file)).size)

// ---------- fakes, environment, offline guard ----------

const API_KEY = 'seeker-test-key'
const slskd = await new FakeSlskd({ apiKey: API_KEY, downloadsDir: dirs.downloads }).start()
const metadata = await new FakeMetadata().start()

// server/config.ts reads all of this at import time, so it's set before any server module loads.
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
  SEEKER_POLL_MS: '200',
  // Generous enough that a busy CI machine checking files doesn't trip the stall timers.
  SEEKER_ALBUM_STALL_MS: '3000',
  SEEKER_TRACK_QUEUE_MS: '10000',
  SEEKER_GIVE_UP_MS: '60000',
  SEEKER_MISSING_MS: '3000',
  SEEKER_SEARCH_GAP_MS: '1',
  SEEKER_SEARCH_IDLE_MS: '1000',
  SEEKER_LOCATE_MS: '2000',
  SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
})
// AcoustID would call api.acoustid.org; it's off when no key is configured anywhere.
delete process.env.ACOUSTID_API_KEY

// Nothing may leave the machine: requests to anything but the local fakes fail and are recorded.
const realFetch = globalThis.fetch
const blocked: string[] = []
const localFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== '127.0.0.1') {
    blocked.push(url.href)
    return Promise.reject(new TypeError(`Blocked a request to ${url.href}: tests run offline`))
  }
  return realFetch(input, init)
}
Object.assign(globalThis, { fetch: localFetch })

// scheduleShareRescan() waits 60 s before asking slskd to rescan its shares. Run that one timer after
// 100 ms instead, so the PUT /shares it sends can be asserted; every other timer is left alone.
const realSetTimeout = globalThis.setTimeout
const quickRescan = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
  realSetTimeout(callback, String(callback).includes('rescanShares') ? 100 : ms, ...args)) as unknown as typeof setTimeout
Object.assign(globalThis, { setTimeout: quickRescan })

const { startStatus, soulseekReady } = await import('../server/status.ts')
const engine = await import('../server/jobs/engine.ts')
const store = await import('../server/jobs/store.ts')
const { updateSettings } = await import('../server/settings.ts')
const { all } = await import('../server/db.ts')
const { rebuildOwnedIndex } = await import('../server/library/owned.ts')
const importer = await import('../server/library/importer.ts')
const { fakeLosslessProblem } = await import('../server/post/verify.ts')

updateSettings({
  quality: { formats: ['flac', 'mp3'], minBitrate: 320, acceptVbr: false, hiRes: 'accept' },
  naming: { template: '{albumartist}/{album} ({year})/{disctrack} - {title}' },
  // ffmpeg is installed, so the duration, decode and fake-lossless checks all run for real.
  checks: { duration: true, integrity: true, fakeLossless: true, acoustidKey: '' },
  wishlist: { enabled: true },
})
rebuildOwnedIndex()
startStatus()
engine.startEngine()

after(() => Promise.all([slskd.close(), metadata.close()]))

// ---------- helpers ----------

const FINAL: JobStatus[] = ['completed', 'wanted', 'failed', 'cancelled']

async function waitFor<T>(
  what: string,
  check: () => T | null | undefined | false,
  timeoutMs = 20_000,
  context?: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${context ? `\n${context()}` : ''}`)
    await sleep(50)
  }
}

// A job's state, files and log, for assertion messages.
function dump(jobId: string): string {
  const row = store.getJob(jobId)
  if (!row) return `job ${jobId} does not exist`
  const detail = store.toDetail(row)
  return [
    `${row.kind} job “${row.title}”: status=${row.status} error=${row.error ?? '-'} phase=${detail.phase ?? '-'}`,
    ...store
      .jobFiles(jobId)
      .map(
        (file) =>
          `  file #${file.id} track=${file.track_index} ${file.username} ${file.state} [${file.quality ?? ''}] ${file.remote_state ?? ''} ${file.error ?? ''}`,
      ),
    ...detail.log.map((entry) => `  ${entry.level}: ${entry.message}`),
  ].join('\n')
}

function finished(jobId: string, timeoutMs = 25_000): Promise<JobRow> {
  return waitFor(
    'the job to finish',
    () => {
      const row = store.getJob(jobId)
      return row && FINAL.includes(row.status) ? row : null
    },
    timeoutMs,
    () => dump(jobId),
  )
}

const logOf = (jobId: string) => store.toDetail(store.getJob(jobId)!).log.map((entry) => entry.message)
const byTrack = (a: FileRow, b: FileRow) => (a.track_index ?? -1) - (b.track_index ?? -1)

async function exists(file: string) {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

// Paths of every file under a folder, relative to it.
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(path.relative(dir, full))
    }
  }
  await walk(dir)
  return out.sort()
}

interface Track {
  title: string
  track: number
  disc?: number
  duration: number
  // What a peer delivers for this track.
  fixture: string
}

const trackId = (albumId: number, index: number) => albumId * 100 + index + 1

function deezerAlbum(
  id: number,
  artist: { id: number; name: string },
  title: string,
  year: number,
  tracks: Track[],
  extra: Partial<FakeAlbum> = {},
): FakeAlbum {
  return {
    id,
    title,
    artist,
    releaseDate: `${year}-03-15`,
    label: 'Fake Records',
    genres: ['Electronic'],
    tracks: tracks.map((track, index) => ({
      id: trackId(id, index),
      title: track.title,
      duration: track.duration,
      track: track.track,
      disc: track.disc ?? 1,
      isrc: `QZTST${id}${String(index + 1).padStart(3, '0')}`,
    })),
    ...extra,
  }
}

// A peer's copy of an album: "<dir>\NN - Title.flac", or "<dir>\CDn\NN - Title.flac" with disc folders.
function folderOf(
  dir: string,
  tracks: Track[],
  options: { hiRes?: boolean; discFolders?: boolean; fixture?: (track: Track) => string; behaviour?: (track: Track) => Behaviour } = {},
): SharedFile[] {
  return tracks.map((track) => {
    const fixture = options.fixture?.(track) ?? track.fixture
    return {
      filename: `${dir}${options.discFolders ? `\\CD${track.disc ?? 1}` : ''}\\${String(track.track).padStart(2, '0')} - ${track.title}.flac`,
      fixture,
      size: sizes.get(fixture)!,
      length: track.duration,
      bitDepth: options.hiRes ? 24 : 16,
      sampleRate: options.hiRes ? 96_000 : 44_100,
      behaviour: options.behaviour?.(track) ?? 'succeed',
    }
  })
}

await waitFor('slskd to report a Soulseek login', () => soulseekReady(), 5000)

// ---------- scenarios ----------

test('album: a peer with a complete FLAC folder → downloaded, verified, tagged and filed', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [
    { title: 'First Song', track: 1, duration: 16, fixture: s16 },
    { title: 'Second Song', track: 2, duration: 17, fixture: s17 },
    { title: 'Third Song', track: 3, duration: 18, fixture: s18 },
  ]
  metadata.addAlbum(deezerAlbum(1001, { id: 501, name: 'Test Artist' }, 'Happy Album', 2020, tracks, { cover }))
  const dir = '@@alice\\Music\\Test Artist\\Test Artist - Happy Album (2020) [FLAC]'
  slskd.addPeer({ username: 'alice', files: folderOf(dir, tracks) })
  const rescans = slskd.shareRescans

  const job = await engine.queueAlbum(1001, 'ui')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))
  assert.equal(row.error, null)
  assert.deepEqual(JSON.parse(row.result ?? 'null'), { imported: 3 })

  const files = store.jobFiles(job.id).sort(byTrack)
  assert.deepEqual(
    files.map((file) => [file.track_index, file.username, file.state, file.quality]),
    [
      [0, 'alice', 'imported', 'FLAC 16/44.1'],
      [1, 'alice', 'imported', 'FLAC 16/44.1'],
      [2, 'alice', 'imported', 'FLAC 16/44.1'],
    ],
  )

  const albumDir = path.join(dirs.music, 'Test Artist', 'Happy Album (2020)')
  assert.deepEqual(await listFiles(albumDir), ['01 - First Song.flac', '02 - Second Song.flac', '03 - Third Song.flac', 'cover.jpg'])
  for (const track of tracks) {
    const file = path.join(albumDir, `0${track.track} - ${track.title}.flac`)
    assert.equal(files[track.track - 1]!.local_path, file)
    const { common, format } = await parseFile(file)
    assert.equal(common.title, track.title)
    assert.equal(common.artist, 'Test Artist')
    assert.equal(common.albumartist, 'Test Artist')
    assert.equal(common.album, 'Happy Album')
    assert.equal(common.year, 2020)
    assert.deepEqual(common.track, { no: track.track, of: 3 })
    assert.deepEqual(common.disk, { no: 1, of: 1 })
    assert.deepEqual(common.isrc, [`QZTST1001${String(track.track).padStart(3, '0')}`])
    assert.equal(common.picture?.length, 1, 'the cover is embedded')
    // The fixtures have distinct lengths, so this is the track's own file and not a neighbour's.
    assert.equal(Math.round(format.duration ?? 0), track.duration)
  }

  // slskd: one album search, a browse of the folder, one batch into seeker/<job id>.
  assert.deepEqual(
    slskd.searchTexts().filter((text) => text.includes('Happy Album')),
    ['Test Artist Happy Album'],
  )
  assert.ok(slskd.browses.some((call) => call.username === 'alice' && call.directory === dir))
  const batches = slskd.batchesFor(job.id)
  assert.equal(batches.length, 1)
  assert.equal(batches[0]!.username, 'alice')
  assert.deepEqual(
    batches[0]!.files.map((file) => file.filename).sort(),
    folderOf(dir, tracks).map((file) => file.filename).sort(),
  )
  // Finished transfers are cleared from slskd, and the job's download folder is removed.
  await waitFor('finished transfers to be removed from slskd', () => slskd.transfersFor(job.id).every((transfer) => transfer.removed))
  assert.equal(await exists(path.join(dirs.downloads, 'seeker', job.id)), false)

  // The library index has the tracks, and slskd is asked to rescan its shares.
  const indexed = all<{ title: string }>('SELECT title FROM lib_tracks WHERE album_artist = ? ORDER BY track_no', ['Test Artist'])
  assert.deepEqual(
    indexed.map((item) => item.title),
    tracks.map((track) => track.title),
  )
  await waitFor('PUT /shares', () => slskd.shareRescans > rescans, 5000)
})

test('album: a peer whose queue never moves is dropped for another peer’s copy', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [
    { title: 'Red Light', track: 1, duration: 16, fixture: s16 },
    { title: 'Long Wait', track: 2, duration: 17, fixture: s17 },
    { title: 'Green Again', track: 3, duration: 18, fixture: s18 },
  ]
  metadata.addAlbum(deezerAlbum(1002, { id: 502, name: 'Patient Band' }, 'Slow Lane', 2019, tracks))
  // anna looks better on paper (free slot, fast), so her copy is tried first, but it never starts.
  slskd.addPeer({
    username: 'anna',
    freeSlot: true,
    uploadSpeed: 9_000_000,
    files: folderOf('@@anna\\Music\\Patient Band\\Patient Band - Slow Lane (2019)', tracks, { behaviour: () => 'stall' }),
  })
  slskd.addPeer({
    username: 'bert',
    freeSlot: false,
    queueLength: 4,
    uploadSpeed: 1_000_000,
    files: folderOf('@@bert\\Shared\\Patient Band\\2019 - Slow Lane [FLAC]', tracks),
  })

  const job = await engine.queueAlbum(1002, 'ui')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))

  const files = store.jobFiles(job.id)
  const anna = files.filter((file) => file.username === 'anna')
  const bert = files.filter((file) => file.username === 'bert')
  assert.equal(files.length, 6, dump(job.id))
  assert.deepEqual(
    anna.map((file) => [file.state, file.error]),
    Array(3).fill(['cancelled', 'stalled']),
  )
  assert.deepEqual(
    bert.sort(byTrack).map((file) => [file.track_index, file.state]),
    [
      [0, 'imported'],
      [1, 'imported'],
      [2, 'imported'],
    ],
  )

  // anna's queued transfers were cancelled in slskd and removed from its list.
  const cancelled = slskd.cancelledWhileActive(job.id)
  assert.deepEqual(cancelled.map((call) => call.id).sort(), anna.map((file) => file.transfer_id).sort())
  for (const call of cancelled) {
    assert.equal(call.username, 'anna')
    assert.equal(call.stateBefore, 'Queued, Remotely')
    assert.equal(call.remove, true)
  }

  const log = logOf(job.id)
  assert.ok(log.some((message) => message.startsWith('No progress from anna')), dump(job.id))
  assert.ok(log.some((message) => message.startsWith('Switched to bert’s copy for 3 tracks')), dump(job.id))
  // bert's copy was already known from the first search; no second search was needed.
  assert.equal(slskd.searchTexts().filter((text) => text === 'Patient Band Slow Lane').length, 1)
  assert.deepEqual(await listFiles(path.join(dirs.music, 'Patient Band', 'Slow Lane (2019)')), [
    '01 - Red Light.flac',
    '02 - Long Wait.flac',
    '03 - Green Again.flac',
  ])
})

test('album: after switching copies, an earlier track in another quality is replaced so the album matches', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [
    { title: 'Crimson Sky', track: 1, duration: 16, fixture: s16 },
    { title: 'Azure Coast', track: 2, duration: 17, fixture: s17 },
    { title: 'Amber Field', track: 3, duration: 18, fixture: s18 },
    { title: 'Violet Hour', track: 4, duration: 19, fixture: s19 },
  ]
  metadata.addAlbum(deezerAlbum(1003, { id: 503, name: 'Fidelity Duo' }, 'True Colors', 2018, tracks))
  // hiresfan has a 24/96 copy and the healthier connection, but only track 1 ever arrives.
  slskd.addPeer({
    username: 'hiresfan',
    freeSlot: true,
    uploadSpeed: 9_000_000,
    files: folderOf('@@hiresfan\\Hi-Res\\Fidelity Duo - True Colors (2018) [24-96]', tracks, {
      hiRes: true,
      fixture: () => hiRes16,
      behaviour: (track) => (track.track === 1 ? 'succeed' : 'stall'),
    }),
  })
  slskd.addPeer({
    username: 'cdrip',
    freeSlot: false,
    queueLength: 2,
    uploadSpeed: 1_000_000,
    files: folderOf('@@cdrip\\Music\\Fidelity Duo\\True Colors (2018)', tracks),
  })

  const job = await engine.queueAlbum(1003, 'ui')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))

  const files = store.jobFiles(job.id)
  const fromHiresfan = files.filter((file) => file.username === 'hiresfan').sort(byTrack)
  assert.deepEqual(
    fromHiresfan.map((file) => [file.track_index, file.state, file.error, file.quality]),
    [
      [0, 'cancelled', 'replaced to keep the album in one quality', 'FLAC 24/96'],
      [1, 'cancelled', 'stalled', 'FLAC 24/96'],
      [2, 'cancelled', 'stalled', 'FLAC 24/96'],
      [3, 'cancelled', 'stalled', 'FLAC 24/96'],
    ],
    dump(job.id),
  )
  const imported = files.filter((file) => file.state === 'imported').sort(byTrack)
  assert.deepEqual(
    imported.map((file) => [file.track_index, file.username, file.quality]),
    [
      [0, 'cdrip', 'FLAC 16/44.1'],
      [1, 'cdrip', 'FLAC 16/44.1'],
      [2, 'cdrip', 'FLAC 16/44.1'],
      [3, 'cdrip', 'FLAC 16/44.1'],
    ],
    dump(job.id),
  )
  const log = logOf(job.id)
  assert.ok(log.some((message) => message.startsWith('Also taking 1 earlier track(s) from cdrip')), dump(job.id))
  assert.ok(log.some((message) => message.startsWith('Switched to cdrip’s copy for 4 tracks')), dump(job.id))

  // hiresfan's three queued transfers were cancelled; track 1 had already finished.
  assert.deepEqual(
    slskd
      .cancelledWhileActive(job.id)
      .map((call) => call.id)
      .sort(),
    fromHiresfan
      .slice(1)
      .map((file) => file.transfer_id)
      .sort(),
  )

  // Every file in the library is the 16/44.1 copy, including track 1 (whose 24/96 download sat in the
  // same download folder under the same name; the fake renamed cdrip's copy like slskd does).
  const albumDir = path.join(dirs.music, 'Fidelity Duo', 'True Colors (2018)')
  const names = await listFiles(albumDir)
  assert.deepEqual(names, ['01 - Crimson Sky.flac', '02 - Azure Coast.flac', '03 - Amber Field.flac', '04 - Violet Hour.flac'])
  for (const name of names) {
    const { format } = await parseFile(path.join(albumDir, name))
    assert.equal(format.sampleRate, 44_100, name)
    assert.equal(format.bitsPerSample, 16, name)
  }
  assert.match(
    path.basename(slskd.transfersFor(job.id).find((t) => t.username === 'cdrip' && t.filename.endsWith('01 - Crimson Sky.flac'))!.deliveredTo!),
    /^01 - Crimson Sky_\d{18}\.flac$/,
  )
})

test('track: a transfer that errors is retried from another peer', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [
    { title: 'Opening Act', track: 1, duration: 16, fixture: s16 },
    { title: 'Lucky Seven', track: 2, duration: 17, fixture: s17 },
  ]
  metadata.addAlbum(deezerAlbum(1004, { id: 504, name: 'Track Artist' }, 'North Way', 2021, tracks))
  slskd.addPeer({
    username: 'flaky',
    freeSlot: true,
    uploadSpeed: 9_000_000,
    files: folderOf('@@flaky\\Music\\Track Artist\\Track Artist - North Way (2021)', tracks, {
      behaviour: (track) => (track.track === 2 ? 'fail' : 'succeed'),
    }),
  })
  slskd.addPeer({ username: 'steady', freeSlot: false, queueLength: 1, files: folderOf('@@steady\\Music\\Track Artist\\North Way', tracks) })

  const job = await engine.queueTrack(trackId(1004, 1), 'ui')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))

  const files = store.jobFiles(job.id)
  assert.equal(files.length, 2, dump(job.id))
  const [first, second] = files as [FileRow, FileRow]
  assert.equal(first.username, 'flaky')
  assert.equal(first.state, 'failed')
  assert.equal(first.error, 'the transfer failed (Remote connection closed)')
  assert.equal(second.username, 'steady')
  assert.equal(second.state, 'imported')
  assert.equal(second.track_index, 1)
  // The errored transfer was cleared from slskd.
  assert.ok(
    slskd.cancellations.some((call) => call.found && call.id === first.transfer_id && call.stateBefore === 'Completed, Errored'),
  )
  assert.deepEqual(
    slskd.searchTexts().filter((text) => text.includes('Lucky Seven')),
    ['Track Artist Lucky Seven'],
  )

  const albumDir = path.join(dirs.music, 'Track Artist', 'North Way (2021)')
  assert.deepEqual(await listFiles(albumDir), ['02 - Lucky Seven.flac'])
  const { common, format } = await parseFile(path.join(albumDir, '02 - Lucky Seven.flac'))
  assert.equal(common.title, 'Lucky Seven')
  assert.equal(common.album, 'North Way')
  assert.deepEqual(common.track, { no: 2, of: 2 })
  assert.equal(Math.round(format.duration ?? 0), 17)
})

test('track: a “FLAC” that is really a transcoded MP3 fails verification and is replaced', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [{ title: 'Deep Pool', track: 1, duration: 18, fixture: s18 }]
  metadata.addAlbum(deezerAlbum(1010, { id: 510, name: 'Honest Ears' }, 'Clear Water', 2022, tracks))
  slskd.addPeer({
    username: 'transcoder',
    freeSlot: true,
    uploadSpeed: 9_000_000,
    files: folderOf('@@transcoder\\Music\\Honest Ears - Clear Water (2022)', tracks, { fixture: () => transcoded18 }),
  })
  slskd.addPeer({ username: 'honest', freeSlot: false, queueLength: 1, files: folderOf('@@honest\\Music\\Honest Ears\\Clear Water', tracks) })

  const job = await engine.queueTrack(trackId(1010, 0), 'ui')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))

  const files = store.jobFiles(job.id)
  assert.deepEqual(
    files.map((file) => [file.username, file.state]),
    [
      ['transcoder', 'failed'],
      ['honest', 'imported'],
    ],
    dump(job.id),
  )
  assert.match(files[0]!.error ?? '', /looks like a lossy file converted to lossless/)
  assert.ok(logOf(job.id).some((message) => message.includes('from transcoder rejected')), dump(job.id))

  const file = path.join(dirs.music, 'Honest Ears', 'Clear Water (2022)', '01 - Deep Pool.flac')
  assert.equal(files[1]!.local_path, file)
  assert.equal(await fakeLosslessProblem(file, 44_100), null, 'the library has the genuine file')
})

test('album: a file the peer refuses is fetched from someone else; the rest of the folder is kept', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [
    { title: 'Paper Boat', track: 1, duration: 16, fixture: s16 },
    { title: 'Glass Door', track: 2, duration: 17, fixture: s17 },
    { title: 'Stone Path', track: 3, duration: 18, fixture: s18 },
  ]
  metadata.addAlbum(deezerAlbum(1011, { id: 511, name: 'Folded Maps' }, 'Soft Rooms', 2014, tracks))
  slskd.addPeer({
    username: 'picky',
    freeSlot: true,
    uploadSpeed: 9_000_000,
    files: folderOf('@@picky\\Music\\Folded Maps\\Folded Maps - Soft Rooms (2014)', tracks, {
      behaviour: (track) => (track.track === 2 ? 'reject' : 'succeed'),
    }),
  })
  slskd.addPeer({ username: 'backup', freeSlot: false, queueLength: 3, files: folderOf('@@backup\\Archive\\Folded Maps\\Soft Rooms', tracks) })

  const job = await engine.queueAlbum(1011, 'ui')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))

  // Only the refused track came from backup; no second search was needed to find it.
  assert.deepEqual(
    store
      .jobFiles(job.id)
      .sort((a, b) => byTrack(a, b) || a.id - b.id)
      .map((file) => [file.track_index, file.username, file.state, file.error]),
    [
      [0, 'picky', 'imported', null],
      [1, 'picky', 'failed', 'the user rejected the request (File not shared.)'],
      [1, 'backup', 'imported', null],
      [2, 'picky', 'imported', null],
    ],
    dump(job.id),
  )
  assert.ok(logOf(job.id).includes('“Glass Door”: downloading from backup · FLAC 16/44.1'), dump(job.id))
  assert.equal(slskd.searchTexts().filter((text) => text.includes('Soft Rooms')).length, 1)
  assert.deepEqual(await listFiles(path.join(dirs.music, 'Folded Maps', 'Soft Rooms (2014)')), [
    '01 - Paper Boat.flac',
    '02 - Glass Door.flac',
    '03 - Stone Path.flac',
  ])
})

test('track: a transfer that disappears from slskd is given up after the missing timeout and replaced', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [{ title: 'Faint Echo', track: 1, duration: 17, fixture: s17 }]
  metadata.addAlbum(deezerAlbum(1012, { id: 512, name: 'Static Hum' }, 'Lost Signal', 2013, tracks))
  slskd.addPeer({
    username: 'ghost',
    freeSlot: true,
    uploadSpeed: 9_000_000,
    files: folderOf('@@ghost\\Music\\Static Hum - Lost Signal', tracks, { behaviour: () => 'vanish' }),
  })
  slskd.addPeer({ username: 'solid', freeSlot: false, queueLength: 1, files: folderOf('@@solid\\Music\\Static Hum\\Lost Signal', tracks) })

  const job = await engine.queueTrack(trackId(1012, 0), 'ui')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))
  assert.deepEqual(
    store.jobFiles(job.id).map((file) => [file.username, file.state, file.error]),
    [
      ['ghost', 'failed', 'the transfer disappeared from slskd'],
      ['solid', 'imported', null],
    ],
    dump(job.id),
  )
  assert.deepEqual(await listFiles(path.join(dirs.music, 'Static Hum', 'Lost Signal (2013)')), ['01 - Faint Echo.flac'])
})

test('album: nobody has it → wanted with a retry time; retrying searches again', { timeout: 30_000 }, async () => {
  const tracks: Track[] = ['Gone One', 'Gone Two', 'Gone Three', 'Gone Four', 'Gone Five'].map((title, index) => ({
    title,
    track: index + 1,
    duration: 200,
    fixture: s20,
  }))
  metadata.addAlbum(deezerAlbum(1005, { id: 505, name: 'Missing Artist' }, 'Nowhere', 2015, tracks))
  const HOUR = 3600_000

  const queuedAt = Date.now()
  const job = await engine.queueAlbum(1005, 'ui')
  let row = await finished(job.id)
  assert.equal(row.status, 'wanted', dump(job.id))
  assert.equal(row.error, 'No complete copy of this album was found on Soulseek')
  assert.equal(row.attempts, 1)
  assert.ok(row.next_retry_at !== null && row.next_retry_at >= queuedAt + HOUR && row.next_retry_at <= Date.now() + HOUR, `${row.next_retry_at}`)
  assert.deepEqual(store.jobFiles(job.id), [])
  assert.deepEqual(slskd.batchesFor(job.id), [])
  assert.equal(slskd.searchTexts().filter((text) => text === 'Missing Artist Nowhere').length, 1)

  engine.retryJob(job.id)
  row = store.getJob(job.id)!
  assert.ok(['queued', 'searching'].includes(row.status), row.status)
  assert.equal(row.next_retry_at, null)
  assert.equal(row.error, null)

  const retriedAt = Date.now()
  row = await finished(job.id)
  assert.equal(row.status, 'wanted', dump(job.id))
  assert.equal(row.attempts, 2)
  // The second miss backs off further (1 h, then 4 h, …).
  assert.ok(
    row.next_retry_at !== null && row.next_retry_at >= retriedAt + 4 * HOUR && row.next_retry_at <= Date.now() + 4 * HOUR,
    `${row.next_retry_at}`,
  )
  assert.equal(slskd.searchTexts().filter((text) => text === 'Missing Artist Nowhere').length, 2)
})

test('cancel: an album waiting in a peer’s queue is cancelled cleanly', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [
    { title: 'Ice Wall', track: 1, duration: 16, fixture: s16 },
    { title: 'Cold Floor', track: 2, duration: 17, fixture: s17 },
    { title: 'Thaw Out', track: 3, duration: 18, fixture: s18 },
  ]
  metadata.addAlbum(deezerAlbum(1006, { id: 506, name: 'Halted Band' }, 'Frozen Room', 2016, tracks))
  slskd.addPeer({
    username: 'sleepy',
    files: folderOf('@@sleepy\\Music\\Halted Band - Frozen Room (2016)', tracks, { behaviour: () => 'stall' }),
  })

  const job = await engine.queueAlbum(1006, 'ui')
  // Cancel as soon as all three requests sit in sleepy's queue, well before the stall timer (3 s).
  await waitFor(
    'the transfers to be queued remotely',
    () => {
      const files = store.jobFiles(job.id)
      return (
        store.getJob(job.id)?.status === 'downloading' &&
        files.length === 3 &&
        files.every((file) => file.remote_state === 'Queued, Remotely')
      )
    },
    15_000,
    () => dump(job.id),
  )
  assert.ok(!logOf(job.id).some((message) => message.includes('trying another source')), dump(job.id))
  await engine.cancelJob(job.id)

  const row = store.getJob(job.id)!
  assert.equal(row.status, 'cancelled')
  assert.equal(row.next_retry_at, null)
  const files = store.jobFiles(job.id)
  assert.deepEqual(
    files.map((file) => [file.state, file.error]),
    Array(3).fill(['cancelled', 'cancelled']),
  )
  const cancelled = slskd.cancelledWhileActive(job.id)
  assert.deepEqual(cancelled.map((call) => call.id).sort(), files.map((file) => file.transfer_id).sort())
  for (const call of cancelled) {
    assert.equal(call.stateBefore, 'Queued, Remotely')
    assert.equal(call.remove, true)
  }
  assert.ok(slskd.transfersFor(job.id).every((transfer) => transfer.removed && transfer.state === 'Completed, Cancelled'))

  // Nothing happens to it afterwards: no stall handling, no new searches or downloads.
  const searches = slskd.searches.length
  await sleep(2500)
  assert.equal(store.getJob(job.id)!.status, 'cancelled')
  assert.equal(slskd.batchesFor(job.id).length, 1)
  assert.equal(slskd.searches.length, searches)
  assert.equal(await exists(path.join(dirs.music, 'Halted Band')), false)
  assert.equal(await exists(path.join(dirs.downloads, 'seeker', job.id)), false)
})

test('album: two discs in CD1/CD2 folders are tagged per disc and named 1-01, 2-01, …', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [
    { title: 'Morning Light', disc: 1, track: 1, duration: 16, fixture: s16 },
    { title: 'Second Wind', disc: 1, track: 2, duration: 17, fixture: s17 },
    { title: 'Evening Tide', disc: 2, track: 1, duration: 18, fixture: s18 },
    { title: 'Last Call', disc: 2, track: 2, duration: 19, fixture: s19 },
  ]
  metadata.addAlbum(deezerAlbum(1007, { id: 507, name: 'Disc Artist' }, 'Twin Discs', 2018, tracks))
  const dir = '@@collector\\Music\\Disc Artist\\Disc Artist - Twin Discs (2018)'
  slskd.addPeer({ username: 'collector', files: folderOf(dir, tracks, { discFolders: true }) })

  const job = await engine.queueAlbum(1007, 'ui')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))
  assert.deepEqual(JSON.parse(row.result ?? 'null'), { imported: 4 })
  // Both disc folders were browsed and downloaded as one album.
  assert.deepEqual(
    slskd.browses
      .filter((call) => call.username === 'collector')
      .map((call) => call.directory)
      .sort(),
    [`${dir}\\CD1`, `${dir}\\CD2`],
  )
  assert.equal(slskd.batchesFor(job.id).length, 1)

  const albumDir = path.join(dirs.music, 'Disc Artist', 'Twin Discs (2018)')
  assert.deepEqual(await listFiles(albumDir), [
    '1-01 - Morning Light.flac',
    '1-02 - Second Wind.flac',
    '2-01 - Evening Tide.flac',
    '2-02 - Last Call.flac',
  ])
  for (const track of tracks) {
    const name = `${track.disc}-0${track.track} - ${track.title}.flac`
    const { common, format } = await parseFile(path.join(albumDir, name))
    assert.equal(common.title, track.title, name)
    assert.deepEqual(common.disk, { no: track.disc, of: 2 }, name)
    assert.deepEqual(common.track, { no: track.track, of: 2 }, name)
    assert.equal(Math.round(format.duration ?? 0), track.duration, name)
  }
})

test('import: files in the import folder are matched to the album, copied in and tagged; originals stay', { timeout: 30_000 }, async () => {
  const tracks: Track[] = [
    { title: 'Alpha Wave', track: 1, duration: 16, fixture: s16 },
    { title: 'Beta Wave', track: 2, duration: 17, fixture: s17 },
    { title: 'Gamma Wave', track: 3, duration: 18, fixture: s18 },
  ]
  metadata.addAlbum(deezerAlbum(1008, { id: 508, name: 'Import Artist' }, 'Home Tapes', 2017, tracks))
  const source = path.join(dirs.import, 'Import Artist - Home Tapes')
  await fs.mkdir(source, { recursive: true })
  const originals = [path.join(source, '01 - Alpha Wave.flac'), path.join(source, '02 - Beta Wave.flac')] as const
  await fs.copyFile(s16, originals[0])
  await fs.copyFile(s17, originals[1])

  const { folders } = await importer.listImportFolders()
  const folder = folders.find((item) => item.name === 'Import Artist - Home Tapes')
  assert.ok(folder, JSON.stringify(folders))
  assert.equal(folder.files, 2)

  const job = await importer.importFolder(folder.id, { albumId: 1008 }, 'copy')
  const row = await finished(job.id)
  assert.equal(row.status, 'completed', dump(job.id))
  assert.deepEqual(JSON.parse(row.result ?? 'null'), { imported: 2 })
  assert.deepEqual(
    store
      .jobFiles(job.id)
      .sort(byTrack)
      .map((file) => [file.track_index, file.username, file.state]),
    [
      [0, 'local', 'imported'],
      [1, 'local', 'imported'],
    ],
  )

  const albumDir = path.join(dirs.music, 'Import Artist', 'Home Tapes (2017)')
  assert.deepEqual(await listFiles(albumDir), ['01 - Alpha Wave.flac', '02 - Beta Wave.flac'])
  for (const track of tracks.slice(0, 2)) {
    const { common, format } = await parseFile(path.join(albumDir, `0${track.track} - ${track.title}.flac`))
    assert.equal(common.title, track.title)
    assert.equal(common.artist, 'Import Artist')
    assert.equal(common.album, 'Home Tapes')
    assert.deepEqual(common.track, { no: track.track, of: 3 })
    assert.equal(Math.round(format.duration ?? 0), track.duration)
  }
  // Copy mode leaves the originals exactly as they were, and nothing went through slskd.
  assert.ok((await fs.readFile(originals[0])).equals(await fs.readFile(s16)))
  assert.ok((await fs.readFile(originals[1])).equals(await fs.readFile(s17)))
  assert.deepEqual(slskd.batchesFor(job.id), [])
})

test(
  'album (3 tracks): a switch that leaves two tracks to replace still keeps the album in one quality',
  { timeout: 30_000 },
  async () => {
    const tracks: Track[] = [
      { title: 'Low Tide', track: 1, duration: 16, fixture: s16 },
      { title: 'High Noon', track: 2, duration: 17, fixture: s17 },
      { title: 'Dusk Fall', track: 3, duration: 18, fixture: s18 },
    ]
    metadata.addAlbum(deezerAlbum(1009, { id: 509, name: 'Mixed Trio' }, 'Half Tones', 2017, tracks))
    slskd.addPeer({
      username: 'audiophile',
      freeSlot: true,
      uploadSpeed: 9_000_000,
      files: folderOf('@@audiophile\\Hi-Res\\Mixed Trio - Half Tones (2017) [24-96]', tracks, {
        hiRes: true,
        fixture: () => hiRes16,
        behaviour: (track) => (track.track === 1 ? 'succeed' : 'stall'),
      }),
    })
    slskd.addPeer({
      username: 'ripper',
      freeSlot: false,
      queueLength: 2,
      uploadSpeed: 1_000_000,
      files: folderOf('@@ripper\\Music\\Mixed Trio\\Half Tones (2017)', tracks),
    })

    const job = await engine.queueAlbum(1009, 'ui')
    const row = await finished(job.id)
    assert.equal(row.status, 'completed', dump(job.id))
    const files = store.jobFiles(job.id)
    const early = files.find((file) => file.username === 'audiophile' && file.track_index === 0)
    assert.deepEqual([early?.state, early?.error], ['cancelled', 'replaced to keep the album in one quality'], dump(job.id))
    const imported = files.filter((file) => file.state === 'imported')
    assert.deepEqual(
      imported.map((file) => file.username),
      ['ripper', 'ripper', 'ripper'],
      dump(job.id),
    )
  },
)

test('offline: every request stayed local and carried the slskd API key', async () => {
  assert.deepEqual(blocked, [])
  assert.deepEqual(
    slskd.requests.filter((request) => request.status === 401),
    [],
  )
  // The fake really does insist on the key.
  const response = await realFetch(`${slskd.url}/api/v0/application`)
  assert.equal(response.status, 401)
  await response.body?.cancel()
})
