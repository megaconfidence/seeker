import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { makeUnexpectedFileContentError, parseFromTokenizer, TrackType } from 'music-metadata'
import type { IAudioMetadata, IOptions } from 'music-metadata'
import { AbstractTokenizer, EndOfStreamError, NotRegularFileError } from 'strtok3'
import type { IRandomAccessFileInfo, IReadChunkOptions } from 'strtok3'

export interface TagReadOptions {
  signal?: AbortSignal
  onBytes?: (bytes: number) => void
}

// Files music-metadata reads with its MPEG parser: ID3v2 tag, MPEG (or ADTS) frames, then any
// ID3v1 or APEv2 tag at the end.
const MPEG_EXTENSIONS = new Set(['.mp3', '.aac', '.mp2', '.mp1', '.m2a'])
// music-metadata's default limit for one metadata buffer, which parseFile also gives its tokenizer.
const MAX_BUFFER = 64 * 1024 * 1024

// Reads are at least a page, bigger at the start of the file where most tags are, and grow while
// music-metadata reads on from where the last one ended. A read near the end of the file ends at
// the end, because the tags there (ID3v1, Lyrics3, APEv2) are read backwards.
const PAGE = 4 * 1024
const HEAD = 16 * 1024
const MAX_WINDOW = 64 * 1024
const KEPT_WINDOWS = 8

interface Window {
  start: number
  data: Uint8Array
}

// The file, read a window at a time: music-metadata's many small reads (a frame header here, a few
// bytes there) then cost one read rather than one each. Every read is counted and reported.
class FileSource {
  readonly size: number
  reads = 0
  private readonly handle: FileHandle
  private readonly io: TagReadOptions
  private windows: Window[] = []
  private last: Window | null = null

  constructor(handle: FileHandle, size: number, io: TagReadOptions) {
    this.handle = handle
    this.size = size
    this.io = io
  }

  // The bytes at [position, position + length), fewer at the end of the file (or if it shrank).
  // Often a view into a shared window: don't change it. `window` asks for at least that much when
  // a read is needed.
  async bytes(position: number, length: number, window = 0): Promise<Uint8Array> {
    const end = Math.min(position + length, this.size)
    if (position >= end) return new Uint8Array(0)
    const cached = this.cached(position, end)
    if (cached) return cached
    // When the start was read already, as the end of a window, read on from there.
    const before = this.windows.find((loaded) => position >= loaded.start && position < loaded.start + loaded.data.length)
    const from = before ? before.start + before.data.length : position
    const loaded = end - from > MAX_WINDOW ? { start: from, data: await this.fetch(from, end - from) } : await this.load(from, end, window)
    const rest = loaded.data.subarray(from - loaded.start, end - loaded.start)
    if (!before) return rest
    const joined = new Uint8Array(from - position + rest.length)
    joined.set(before.data.subarray(position - before.start))
    joined.set(rest, from - position)
    return joined
  }

  async read(target: Uint8Array, offset: number, length: number, position: number): Promise<number> {
    length = Math.min(length, this.size - position)
    if (length <= 0) return 0
    if (length > MAX_WINDOW && !this.cached(position, position + length)) return this.readInto(target, offset, length, position)
    const data = await this.bytes(position, length)
    target.set(data, offset)
    return data.length
  }

  private async load(from: number, end: number, window: number): Promise<Window> {
    const last = this.last
    const sequential = last && from >= last.start && from <= last.start + last.data.length + PAGE
    let size = Math.max(from === 0 ? HEAD : sequential ? Math.min(last.data.length * 2, MAX_WINDOW) : PAGE, window, end - from)
    let start = from
    if (from + size > this.size) {
      // Ending at the end of the file, but not reading again what an earlier window holds.
      const read = this.windows.map((loaded) => loaded.start + loaded.data.length).filter((loadedEnd) => loadedEnd <= from)
      start = Math.max(0, this.size - size, ...read)
    }
    size = Math.min(size, this.size - start)
    const loaded: Window = { start, data: await this.fetch(start, size) }
    this.windows.push(loaded)
    if (this.windows.length > KEPT_WINDOWS) this.windows.shift()
    this.last = loaded
    return loaded
  }

