// Reading tags for the library: the same results as music-metadata's own parse, MP3s without
// reading their cover art, every read counted, and aborts.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { parseFile } from 'music-metadata'
import type { IAudioMetadata } from 'music-metadata'
import { readTags } from '../server/library/tags.ts'
import { writeTags } from '../server/post/tag.ts'

const run = promisify(execFile)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-tags-')))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const at = (name: string) => path.join(root, name)
const ff = (...args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

// Audio without tags: CBR with a LAME Info header, VBR with a Xing header, CBR with neither (its
// length comes from the file size). Noise, so frames are full.
await Promise.all([
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=2:seed=1', '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', at('cbr.mp3')),
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=2:seed=2', '-c:a', 'libmp3lame', '-q:a', '4', '-id3v2_version', '0', at('vbr.mp3')),
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=2:seed=3', '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_xing', '0', at('bare.mp3')),
  ff('-f', 'lavfi', '-i', 'nullsrc=s=400x400,geq=random(1)*255:random(1)*255:random(1)*255', '-frames:v', '1', at('art.png')),
])
const audio = {
  cbr: await fs.readFile(at('cbr.mp3')),
  vbr: await fs.readFile(at('vbr.mp3')),
  bare: await fs.readFile(at('bare.mp3')),
}

// Every byte read from files goes through FileHandle.read.
const probe = await fs.open(at('cbr.mp3'))
const FileHandleProto = Object.getPrototypeOf(probe)
await probe.close()
const realRead = FileHandleProto.read
let bytesRead = 0
let reads = 0
FileHandleProto.read = async function (...args: unknown[]) {
  const result = await realRead.apply(this, args)
  bytesRead += result.bytesRead
  reads++
  return result
}

async function measure(file: string) {
  let reported = 0
  bytesRead = 0
  reads = 0
  const meta = await readTags(file, { onBytes: (bytes) => (reported += bytes) })
  return { meta, bytes: bytesRead, reads, reported }
}

// What the library takes from a file (readTrack in scan.ts).
function fields(meta: IAudioMetadata) {
  const { common, format } = meta
  return {
    title: common.title,
    artist: common.artist,
    albumartist: common.albumartist,
    album: common.album,
    track: common.track.no,
    disk: common.disk.no,
    year: common.year,
    date: common.date,
    isrc: common.isrc,
    mbTrack: common.musicbrainz_recordingid,
    mbAlbum: common.musicbrainz_albumid,
    duration: format.duration,
    codec: format.codec,
    container: format.container,
    bitrate: format.bitrate,
    sampleRate: format.sampleRate,
    bitsPerSample: format.bitsPerSample,
    lossless: format.lossless,
  }
}
type Fields = ReturnType<typeof fields>

const oldRead = (file: string) => parseFile(file, { skipCovers: true, duration: false })

// readTags gives what parseFile gave, and `expected` on top.
async function same(file: string, expected: Partial<Fields> = {}) {
  const { meta, bytes } = await measure(file)
  const after = fields(meta)
  assert.deepEqual(after, fields(await oldRead(file)), path.basename(file))
  assert.deepEqual(after, { ...after, ...expected }, path.basename(file))
  return { fields: after, bytes }
}

// A hand-built ID3v2 tag, so versions, frame order, flags and padding are under control.
interface Frame {
  id: string
  body: Buffer
  flags?: [number, number]
}
interface TagOptions {
  padding?: number
  extended?: boolean
  footer?: boolean
  plainSizes?: boolean
  unsync?: boolean
}
// Encodings: 0 latin1, 1 UTF-16 with a byte order mark, 3 UTF-8 (v2.4).
const encode = (value: string, encoding: number) =>
  encoding === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]) : Buffer.from(value, encoding === 3 ? 'utf8' : 'latin1')
const text = (id: string, value: string, encoding = 0): Frame => ({ id, body: Buffer.concat([Buffer.from([encoding]), encode(value, encoding)]) })
const txxx = (id: string, description: string, value: string, encoding = 0): Frame => ({
  id,
  body: Buffer.concat([Buffer.from([encoding]), encode(description, encoding), Buffer.alloc(encoding === 1 ? 2 : 1), encode(value, encoding)]),
})
const ufid = (id: string, value: string): Frame => ({ id, body: Buffer.from(`http://musicbrainz.org\0${value}`, 'latin1') })
const picture = (major: number, size: number): Frame => ({
  id: major === 2 ? 'PIC' : 'APIC',
  body: Buffer.concat([Buffer.from(major === 2 ? '\0JPG\x03\0' : '\0image/jpeg\0\x03\0', 'latin1'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size)]),
})
const blob = (id: string, size: number): Frame => ({ id, body: randomBytes(size) })
const synchsafe = (n: number) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

