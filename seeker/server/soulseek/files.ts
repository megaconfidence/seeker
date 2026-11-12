import type { SlskdFile, SlskdResponse } from './slskd.ts'

export const AUDIO_EXTENSIONS = new Set([
  'flac', 'mp3', 'm4a', 'mp4', 'aac', 'alac', 'ogg', 'oga', 'opus', 'wav', 'wave', 'aiff', 'aif', 'aifc', 'ape', 'wv',
])

export interface Peer {
  freeSlot: boolean
  speed: number
  queue: number
}

export interface Candidate {
  username: string
  filename: string
  dir: string
  segments: string[]
  name: string
  stem: string
  ext: string
  size: number
  bitrate: number | null
  bitDepth: number | null
  sampleRate: number | null
  length: number | null
  vbr: boolean
  peer: Peer
}

export function splitRemote(remotePath: string): string[] {
  return remotePath.split(/[\\/]+/).filter(Boolean)
}

export function remoteSeparator(remotePath: string): string {
  return remotePath.includes('\\') ? '\\' : '/'
}

export function remoteDir(remotePath: string): string {
  const index = Math.max(remotePath.lastIndexOf('\\'), remotePath.lastIndexOf('/'))
  return index >= 0 ? remotePath.slice(0, index) : ''
}

function positive(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function toCandidate(username: string, file: SlskdFile, peer: Peer): Candidate | null {
  const parts = splitRemote(file.filename)
  const name = parts[parts.length - 1] ?? file.filename
  const dot = name.lastIndexOf('.')
  const ext = (file.extension || (dot > 0 ? name.slice(dot + 1) : '')).toLowerCase().replace(/^\./, '')
  if (!AUDIO_EXTENSIONS.has(ext)) return null
  return {
    username,
    filename: file.filename,
    dir: remoteDir(file.filename),
    segments: parts.slice(0, -1).filter((segment) => !segment.startsWith('@@')),
    name,
    stem: dot > 0 ? name.slice(0, dot) : name,
    ext,
    size: file.size ?? 0,
    bitrate: positive(file.bitRate),
    bitDepth: positive(file.bitDepth),
    sampleRate: positive(file.sampleRate),
    length: positive(file.length),
    vbr: !!file.isVariableBitRate,
    peer,
  }
}

export function candidatesFrom(responses: SlskdResponse[]): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const response of responses) {
    const peer: Peer = {
      freeSlot: !!response.hasFreeUploadSlot,
      speed: response.uploadSpeed ?? 0,
      queue: response.queueLength ?? 0,
    }
    for (const file of response.files ?? []) {
      if (file.isLocked) continue
      const key = `${response.username}\u0000${file.filename}`
      if (seen.has(key)) continue
      seen.add(key)
      const candidate = toCandidate(response.username, file, peer)
      if (candidate) out.push(candidate)
    }
  }
  return out
}

export const candidateKey = (candidate: Pick<Candidate, 'username' | 'filename'>) =>
  `${candidate.username}\u0000${candidate.filename}`