  private cached(position: number, end: number): Uint8Array | undefined {
    for (const window of this.windows) {
      if (position >= window.start && end <= window.start + window.data.length) {
        return window.data.subarray(position - window.start, end - window.start)
      }
    }
    return undefined
  }

  private async fetch(position: number, length: number): Promise<Uint8Array> {
    const data = new Uint8Array(length)
    const read = await this.readInto(data, 0, length, position)
    return read < length ? data.subarray(0, read) : data
  }

  private async readInto(target: Uint8Array, offset: number, length: number, position: number): Promise<number> {
    let done = 0
    while (done < length) {
      this.io.signal?.throwIfAborted()
      const { bytesRead } = await this.handle.read(target, offset + done, length - done, position + done)
      this.reads++
      this.io.onBytes?.(bytesRead)
      if (bytesRead === 0) break
      done += bytesRead
    }
    return done
  }
}

// What music-metadata parses: `prefix` (stand-in ID3v2 tags, or nothing), then the file from `from` on.
class Splice {
  readonly source: FileSource
  readonly prefix: Uint8Array
  readonly from: number

  constructor(source: FileSource, prefix: Uint8Array = new Uint8Array(0), from = 0) {
    this.source = source
    this.prefix = prefix
    this.from = from
  }

  get size() {
    return this.prefix.length + this.source.size - this.from
  }

  async read(target: Uint8Array, offset: number, length: number, position: number): Promise<number> {
    let done = 0
    if (position < this.prefix.length) {
      done = Math.min(length, this.prefix.length - position)
      target.set(this.prefix.subarray(position, position + done), offset)
    }
    if (done < length) done += await this.source.read(target, offset + done, length - done, this.from + position + done - this.prefix.length)
    return done
  }
}

// Without random access, music-metadata doesn't look at the end of the file for tags.
class SpliceTokenizer extends AbstractTokenizer {
  fileInfo: IRandomAccessFileInfo
  private readonly splice: Splice
  private readonly randomAccess: boolean

  constructor(splice: Splice, file: string, randomAccess: boolean) {
    super({ maxBufferSize: MAX_BUFFER })
    this.splice = splice
    this.randomAccess = randomAccess
    // The path picks the parser by extension, as parseFile does.
    this.fileInfo = { path: file, size: splice.size }
  }

  supportsRandomAccess() {
    return this.randomAccess
  }

  setPosition(position: number) {
    this.validateLength(position, 'position')
    this.position = position
  }

  async readBuffer(target: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const { length, position, mayBeLess } = this.normalizeOptions(target, options)
    this.position = position
    const read = await this.splice.read(target, 0, length, position)
    this.position += read
    if (read < length && !mayBeLess) throw new EndOfStreamError()
    return read
  }

  async peekBuffer(target: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const { length, position, mayBeLess } = this.normalizeOptions(target, options)
    const read = await this.splice.read(target, 0, length, position)
    if (read < length && !mayBeLess) throw new EndOfStreamError()
    return read
  }
}

function parse(file: string, splice: Splice, randomAccess: boolean, options: IOptions = {}): Promise<IAudioMetadata> {
  return parseFromTokenizer(new SpliceTokenizer(splice, file, randomAccess), { skipCovers: true, duration: false, ...options })
}

// Tags and stream details, read the way parseFile(file, { skipCovers: true, duration: false })
// reads them, but without reading cover art in MP3s, in fewer, bigger reads, and with Ogg
// durations, which that leaves out.
export async function readTags(file: string, options: TagReadOptions = {}): Promise<IAudioMetadata> {
  options.signal?.throwIfAborted()
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new NotRegularFileError(file)
    const source = new FileSource(handle, stat.size, options)
    let meta = MPEG_EXTENSIONS.has(path.extname(file).toLowerCase())
      ? await readMpeg(file, source)
      : await parse(file, new Splice(source), true)
    if (meta.format.container === 'Ogg' && meta.format.duration === undefined) meta = await withOggDuration(meta, source)
    // A parser may have caught the abort and carried on.
    options.signal?.throwIfAborted()
    return meta
  } finally {
    await handle.close()
  }
}