// A zero byte after every 0xFF that a decoder could take for the start of an MPEG frame.
function unsynchronise(data: Buffer): Buffer {
  const out: number[] = []
  for (let i = 0; i < data.length; i++) {
    out.push(data[i]!)
    if (data[i] === 0xff && (i + 1 === data.length || data[i + 1]! >= 0xe0 || data[i + 1] === 0)) out.push(0)
  }
  return Buffer.from(out)
}

function id3(major: 2 | 3 | 4, frames: Frame[], options: TagOptions = {}): Buffer {
  let body: Buffer = Buffer.concat(
    frames.map((frame) => {
      const size = frame.body.length
      const header =
        major === 2
          ? [...Buffer.from(frame.id, 'latin1'), (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]
          : [...Buffer.from(frame.id, 'latin1'), ...(major === 4 && !options.plainSizes ? synchsafe(size) : be32(size)), ...(frame.flags ?? [0, 0])]
      return Buffer.concat([Buffer.from(header), frame.body])
    }),
  )
  if (options.unsync) body = unsynchronise(body)
  const extended = !options.extended ? Buffer.alloc(0) : major === 4 ? Buffer.from([0, 0, 0, 6, 1, 0]) : Buffer.from([0, 0, 0, 6, 0, 0, 0, 0, 0, 0])
  const size = extended.length + body.length + (options.padding ?? 0)
  const flags = (options.unsync ? 0x80 : 0) | (options.extended ? 0x40 : 0) | (options.footer ? 0x10 : 0)
  const footer = options.footer ? Buffer.from([0x33, 0x44, 0x49, major, 0, flags, ...synchsafe(size)]) : Buffer.alloc(0)
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, major, 0, flags, ...synchsafe(size)]), extended, body, Buffer.alloc(options.padding ?? 0), footer])
}

function id3v1(fields: { title?: string; artist?: string; album?: string; year?: string; track?: number }): Buffer {
  const tag = Buffer.alloc(128)
  tag.write('TAG', 0, 'latin1')
  tag.write(fields.title ?? '', 3, 30, 'latin1')
  tag.write(fields.artist ?? '', 33, 30, 'latin1')
  tag.write(fields.album ?? '', 63, 30, 'latin1')
  tag.write(fields.year ?? '', 93, 4, 'latin1')
  tag[126] = fields.track ?? 0
  tag[127] = 12
  return tag
}

function apev2(items: Record<string, string>): Buffer {
  const entries = Object.entries(items).map(([key, value]) => {
    const header = Buffer.alloc(8)
    header.writeUInt32LE(Buffer.byteLength(value), 0)
    return Buffer.concat([header, Buffer.from(`${key}\0`, 'ascii'), Buffer.from(value, 'utf8')])
  })
  const body = Buffer.concat(entries)
  const footer = Buffer.alloc(32)
  footer.write('APETAGEX', 0, 'ascii')
  footer.writeUInt32LE(2000, 8)
  footer.writeUInt32LE(body.length + 32, 12)
  footer.writeUInt32LE(entries.length, 16)
  return Buffer.concat([body, footer])
}

async function mp3(name: string, ...parts: Buffer[]) {
  await fs.writeFile(at(name), Buffer.concat(parts))
  return at(name)
}

const MB_TRACK = '4f2a7b3e-1c0d-4e6f-9a8b-7c6d5e4f3a2b'
const MB_ALBUM = '0e1d2c3b-4a59-4687-b7a6-958473625140'
const COVER = 4 * 1024 * 1024
const BUDGET = 64 * 1024

test('ffmpeg’s v2.3 and v2.4 tags, with cover art, read as music-metadata reads them', async () => {
  for (const version of ['3', '4']) {
    const file = at(`ffmpeg-v2${version}.mp3`)
    await ff(
      '-i', at('cbr.mp3'), '-i', at('art.png'), '-map', '0', '-map', '1', '-c', 'copy', '-disposition:v', 'attached_pic', '-id3v2_version', version,
      '-metadata', 'title=Ghosts I', '-metadata', 'artist=Nine Inch Nails', '-metadata', 'album=Ghosts I–IV', '-metadata', 'album_artist=NIN',
      '-metadata', 'track=3/12', '-metadata', 'disc=1/2', '-metadata', 'date=2008', '-metadata', 'TSRC=USXYZ0800003',
      '-metadata', `MusicBrainz Album Id=${MB_ALBUM}`,
      file,
    )
    const { bytes } = await same(file, { title: 'Ghosts I', artist: 'Nine Inch Nails', album: 'Ghosts I–IV', albumartist: 'NIN', track: 3, disk: 1, year: 2008, isrc: ['USXYZ0800003'], mbAlbum: MB_ALBUM })
    assert.ok(bytes < BUDGET, `v2.${version}: read ${bytes} bytes of ${(await fs.stat(file)).size}`)
  }
})

