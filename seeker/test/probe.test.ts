// ffprobe as a second opinion for files music-metadata can't parse (issue #2).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { parseFile } from 'music-metadata'
import { isReadError, probeTags } from '../server/library/probe.ts'

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-probe-')))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const ff = (...args: string[]) => promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

const synchsafe = (n: number) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127])
const frame = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id, 'latin1'), synchsafe(body.length), Buffer.alloc(2), body])
const text = (id: string, value: string) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]))

// Like the file in issue #2: the ID3v2.4 header says 1,988 bytes, but the lyrics and the cover run on
// past that, and the cover holds bytes that look like an AAC frame header with length 0.
async function understatedTag(file: string, junk = Buffer.alloc(256)) {
  const audio = path.join(root, 'audio.mp3')
  const cover = path.join(root, 'cover.jpg')
  await ff('-f', 'lavfi', '-i', 'anoisesrc=d=5', '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '0', audio)
  await ff('-f', 'lavfi', '-i', 'testsrc=s=300x300', '-frames:v', '1', cover)
  const jpeg = await fs.readFile(cover)
  const frames = Buffer.concat([
    text('TIT2', 'How This Ends'),
    text('TPE1', 'Lewis Capaldi'),
    text('TALB', 'Broken by Desire to Be Heavenly Sent (extended edition)'),
    text('TRCK', '11'),
    frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng', 'latin1'), Buffer.from([0]), Buffer.from('I cut free\nFrom all that we are\n'.repeat(80), 'utf8')])),
    frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([3, 0]), jpeg.subarray(0, 20), Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0]), jpeg.subarray(20)])),
  ])
  await fs.writeFile(file, Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), synchsafe(1988), frames, junk, await fs.readFile(audio)]))
}

test('a file music-metadata gives up on gets its tags and stream details from ffprobe', async () => {
  const file = path.join(root, '11 How This Ends.mp3')
  await understatedTag(file)
  await assert.rejects(parseFile(file, { skipCovers: true, duration: false }), /Invalid ADTS frame length/)
  const meta = await probeTags(file)
  assert.ok(meta)
  assert.equal(meta.common.title, 'How This Ends')
  assert.equal(meta.common.artist, 'Lewis Capaldi')
  assert.equal(meta.common.album, 'Broken by Desire to Be Heavenly Sent (extended edition)')
  assert.deepEqual(meta.common.track, { no: 11, of: null })
  assert.equal(meta.format.codec, 'MP3')
  assert.equal(meta.format.lossless, false)
  assert.equal(meta.format.sampleRate, 48000)
  assert.ok(Math.abs((meta.format.duration ?? 0) - 5.04) < 0.1, `duration ${meta.format.duration}`)
})

test('ffprobe’s tag names map onto the fields the library uses, for FLAC too', async () => {
  const file = path.join(root, 'tagged.flac')
  await ff('-f', 'lavfi', '-i', 'anoisesrc=d=1', '-c:a', 'flac', '-sample_fmt', 's16',
    '-metadata', 'title=Ghosts I', '-metadata', 'artist=Nine Inch Nails', '-metadata', 'album_artist=Nine Inch Nails', '-metadata', 'album=Ghosts I-IV',
    '-metadata', 'track=1/36', '-metadata', 'disc=1/2', '-metadata', 'date=2008-03-02', '-metadata', 'ISRC=USTC10800001', '-metadata', 'MUSICBRAINZ_ALBUMID=f3f1a2b4-0000-4000-8000-000000000000',
    file)
  const meta = await probeTags(file)
  assert.ok(meta)
  assert.deepEqual(
    { ...meta.common },
    {
      track: { no: 1, of: 36 }, disk: { no: 1, of: 2 }, movementIndex: { no: null, of: null }, title: 'Ghosts I', artist: 'Nine Inch Nails', albumartist: 'Nine Inch Nails',
      album: 'Ghosts I-IV', year: 2008, date: '2008-03-02', isrc: ['USTC10800001'], musicbrainz_recordingid: undefined,
      musicbrainz_albumid: 'f3f1a2b4-0000-4000-8000-000000000000',
    },
  )
  assert.equal(meta.format.codec, 'FLAC')
  assert.equal(meta.format.lossless, true)
  assert.equal(meta.format.bitsPerSample, 16)
})

test('a scan keeps files whose tags can’t be parsed: with what ffprobe reads, or named after their path', async () => {
  const dirs = { data: path.join(root, 'data'), music: path.join(root, 'music'), downloads: path.join(root, 'downloads'), import: path.join(root, 'import') }
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))
  Object.assign(process.env, {
    SEEKER_DATA_DIR: dirs.data, SEEKER_MUSIC_DIR: dirs.music, SEEKER_DOWNLOADS_DIR: dirs.downloads, SEEKER_IMPORT_DIR: dirs.import,
    SLSKD_URL: 'http://127.0.0.1:9', SLSKD_API_KEY: 'seeker-test-key', SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
  })
  const { updateSettings } = await import('../server/settings.ts')
  updateSettings({ shares: { autoRescan: false } })
  const { scanLibrary } = await import('../server/library/scan.ts')
  const { readTags } = await import('../server/library/tags.ts')
  const { all } = await import('../server/db.ts')

  const album = path.join(dirs.music, 'Lewis Capaldi', 'Broken by Desire (2023)')
  await fs.mkdir(album, { recursive: true })
  // More junk after a tag that runs past its size than the tag reader searches for audio in.
  const probed = path.join(album, '11 How This Ends.mp3')
  await understatedTag(probed, Buffer.alloc(40 * 1024, 0x41))
  // A tag, then what looks like an AAC frame of length 0, and no audio at all.
  const hopeless = path.join(album, '12 - Nothing Here.mp3')
  const title = text('TIT2', 'Never Read')
  await fs.writeFile(hopeless, Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), synchsafe(title.length), title, Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0]), Buffer.alloc(2048, 0x41)]))
  for (const file of [probed, hopeless]) await assert.rejects(readTags(file), (error: Error) => !isReadError(error))

  const scan = await scanLibrary()
  assert.equal(scan.outcome, 'done', scan.message)
  assert.match(scan.message, /2 with tags Seeker couldn’t read/)
  const rows = all<{ title: string; artist: string; album: string; track_no: number | null; codec: string | null; duration: number | null }>(
    'SELECT title, artist, album, track_no, codec, duration FROM lib_tracks ORDER BY path',
  ).map((row) => ({ ...row, duration: row.duration && Math.round(row.duration) }))
  assert.deepEqual(rows, [
    { title: 'How This Ends', artist: 'Lewis Capaldi', album: 'Broken by Desire to Be Heavenly Sent (extended edition)', track_no: 11, codec: 'MP3', duration: 5 },
    { title: 'Nothing Here', artist: 'Lewis Capaldi', album: 'Broken by Desire', track_no: 12, codec: 'MP3', duration: null },
  ])
})

test('a file ffprobe can’t read either gives null, and read errors are told apart from parse errors', async () => {
  const file = path.join(root, 'noise.mp3')
  await fs.writeFile(file, Buffer.alloc(4096, 7))
  assert.equal(await probeTags(file), null)
  assert.equal(isReadError(Object.assign(new Error('permission denied'), { code: 'EACCES' })), true)
  assert.equal(isReadError(Object.assign(new Error('stale'), { code: 'ESTALE' })), true)
  assert.equal(isReadError(new DOMException('aborted', 'AbortError')), true)
  assert.equal(isReadError(new DOMException('took too long', 'TimeoutError')), true)
  assert.equal(isReadError(new Error('Invalid ADTS frame length: 0')), false)
})