// MP3s: music-metadata reads an ID3v2 tag whole before parsing it, cover art and all, often several
// MB. So the tag is walked here instead, jumping over all but the frames that hold what the library
// uses, and music-metadata parses a stand-in tag of those frames followed by the audio.
async function readMpeg(file: string, source: FileSource): Promise<IAudioMetadata> {
  const tags = await standIn(source)
  if (!tags) return parse(file, new Splice(source), true)
  const splice = new Splice(source, tags.prefix, tags.audioStart)
  if (tags.frames > 0) {
    // First without the end of the file: ID3v1 and APEv2 tags there cost another read, and aren't
    // needed when ID3v2 has the title, artist, album and track number. (skipPostHeaders skips
    // ID3v1 when ID3v2 gave any tag at all.)
    const meta = await parse(file, splice, false, { skipPostHeaders: true })
    const { title, artist, album, track } = meta.common
    if (title && artist && album && track.no && !meta.native.ID3v1) return meta
  }
  return parse(file, splice, true)
}

// Text frames (MusicBrainz ids are in TXXX) and UFID (the MusicBrainz recording id).
const keep = (id: string) => id[0] === 'T' || id === 'UFID' || id === 'UFI'
const FRAME_ID = /^[A-Z0-9]{4}$/
const FRAME_ID_V22 = /^[A-Z0-9]{3}$/
const MAX_KEPT_FRAME = 1024 * 1024
const MAX_KEPT = 16 * 1024 * 1024
// music-metadata's limit on frames in a tag.
const MAX_FRAMES = 100_000
// Beyond this, reading the whole tag is cheaper than walking it.
const MAX_WALK_READS = 64
// Enough for music-metadata's look at the first MPEG frames.
const AUDIO_HEAD = 8 * 1024

interface StandIn {
  prefix: Uint8Array
  audioStart: number
  frames: number
}

interface KeptFrame {
  header: Uint8Array
  body: Uint8Array
}

const isId3 = (bytes: Uint8Array) => bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33
const latin1 = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
const uint32 = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
// As music-metadata decodes it, high bits and all.
const synchsafe = (bytes: Uint8Array, at: number) => (bytes[at + 3]! & 0x7f) | (bytes[at + 2]! << 7) | (bytes[at + 1]! << 14) | (bytes[at]! << 21)
const notSynchsafe = (bytes: Uint8Array, at: number) => ((bytes[at]! | bytes[at + 1]! | bytes[at + 2]! | bytes[at + 3]!) & 0x80) !== 0

// The ID3v2 tags at the start of the file as stand-ins, or null when there are none or they can't be
// walked without reading them whole; music-metadata then reads the file as it is.
async function standIn(source: FileSource): Promise<StandIn | null> {
  const tags: Uint8Array[] = []
  const reads = source.reads
  let offset = 0
  let frames = 0
  let overran = false
  // music-metadata also reads a tag that follows straight after one, which some taggers leave.
  // A footer ("3DI") stops it there, so the footer goes with the audio, where it was skipped before.
  while (!overran && isId3(await source.bytes(offset, 10, HEAD))) {
    const tag = await walkTag(source, offset, reads)
    if (!tag || source.reads - reads > MAX_WALK_READS) return null
    tags.push(tag.bytes)
    frames += tag.frames
    offset = tag.end
    overran = tag.overran
  }
  if (!tags.length) return null
  const audioStart = await findAudio(source, offset, overran)
  await source.bytes(audioStart, AUDIO_HEAD, HEAD)
  const prefix = new Uint8Array(tags.reduce((sum, tag) => sum + tag.length, 0))
  let at = 0
  for (const tag of tags) {
    prefix.set(tag, at)
    at += tag.length
  }
  return { prefix, audioStart, frames }
}