test('tags written by Seeker read as music-metadata reads them, without reading the cover', async () => {
  const file = await mp3('seeker.mp3', audio.vbr)
  writeTags(
    file,
    {
      title: 'Discipline', artists: ['Nine Inch Nails', 'Trent Reznor'], albumArtist: 'Nine Inch Nails', album: 'The Slip', year: 2008,
      track: 2, trackCount: 10, disc: 1, discCount: 1, genres: ['Industrial'], isrc: 'USXYZ0800010', label: 'The Null Corporation',
      mbRecordingId: MB_TRACK, mbReleaseId: MB_ALBUM,
    },
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(COVER)]),
  )
  const { bytes } = await same(file, { title: 'Discipline', album: 'The Slip', albumartist: 'Nine Inch Nails', track: 2, year: 2008, isrc: ['USXYZ0800010'], mbTrack: MB_TRACK, mbAlbum: MB_ALBUM })
  assert.ok(bytes < BUDGET, `read ${bytes} bytes`)
})

// Each case has a picture bigger than the budget, so reading less shows the tag was walked rather
// than handed to music-metadata whole.
test('hand-built v2.2, v2.3 and v2.4 tags read as music-metadata reads them', async () => {
  const size = 1024 * 1024
  const indicated = text('TIT2', 'Indicated', 3)
  const cases: Array<[string, Buffer, Partial<Fields>]> = [
    [
      'v22.mp3',
      id3(2, [picture(2, size), text('TT2', 'Ghosts II'), text('TP1', 'Nine Inch Nails'), text('TP2', 'NIN'), text('TAL', 'Ghosts I–IV', 1), text('TRK', '3/12'), text('TPA', '1/2'), text('TYE', '2008'), txxx('TXX', 'MusicBrainz Album Id', MB_ALBUM), ufid('UFI', MB_TRACK)], { padding: 300 }),
      { title: 'Ghosts II', artist: 'Nine Inch Nails', album: 'Ghosts I–IV', track: 3, disk: 1, year: 2008 },
    ],
    [
      'v23.mp3',
      id3(3, [blob('PRIV', 900), text('TIT2', 'Ghosts III', 1), text('TPE1', 'Nine Inch Nails/Atticus Ross', 1), text('TALB', 'Ghosts I–IV', 1), text('TRCK', '3/12'), text('TPOS', '2/2'), text('TYER', '2008'), text('TDAT', '0203'), text('TSRC', 'USXYZ0800003'), txxx('TXXX', 'MusicBrainz Album Id', MB_ALBUM, 1), ufid('UFID', MB_TRACK), picture(3, size), blob('GEOB', 5000)], { extended: true, padding: 1024 }),
      { title: 'Ghosts III', album: 'Ghosts I–IV', track: 3, disk: 2, isrc: ['USXYZ0800003'], mbTrack: MB_TRACK, mbAlbum: MB_ALBUM },
    ],
    [
      'v24.mp3',
      id3(4, [text('TIT2', 'Ghosts IV ✓', 3), text('TPE1', 'Nine Inch Nails\0Atticus Ross', 3), text('TPE2', 'Nine Inch Nails', 3), text('TALB', 'Ghosts I–IV', 3), text('TRCK', '4/36'), text('TPOS', '1'), text('TDRC', '2008-03-02'), text('TSRC', 'USXYZ0800004'), txxx('TXXX', 'MusicBrainz Album Id', MB_ALBUM, 3), ufid('UFID', MB_TRACK), picture(4, size)], { extended: true, footer: true }),
      { title: 'Ghosts IV ✓', albumartist: 'Nine Inch Nails', album: 'Ghosts I–IV', track: 4, disk: 1, year: 2008, date: '2008-03-02', mbTrack: MB_TRACK, mbAlbum: MB_ALBUM },
    ],
    [
      // v2.4 frames with a data length indicator, and with their own unsynchronisation.
      'v24-flags.mp3',
      id3(4, [
        { id: 'TIT2', body: Buffer.concat([Buffer.from(synchsafe(indicated.body.length)), indicated.body]), flags: [0, 0x01] },
        { id: 'TPE1', body: unsynchronise(text('TPE1', 'Ünsynced', 1).body), flags: [0, 0x02] },
        picture(4, size),
        text('TALB', 'Flags'),
      ]),
      { title: 'Indicated', artist: 'Ünsynced', album: 'Flags' },
    ],
    [
      // A newer tag in front of an older one, as some taggers leave them: music-metadata reads both.
      'two-tags.mp3',
      Buffer.concat([id3(4, [text('TIT2', 'Newer'), text('TPE1', 'Artist'), picture(4, size)]), id3(3, [text('TIT2', 'Older'), text('TALB', 'Album'), picture(3, size)], { padding: 100 })]),
      { title: 'Newer', artist: 'Artist', album: 'Album' },
    ],
  ]
  for (const [name, tag, expected] of cases) {
    const { bytes } = await same(await mp3(name, tag, name === 'v24-flags.mp3' ? audio.vbr : audio.cbr), expected)
    assert.ok(bytes < BUDGET, `${name}: read ${bytes} bytes`)
  }
})

