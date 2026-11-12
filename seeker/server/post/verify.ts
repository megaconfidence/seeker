import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { logger } from '../log.ts'
import { similarity } from '../match/normalize.ts'

const log = logger('verify')

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve(null)
        return
      }
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export interface AudioInfo {
  duration: number | null
  codec: string | null
  lossless: boolean
  sampleRate: number | null
  bitDepth: number | null
  bitrate: number | null
}

export async function probe(file: string): Promise<AudioInfo> {
  const meta = await parseFile(file, { duration: true, skipCovers: true })
  let duration = meta.format.duration ?? null
  if (!duration) {
    const result = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 60_000)
    const parsed = result ? Number.parseFloat(result.stdout) : Number.NaN
    if (Number.isFinite(parsed)) duration = parsed
  }
  return {
    duration,
    codec: meta.format.codec ?? meta.format.container ?? null,
    lossless: !!meta.format.lossless,
    sampleRate: meta.format.sampleRate ?? null,
    bitDepth: meta.format.bitsPerSample ?? null,
    bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null,
  }
}

export function durationProblem(actual: number | null, expected: number | undefined): string | null {
  if (!expected || !actual) return null
  const tolerance = expected > 600 ? 5 : 3
  if (actual < expected - tolerance) return `file is ${Math.round(expected - actual)} s shorter than the track`
  if (actual > expected + Math.max(tolerance, 15)) return `file is ${Math.round(actual - expected)} s longer than the track`
  return null
}

export async function decodeProblem(file: string): Promise<string | null> {
  const result = await run('ffmpeg', ['-hide_banner', '-nostats', '-v', 'error', '-i', file, '-f', 'null', '-'], 180_000)
  if (!result) return null
  const errors = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (result.code !== 0) return `file does not decode (${errors[0] ?? 'ffmpeg failed'})`
  if (errors.length > 20) return `file has decoding errors (${errors.length} problems)`
  return null
}

function dbToPower(db: number): number {
  return 10 ** (db / 10)
}

function powerToDb(power: number): number {
  return power > 0 ? 10 * Math.log10(power) : -120
}

// Lossless files made from MP3s have almost nothing above the MP3 encoder's low-pass (~16-17 kHz at
// 128 kbps). Measure energy above a few cutoffs and look for a cliff instead of a gentle roll-off.
export async function fakeLosslessProblem(file: string, sampleRate: number | null): Promise<string | null> {
  if (sampleRate && sampleRate < 44_100) return null
  const cutoffs = [14_000, 16_500, 18_000, 20_000]
  const chains = cutoffs
    .map((cutoff, index) => `[s${index}]${Array(4).fill(`highpass=f=${cutoff}`).join(',')},volumedetect@b${index}[o${index}]`)
    .join(';')
  const graph = `[0:a]aformat=channel_layouts=mono,asplit=${cutoffs.length}${cutoffs.map((_, i) => `[s${i}]`).join('')};${chains}`
  const args = ['-hide_banner', '-nostats', '-ss', '15', '-t', '60', '-i', file, '-filter_complex', graph]
  for (let i = 0; i < cutoffs.length; i++) args.push('-map', `[o${i}]`, '-f', 'null', '-')
  const result = await run('ffmpeg', args, 120_000)
  if (!result) return null
  const levels = new Map<number, number>()
  for (const match of result.stderr.matchAll(/volumedetect@b(\d) @ [^\]]+\] mean_volume: (-?[\d.]+|-inf) dB/g)) {
    levels.set(Number(match[1]), match[2] === '-inf' ? -120 : Number(match[2]))
  }
  if (levels.size !== cutoffs.length) return null
  const above = cutoffs.map((_, index) => dbToPower(levels.get(index)!))
  const band14 = powerToDb(above[0]! - above[1]!)
  const band16 = powerToDb(above[1]! - above[2]!)
  const band18 = powerToDb(above[2]! - above[3]!)
  if (band14 < -70) return null
  const cliffAt17 = band18 - band14 < -28 && band18 < -78 && band16 - band18 > 12
  const cliffAt16 = band14 - band16 > 25 && band16 < -78
  if (cliffAt17 || cliffAt16) {
    return `looks like a lossy file converted to lossless (nothing above ~${cliffAt16 ? 16 : 17} kHz)`
  }
  return null
}

export async function sizeProblem(file: string): Promise<string | null> {
  const stat = await fs.stat(file)
  return stat.size < 10 * 1024 ? 'file is too small to be a real track' : null
}