// Anything music-metadata would read differently from the frames found here (a frame id it would
// warn about, a frame running past a tag the audio follows) returns null, so it reads the tag itself.
// Frames that carry on past the declared size, as some taggers write them (issue #2), are walked over
// to find the audio, which music-metadata would look for among them, but not kept: ffmpeg and TagLib
// don't read them either.
async function walkTag(source: FileSource, start: number, reads: number): Promise<{ bytes: Uint8Array; end: number; frames: number; overran: boolean } | null> {
  const header = await source.bytes(start, 10, HEAD)
  if (header.length < 10) return null
  const major = header[3]!
  const flags = header[5]!
  const declared = start + 10 + synchsafe(header, 6)
  if (major < 2 || major > 4 || declared > source.size) return null
  // An unsynchronised v2.2 or v2.3 tag gives frame sizes without the bytes stuffed into it, so frames
  // can't be found without reading it whole. In v2.2 the 0x40 flag means compression.
  if (major < 4 && flags & 0x80) return null
  if (major === 2 && flags & 0x40) return null
  let position = start + 10
  if (flags & 0x40) {
    const extended = await source.bytes(position, 4, HEAD)
    if (extended.length < 4) return null
    // The v2.3 size leaves out its own 4 bytes; the synchsafe v2.4 size includes them.
    const size = major === 4 ? synchsafe(extended, 0) : uint32(extended, 0) + 4
    if (size < (major === 4 ? 6 : 10) || position + size > declared) return null
    position += size
  }
  const headerSize = major === 2 ? 6 : 10
  const kept: KeptFrame[] = []
  let keptBytes = 0
  let count = 0
  // Where frames can run to: the end of the file once they've carried on past the declared size.
  let end = declared
  let overran = false
  for (;;) {
    if (position >= end) {
      // Frames that fill the declared size exactly, and another one straight after it. (Another tag
      // there is music-metadata's to read; "ID3" is a valid v2.2 frame id.)
      if (overran || position !== declared || isId3(await source.bytes(position, 3, HEAD))) break
      if (!(await frameFits(source, major, position, source.size))) break
      overran = true
      end = source.size
    }
    const frame = await source.bytes(position, Math.min(headerSize, end - position), HEAD)
    // Padding, or too little left for a frame: music-metadata stops there too.
    if (frame[0] === 0 || position + headerSize > end) break
    const id = latin1(frame, 0, major === 2 ? 3 : 4)
    if (!(major === 2 ? FRAME_ID_V22 : FRAME_ID).test(id) || (overran && isId3(frame))) {
      if (overran) break
      return null
    }
    if (++count > MAX_FRAMES) return null
    let size = await frameSize(source, frame, major, position, end)
    const body = position + headerSize
    if (body + size > end) {
      if (overran) break
      // Unless the audio starts where the tag says it ends, the frames carry on past that.
      if (await audioAt(source, declared)) return null
      overran = true
      end = source.size
      size = await frameSize(source, frame, major, position, end)
      if (body + size > end) return null
    }
    if (!overran && keep(id) && size <= MAX_KEPT_FRAME) {
      keptBytes += headerSize + size
      if (keptBytes > MAX_KEPT) return null
      const data = await source.bytes(body, size, HEAD)
      if (data.length < size) return null
      kept.push({ header: frame, body: data })
    }
    position = body + size
    if (source.reads - reads > MAX_WALK_READS) return null
  }
  return { bytes: standInTag(header, kept), end: overran ? position : declared, frames: kept.length, overran }
}

async function frameSize(source: FileSource, frame: Uint8Array, major: number, position: number, end: number): Promise<number> {
  if (major === 2) return (frame[3]! << 16) | (frame[4]! << 8) | frame[5]!
  const plain = uint32(frame, 4)
  if (major === 3 || notSynchsafe(frame, 4)) return plain
  // v2.4 sizes are synchsafe, but some writers (old iTunes among them) wrote plain ones. As TagLib
  // does, the plain size wins only when the synchsafe one leads nowhere and the plain one to a frame.
  const size = synchsafe(frame, 4)
  if (size === plain || (await frameAt(source, position + 10 + size, end))) return size
  return (await frameAt(source, position + 10 + plain, end)) ? plain : size
}

// Whether a v2.4 frame that fits in the tag, padding, or the end of the tag is at `position`.
async function frameAt(source: FileSource, position: number, end: number): Promise<boolean> {
  if (position === end) return true
  if (position > end) return false
  const bytes = await source.bytes(position, Math.min(10, end - position), HEAD)
  return bytes.every((byte) => byte === 0) || frameFits(source, 4, position, end)
}

// Whether a frame header with a valid id, of a frame that ends by `end`, is at `position`.
async function frameFits(source: FileSource, major: number, position: number, end: number): Promise<boolean> {
  const headerSize = major === 2 ? 6 : 10
  const bytes = await source.bytes(position, headerSize, HEAD)
  if (bytes.length < headerSize || !(major === 2 ? FRAME_ID_V22 : FRAME_ID).test(latin1(bytes, 0, major === 2 ? 3 : 4))) return false
  const size = major === 2 ? (bytes[3]! << 16) | (bytes[4]! << 8) | bytes[5]! : major === 4 && !notSynchsafe(bytes, 4) ? synchsafe(bytes, 4) : uint32(bytes, 4)
  return position + headerSize + size <= end
}