test('MP3s read under 64 kB with a 4 MB cover first or last, and the tags around it are found', async () => {
  for (const [name, tag] of [
    ['cover-first.mp3', id3(3, [picture(3, COVER), text('TIT2', 'First'), text('TPE1', 'Artist'), text('TALB', 'Album')], { padding: 2048 })],
    ['cover-last.mp3', id3(4, [text('TIT2', 'Last'), text('TPE1', 'Artist'), text('TALB', 'Album'), picture(4, COVER)])],
    ['covers-v22.mp3', id3(2, [picture(2, COVER), text('TT2', 'Twice'), picture(2, COVER), text('TP1', 'Artist'), text('TAL', 'Album')])],
  ] as const) {
    const file = await mp3(name, tag, audio.cbr)
    const { meta, bytes, reported, reads: count } = await measure(file)
    assert.ok(bytes < BUDGET, `${name}: read ${bytes} bytes in ${count} reads`)
    assert.ok(count <= 4, `${name}: ${count} reads`)
    assert.equal(reported, bytes, `${name}: onBytes reported every read`)
    assert.equal(meta.common.artist, 'Artist')
    assert.equal(meta.common.album, 'Album')
    assert.deepEqual(fields(meta), fields(await oldRead(file)), name)
  }
})

test('durations of CBR, VBR and header-less MP3s come out as before', async () => {
  const tag = id3(3, [text('TIT2', 'Length'), text('TPE1', 'Artist'), text('TALB', 'Album'), picture(3, COVER)])
  for (const [name, data] of Object.entries(audio)) {
    const { fields: { duration }, bytes } = await same(await mp3(`length-${name}.mp3`, tag, data))
    assert.ok(duration && Math.abs(duration - 2) < 0.1, `${name}: ${duration}`)
    assert.ok(bytes < BUDGET, `${name}: read ${bytes} bytes`)
  }
})

test('ID3v1 and APEv2 tags are read when the ID3v2 tag lacks the title, artist or album', async () => {
  const v1 = id3v1({ title: 'Only In V1', artist: 'Old Tagger', album: 'Tail', year: '1999', track: 7 })
  await same(await mp3('v1-only.mp3', audio.cbr, v1), { title: 'Only In V1', artist: 'Old Tagger', album: 'Tail', track: 7, year: 1999 })
  // An ID3v2 tag holding just the encoder, or just a cover: the real tags are in ID3v1.
  await same(await mp3('encoder-only.mp3', id3(4, [text('TSSE', 'LAME 3.100')]), audio.cbr, v1), { title: 'Only In V1', artist: 'Old Tagger', album: 'Tail' })
  const coverOnly = await same(await mp3('cover-only.mp3', id3(3, [picture(3, COVER)]), audio.bare, v1), { title: 'Only In V1', artist: 'Old Tagger', album: 'Tail' })
  // A title in ID3v2, the rest at the end: ID3v2 wins where both have it, as before.
  const split = await same(await mp3('split.mp3', id3(3, [picture(3, COVER), text('TIT2', 'From V2')]), audio.cbr, v1), { title: 'From V2', artist: 'Old Tagger', album: 'Tail' })
  await same(await mp3('ape.mp3', id3(3, [text('TSSE', 'LAME')]), audio.vbr, apev2({ Title: 'From APE', Artist: 'Ape Artist', Album: 'Ape Album' }), v1), { title: 'From APE', artist: 'Ape Artist', album: 'Ape Album' })
  // Still without reading the covers.
  assert.ok(coverOnly.bytes < BUDGET, `read ${coverOnly.bytes} bytes`)
  assert.ok(split.bytes < BUDGET, `read ${split.bytes} bytes`)
})