export interface FingerprintVerdict {
  ok: boolean
  detail: string
}

interface AcoustidResponse {
  status: string
  error?: { code: number; message: string }
  results?: { score: number; recordings?: { id: string; title?: string; artists?: { name: string }[] }[] }[]
}

async function fingerprintOf(file: string): Promise<{ duration: number; fingerprint: string } | 'missing' | null> {
  const result = await run('fpcalc', ['-json', '-length', '120', file], 60_000)
  if (!result) return 'missing'
  if (result.code !== 0) return null
  try {
    return JSON.parse(result.stdout) as { duration: number; fingerprint: string }
  } catch {
    return null
  }
}

async function acoustidLookup(fingerprint: { duration: number; fingerprint: string }, key: string): Promise<AcoustidResponse> {
  const body = new URLSearchParams({
    client: key,
    meta: 'recordings',
    duration: String(Math.round(fingerprint.duration)),
    fingerprint: fingerprint.fingerprint,
  })
  const response = await fetch('https://api.acoustid.org/v2/lookup', { method: 'POST', body, signal: AbortSignal.timeout(20_000) })
  return (await response.json()) as AcoustidResponse
}

const warnedKeys = new Set<string>()

// Checks a key by fingerprinting a short generated tone; AcoustID rejects bad keys before matching anything.
export async function testAcoustidKey(key: string): Promise<{ ok: boolean; message: string }> {
  if (!key) return { ok: false, message: 'No key set' }
  const tone = path.join(os.tmpdir(), `seeker-acoustid-${process.pid}.wav`)
  try {
    const made = await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', tone], 30_000)
    if (!made || made.code !== 0) return { ok: false, message: 'ffmpeg is needed to test the key' }
    const fingerprint = await fingerprintOf(tone)
    if (fingerprint === 'missing') return { ok: false, message: 'fpcalc (Chromaprint) isn’t installed, so fingerprint checks can’t run' }
    if (!fingerprint) return { ok: false, message: 'Could not fingerprint a test tone' }
    const data = await acoustidLookup(fingerprint, key)
    if (data.status === 'ok') return { ok: true, message: 'AcoustID accepted the key' }
    if (data.error?.code === 4) {
      return { ok: false, message: 'AcoustID says the key is invalid. Use an application key from acoustid.org/new-application, not your user key.' }
    }
    return { ok: false, message: `AcoustID said: ${data.error?.message ?? data.status}` }
  } catch (error) {
    return { ok: false, message: `Couldn’t reach AcoustID: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await fs.rm(tone, { force: true })
  }
}

// Optional: compare the audio fingerprint with AcoustID. Only a confident, clearly different match fails.
export async function acoustidCheck(
  file: string,
  key: string,
  want: { title: string; artist: string; mbRecordingId?: string },
): Promise<FingerprintVerdict | null> {
  const fingerprint = await fingerprintOf(file)
  if (!fingerprint || fingerprint === 'missing') return null
  try {
    const data = await acoustidLookup(fingerprint, key)
    if (data.status !== 'ok') {
      if (!warnedKeys.has(key)) {
        warnedKeys.add(key)
        log.warn(`AcoustID lookups are failing (${data.error?.message ?? data.status}); fingerprint checks are skipped until that's fixed`)
      }
      return null
    }
    const confident = (data.results ?? []).filter((entry) => entry.score >= 0.8)
    const recordings = confident.flatMap((entry) => entry.recordings ?? [])
    if (recordings.length === 0) return null
    for (const recording of recordings) {
      if (want.mbRecordingId && recording.id === want.mbRecordingId) return { ok: true, detail: 'fingerprint matches' }
      const titleScore = similarity(recording.title ?? '', want.title)
      const artistScore = similarity((recording.artists ?? []).map((artist) => artist.name).join(' '), want.artist)
      if (titleScore >= 0.7 && artistScore >= 0.5) return { ok: true, detail: 'fingerprint matches' }
    }
    const best = recordings[0]!
    const artistScore = Math.max(
      ...recordings.map((recording) => similarity((recording.artists ?? []).map((artist) => artist.name).join(' '), want.artist)),
    )
    if (artistScore < 0.3) {
      return {
        ok: false,
        detail: `fingerprint says this is "${best.title}" by ${(best.artists ?? []).map((artist) => artist.name).join(', ') || 'someone else'}`,
      }
    }
    return null
  } catch (error) {
    log.warn('AcoustID lookup failed', error)
    return null
  }
}