// The same version and flags, minus the extended header and footer, and the kept frames with their
// own flags, so music-metadata decodes them as it would have (per-frame unsynchronisation, data
// length indicators). Sizes are written anew: synchsafe in v2.4, whatever the original used.
function standInTag(header: Uint8Array, frames: KeptFrame[]): Uint8Array {
  const major = header[3]!
  const headerSize = major === 2 ? 6 : 10
  const size = frames.reduce((sum, frame) => sum + headerSize + frame.body.length, 0)
  const tag = new Uint8Array(10 + size)
  tag.set(header.subarray(0, 5))
  tag[5] = header[5]! & ~0x50
  putSynchsafe(tag, 6, size)
  let at = 10
  for (const { header: frame, body } of frames) {
    tag.set(frame.subarray(0, headerSize), at)
    if (major === 2) {
      tag[at + 3] = (body.length >>> 16) & 0xff
      tag[at + 4] = (body.length >>> 8) & 0xff
      tag[at + 5] = body.length & 0xff
    } else if (major === 3) {
      new DataView(tag.buffer).setUint32(at + 4, body.length)
    } else {
      putSynchsafe(tag, at + 4, body.length)
    }
    tag.set(body, at + headerSize)
    at += headerSize + body.length
  }
  return tag
}

function putSynchsafe(bytes: Uint8Array, at: number, value: number) {
  bytes[at] = (value >>> 21) & 0x7f
  bytes[at + 1] = (value >>> 14) & 0x7f
  bytes[at + 2] = (value >>> 7) & 0x7f
  bytes[at + 3] = value & 0x7f
}

// As music-metadata's own MPEG errors: a parse error, not a read error.
class MpegContentError extends makeUnexpectedFileContentError('MPEG') {}

// How far past the tags the audio is looked for, and how much that reads, room to confirm included.
const AUDIO_SEARCH = 32 * 1024
const AUDIO_READ = 48 * 1024
// kbps by bitrate index 1–14: MPEG-1 layers I, II and III, then MPEG-2 and 2.5 layer I, then II and III.
const BITRATES = [
  [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
]
// By version bits: MPEG-2.5, reserved, MPEG-2, MPEG-1.
const SAMPLE_RATES = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]]

// Where music-metadata should start on the audio, from `offset` just after the tags. It takes the
// first bytes that look like a frame header, so junk there (frames a tag left out of its size, cover
// art) can pass for audio: in issue #2 it took cover art for an ADTS frame of length 0 and failed.
// So, as ffmpeg and TagLib do, the audio starts with a frame header confirmed by the next frame's.
async function findAudio(source: FileSource, offset: number, overran: boolean): Promise<number> {
  for (const length of [AUDIO_HEAD, AUDIO_READ]) {
    const bytes = await source.bytes(offset, length, HEAD)
    // After an intact tag, a frame header where it ends is the audio, as before.
    if (!overran && frameLength(bytes, 0) > 0) return offset
    for (let at = bytes.indexOf(0xff); at !== -1 && at < AUDIO_SEARCH; at = bytes.indexOf(0xff, at + 1)) {
      if (framesAt(bytes, at)) return offset + at
    }
    if (bytes.length < length) break
  }
  // After an intact tag, music-metadata looks for the audio itself, as before.
  if (!overran) return offset
  throw new MpegContentError('No MPEG audio found after the ID3v2 tag')
}

// Whether the audio starts at `position`, after any padding.
async function audioAt(source: FileSource, position: number): Promise<boolean> {
  const bytes = await source.bytes(position, AUDIO_HEAD, HEAD)
  let at = 0
  while (bytes[at] === 0) at++
  return framesAt(bytes, at)
}

// A frame header at `at`, and another of the same stream (version, layer, sample rate) where that
// frame ends.
function framesAt(bytes: Uint8Array, at: number): boolean {
  const next = at + frameLength(bytes, at)
  return next > at && frameLength(bytes, next) > 0 && (bytes[at + 1]! & 0xfe) === (bytes[next + 1]! & 0xfe) && (bytes[at + 2]! & 0x0c) === (bytes[next + 2]! & 0x0c)
}