test('tags that can’t be walked frame by frame fall back to music-metadata, with the same results', async () => {
  // Tag-wide unsynchronisation in v2.3: frame sizes don't match the bytes on disk.
  await same(await mp3('unsync.mp3', id3(3, [text('TIT2', 'Ünsynced title', 1), text('TPE1', 'Artist', 1), text('TALB', 'Album')], { unsync: true }), audio.cbr), { title: 'Ünsynced title', artist: 'Artist', album: 'Album' })
  // A frame id music-metadata only warns about, and a frame running past the end of the tag.
  const garbage = id3(3, [text('TIT2', 'Before'), blob('pr!v', 40), text('TPE1', 'After')])
  await same(await mp3('bad-id.mp3', garbage, audio.cbr))
  const overrun = id3(3, [text('TIT2', 'Overrun'), text('TPE1', 'Artist')])
  overrun.writeUInt32BE(5000, 10 + 18 + 4) // TPE1's size, after the tag header and TIT2
  await same(await mp3('overrun.mp3', overrun, audio.cbr))
  await same(await mp3('noise.mp3', Buffer.from('ID3\x03\x00\x00\x00\x00\x10\x00', 'latin1'), randomBytes(2048), audio.cbr))
  // A tag bigger than the file: both refuse it the same way.
  const truncated = await mp3('truncated.mp3', id3(3, [text('TIT2', 'Cut'), picture(3, 100_000)]).subarray(0, 20_000))
  await assert.rejects(oldRead(truncated))
  await assert.rejects(readTags(truncated))
})

test('v2.4 tags with plain frame sizes, as old iTunes wrote them, are read whole', async () => {
  // music-metadata reads these sizes as synchsafe and loses its way after the first big frame.
  const file = await mp3(
    'itunes.mp3',
    id3(4, [text('TIT2', `Long title ${'x'.repeat(200)}`), blob('PRIV', 300), text('TPE1', 'iTunes Artist'), picture(4, COVER), text('TALB', 'iTunes Album')], { plainSizes: true, padding: 512 }),
    audio.cbr,
  )
  const { meta, bytes } = await measure(file)
  assert.equal(meta.common.title, `Long title ${'x'.repeat(200)}`)
  assert.equal(meta.common.artist, 'iTunes Artist')
  assert.equal(meta.common.album, 'iTunes Album')
  assert.ok(bytes < BUDGET, `read ${bytes} bytes`)
})

test('other formats read as music-metadata reads them', async () => {
  const tags = ['-metadata', 'title=Other', '-metadata', 'artist=Formats', '-metadata', 'album=Tested']
  await Promise.all([
    ff('-f', 'lavfi', '-i', 'anoisesrc=d=1:seed=6', '-i', at('art.png'), '-map', '0', '-map', '1', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic', ...tags, at('other.flac')),
    ff('-f', 'lavfi', '-i', 'anoisesrc=d=1:seed=7', '-c:a', 'aac', '-b:a', '96k', ...tags, at('other.m4a')),
    ff('-f', 'lavfi', '-i', 'anoisesrc=d=1:seed=8', '-c:a', 'pcm_s16le', ...tags, at('other.wav')),
    ff('-f', 'lavfi', '-i', 'anoisesrc=d=1:seed=9', '-ac', '2', '-c:a', 'vorbis', '-strict', '-2', ...tags, at('short.ogg')),
  ])
  for (const name of ['other.flac', 'other.m4a', 'other.wav', 'short.ogg']) await same(at(name), { title: 'Other' })
})

test('an abort stops reading and the file is closed either way', async (t) => {
  const file = at('cover-first.mp3')
  const open = t.mock.method(fs, 'open')

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(readTags(file, { signal: aborted.signal }), { name: 'AbortError' })
  assert.equal(open.mock.callCount(), 0, 'nothing opened')

  const midway = new AbortController()
  let count = 0
  await assert.rejects(
    readTags(file, { signal: midway.signal, onBytes: () => (++count === 1 ? midway.abort(new Error('scan stopped')) : undefined) }),
    /scan stopped/,
  )
  assert.equal(count, 1, 'no read after the abort')

  await assert.rejects(readTags(at('truncated.mp3')))
  await readTags(file)
  const opened = await Promise.all(open.mock.calls.map((call) => call.result as Promise<FileHandle>))
  assert.equal(opened.length, 3)
  for (const handle of opened) assert.equal(handle.fd, -1, 'closed')
})
