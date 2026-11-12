import { randomUUID } from 'node:crypto'
import type { JobTarget, SlskFolder, SlskSearch } from '../../shared/types.ts'
import { buildAlbumTarget } from '../catalog.ts'
import { getSettings } from '../settings.ts'
import { errorMessage } from '../util.ts'
import { groupFolders, scoreFolder, type Folder } from './album.ts'
import { candidatesFrom, type Candidate } from './files.ts'
import { qualityLabel, qualityOf } from './quality.ts'
import { searchSoulseek } from './search.ts'

interface ManualSearch {
  id: string
  query: string
  albumId: number | null
  state: string
  complete: boolean
  responses: number
  files: number
  folders: SlskFolder[]
  error: string | null
  createdAt: number
}

const searches = new Map<string, ManualSearch>()

function cleanup() {
  const cutoff = Date.now() - 30 * 60_000
  for (const [id, search] of searches) if (search.createdAt < cutoff) searches.delete(id)
}

function peerScore(folder: Folder): number {
  const peer = folder.files[0]!.peer
  return (peer.freeSlot ? 0.5 : 0) + Math.min(peer.speed / 2_000_000, 1) * 0.3 + (peer.queue === 0 ? 0.2 : peer.queue < 10 ? 0.1 : 0)
}

function toFolder(folder: Folder, target: JobTarget | null): SlskFolder {
  const quality = getSettings().quality
  const labels = new Map<string, number>()
  for (const file of folder.files) {
    const label = qualityLabel(file)
    labels.set(label, (labels.get(label) ?? 0) + 1)
  }
  const acceptable = folder.files.some((file) => qualityOf(file, quality) !== null)
  let matched: number | null = null
  let expected: number | null = null
  let score = (acceptable ? 0.5 : 0) + Math.min(folder.files.length / 12, 1) * 0.2 + peerScore(folder) * 0.3
  const trackOf = new Map<Candidate, number>()
  if (target) {
    const scored = scoreFolder(target.album, target.tracks, folder, quality)
    matched = scored.pairs.size
    expected = target.tracks.length
    score = scored.score + (acceptable ? 0.2 : 0)
    for (const [index, file] of scored.pairs) trackOf.set(file, index)
  }
  const files = [...folder.files].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
  return {
    key: folder.key,
    username: folder.username,
    folder: folder.dir,
    files: files.map((file) => ({
      filename: file.filename,
      name: file.name,
      size: file.size,
      ext: file.ext,
      bitrate: file.bitrate,
      bitDepth: file.bitDepth,
      sampleRate: file.sampleRate,
      length: file.length,
      vbr: file.vbr,
      matchedTrack: trackOf.get(file) ?? null,
    })),
    freeSlot: folder.files[0]!.peer.freeSlot,
    speed: folder.files[0]!.peer.speed,
    queue: folder.files[0]!.peer.queue,
    quality: [...labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
    acceptable,
    size: folder.files.reduce((sum, file) => sum + file.size, 0),
    matched,
    expected,
    score,
  }
}

function snapshot(search: ManualSearch): SlskSearch {
  return {
    id: search.id,
    query: search.query,
    state: search.error ? `Error: ${search.error}` : search.state,
    complete: search.complete,
    responses: search.responses,
    files: search.files,
    folders: search.folders,
  }
}

export function startManualSearch(query: string, albumId: number | null): SlskSearch {
  cleanup()
  const search: ManualSearch = {
    id: randomUUID(),
    query: query.trim(),
    albumId,
    state: 'Queued',
    complete: false,
    responses: 0,
    files: 0,
    folders: [],
    error: null,
    createdAt: Date.now(),
  }
  searches.set(search.id, search)
  void (async () => {
    try {
      const target = albumId ? await buildAlbumTarget(albumId) : null
      const outcome = await searchSoulseek(search.query, {
        interactive: true,
        idleTimeoutMs: 8000,
        deadlineMs: 30_000,
        onProgress: (progress) => {
          search.state = progress.state
          search.responses = progress.responses
          search.files = progress.files
        },
      })
      const candidates = candidatesFrom(outcome.responses)
      search.responses = outcome.responses.length
      search.files = candidates.length
      search.folders = groupFolders(candidates)
        .map((folder) => toFolder(folder, target))
        .sort((a, b) => b.score - a.score)
        .slice(0, 200)
      search.state = outcome.state
    } catch (error) {
      search.error = errorMessage(error)
    } finally {
      search.complete = true
    }
  })()
  return snapshot(search)
}

export function getManualSearch(id: string): SlskSearch | null {
  const search = searches.get(id)
  return search ? snapshot(search) : null
}
