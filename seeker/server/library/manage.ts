import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../../shared/types.ts'
import { config } from '../config.ts'
import { all, exec, get, transaction } from '../db.ts'
import { emit } from '../events.ts'
import { scheduleJellyfinRefresh } from '../jellyfin.ts'
import { queueAlbum, queueMbAlbum } from '../jobs/engine.ts'
import { removeEmptyDirs } from '../post/fsops.ts'
import { getSettings } from '../settings.ts'
import { toCandidate } from '../soulseek/files.ts'
import { noteLibraryChange } from '../shares.ts'
import { qualityOf } from '../soulseek/quality.ts'
import { rebuildOwnedIndex } from './owned.ts'
import { AUDIO_EXTENSIONS, libraryCounts, scanLibrary } from './scan.ts'

const IMAGE = /\.(jpe?g|png|webp|gif)$/i

const insideLibrary = (file: string) => path.resolve(file).startsWith(config.musicDir + path.sep)

async function hasAudio(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some((name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
  } catch {
    return false
  }
}

// Remove leftover cover images from folders that no longer hold any music, then the folders.
async function tidy(dirs: Set<string>) {
  for (const dir of dirs) {
    if (await hasAudio(dir)) continue
    try {
      for (const name of await fs.readdir(dir)) if (IMAGE.test(name)) await fs.rm(path.join(dir, name), { force: true })
    } catch {
      // already gone
    }
    await removeEmptyDirs(dir, config.musicDir)
  }
}

function changed() {
  rebuildOwnedIndex()
  noteLibraryChange()
  scheduleJellyfinRefresh()
  emit({ type: 'library', ...libraryCounts(), scanning: false })
}

export async function deleteLibraryAlbum(id: string): Promise<number> {
  const tracks = all<{ path: string }>('SELECT path FROM lib_tracks WHERE album_id = ?', [id])
  if (tracks.length === 0) throw new Error('Album not found')
  const dirs = new Set<string>()
  let deleted = 0
  for (const track of tracks) {
    if (!insideLibrary(track.path)) continue
    await fs.rm(track.path, { force: true })
    dirs.add(path.dirname(track.path))
    deleted++
  }
  transaction(() => {
    for (const track of tracks) {
      exec('DELETE FROM lib_tracks WHERE path = ?', [track.path])
      exec('DELETE FROM imports WHERE path = ?', [track.path])
    }
    exec('DELETE FROM lib_albums WHERE id = ?', [id])
  })
  await fs.rm(path.join(config.dataDir, 'covers', `${id}.img`), { force: true })
  await tidy(dirs)
  changed()
  return deleted
}

export async function deleteLibraryTrack(id: number): Promise<void> {
  const track = get<{ path: string; album_id: string }>('SELECT path, album_id FROM lib_tracks WHERE id = ?', [id])
  if (!track) throw new Error('Track not found')
  if (insideLibrary(track.path)) await fs.rm(track.path, { force: true })
  exec('DELETE FROM imports WHERE path = ?', [track.path])
  await tidy(new Set([path.dirname(track.path)]))
  await scanLibrary()
  changed()
}

// The worst quality rung among an album's files, by the user's current quality settings.
export function libraryAlbumRung(id: string): { rung: number; best: boolean } {
  const quality = getSettings().quality
  const rows = all<{
    path: string
    size: number
    duration: number | null
    bitrate: number | null
    sample_rate: number | null
    bit_depth: number | null
  }>('SELECT path, size, duration, bitrate, sample_rate, bit_depth FROM lib_tracks WHERE album_id = ?', [id])
  const peer = { freeSlot: true, speed: 0, queue: 0 }
  const worst = quality.formats.length * 2
  let rung = 0
  for (const row of rows) {
    const candidate = toCandidate(
      'library',
      {
        filename: row.path,
        size: row.size,
        bitRate: row.bitrate ?? undefined,
        sampleRate: row.sample_rate ?? undefined,
        bitDepth: row.bit_depth ?? undefined,
        length: row.duration ?? undefined,
      },
      peer,
    )
    const q = candidate ? qualityOf(candidate, quality) : null
    rung = Math.max(rung, q ? q.rung : worst)
  }
  return { rung, best: rung === 0 }
}

export async function upgradeLibraryAlbum(id: string): Promise<Job> {
  const album = get<{ deezer_album_id: number | null; mb_album_id: string | null; title: string }>(
    'SELECT deezer_album_id, mb_album_id, title FROM lib_albums WHERE id = ?',
    [id],
  )
  if (!album) throw new Error('Album not found')
  const { rung, best } = libraryAlbumRung(id)
  if (best) throw new Error(`${album.title} is already in your preferred quality`)
  const options = { force: true, maxRung: rung, replaceLibraryAlbumId: id }
  if (album.deezer_album_id) return queueAlbum(album.deezer_album_id, 'ui', options)
  if (album.mb_album_id) return queueMbAlbum(album.mb_album_id, 'ui', options)
  throw new Error('Match this album to the catalog first, so Seeker knows what to look for')
}