// The length of the MPEG audio or ADTS frame whose header is at `at`, or 0 when there's none.
function frameLength(bytes: Uint8Array, at: number): number {
  if (at + 6 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) return 0
  const b1 = bytes[at + 1]!
  const b2 = bytes[at + 2]!
  if ((b1 & 0x16) === 0x10) {
    // ADTS (layer bits 00): the length is in the header, and includes it.
    const length = ((bytes[at + 3]! & 0x03) << 11) | (bytes[at + 4]! << 3) | (bytes[at + 5]! >> 5)
    return ((b2 >> 2) & 0x0f) <= 12 && length > ((b1 & 1) === 0 ? 9 : 7) ? length : 0
  }
  const version = (b1 >> 3) & 3
  const layer = 4 - ((b1 >> 1) & 3)
  const rate = SAMPLE_RATES[version]![(b2 >> 2) & 3]
  const kbps = layer < 4 ? BITRATES[version === 3 ? layer - 1 : Math.min(layer + 2, 4)]![(b2 >> 4) - 1] : undefined
  if (!rate || !kbps) return 0
  // music-metadata's sums: samples per frame, and padding slots of 4 bytes in layer I.
  const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152
  return Math.floor(((samples / 8) * kbps * 1000) / rate + ((b2 >> 1) & 1) * (layer === 1 ? 4 : 1))
}

const OGG_PAGE = 0x4f676753 // "OggS"
// The last page is usually a few kB, and never more than 65,307 bytes.
const OGG_TAILS = [16 * 1024, 72 * 1024]

// With duration: false, music-metadata stops reading an Ogg file after its first pages, so it never
// sees the last one, whose granule position is the stream's length in samples. Only the end of the
// file is read for it.
async function withOggDuration(meta: IAudioMetadata, source: FileSource): Promise<IAudioMetadata> {
  const { format } = meta
  const serial = format.trackInfo.find((track) => track.type === TrackType.audio)?.id
  if (serial === undefined || !format.sampleRate) return meta
  let granule: number | null = null
  for (const size of OGG_TAILS) {
    const start = Math.max(0, source.size - size)
    granule = lastGranule(await source.bytes(start, size), start, source.size, serial)
    if (granule !== null || start === 0) break
  }
  if (granule === null) return meta
  let samples = granule
  let rate = format.sampleRate
  if (format.codec === 'Opus') {
    // Opus always counts at 48 kHz, from before the encoder's pre-skip.
    const preSkip = opusPreSkip(await source.bytes(0, HEAD), serial)
    if (preSkip === null) return meta
    samples -= preSkip
    rate = 48_000
  }
  return samples > 0 ? { ...meta, format: { ...format, duration: samples / rate } } : meta
}

// The granule position of the stream's last complete page in `bytes`, which start at `offset`.
function lastGranule(bytes: Uint8Array, offset: number, fileSize: number, serial: number): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = bytes.length - 27; at >= 0; at--) {
    if (view.getUint32(at) !== OGG_PAGE || bytes[at + 4] !== 0) continue
    const segments = bytes[at + 26]!
    if (at + 27 + segments > bytes.length) continue
    let size = 27 + segments
    for (let i = 0; i < segments; i++) size += bytes[at + 27 + i]!
    if (offset + at + size > fileSize || view.getUint32(at + 14, true) !== serial) continue
    const granule = view.getBigUint64(at + 6, true)
    // All ones: no packet ends on this page.
    if (granule !== 0xffffffffffffffffn) return Number(granule)
  }
  return null
}

// From the Opus ID header, on the stream's first page. First pages of all streams lead the file.
function opusPreSkip(bytes: Uint8Array, serial: number): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (at + 27 <= bytes.length && view.getUint32(at) === OGG_PAGE) {
    const segments = bytes[at + 26]!
    const body = at + 27 + segments
    if (body > bytes.length) return null
    let size = 0
    for (let i = 0; i < segments; i++) size += bytes[at + 27 + i]!
    if (view.getUint32(at + 14, true) === serial) {
      return size >= 19 && body + 19 <= bytes.length && latin1(bytes, body, 8) === 'OpusHead' ? view.getUint16(body + 10, true) : null
    }
    at = body + size
  }
  return null
}
