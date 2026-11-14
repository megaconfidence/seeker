import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import type { JobTarget, Settings, TargetTrack } from '../../shared/types.ts'
import { config } from '../config.ts'
import { all, exec } from '../db.ts'
import { describeIdentity, fileErrorMessage, folderProblem, isPermissionError } from '../folders.ts'
import { scheduleJellyfinRefresh } from '../jellyfin.ts'
import { AUDIO_EXTENSIONS, musicFolderProblem, scanFiles, scanLibrary } from '../library/scan.ts'
import { logger } from '../log.ts'
import { normalize, stripExtras } from '../match/normalize.ts'
import { findRelease } from '../metadata/musicbrainz.ts'
import { exists, locateDownload, moveFile, removeEmptyDirs, renderPath, sanitizeSegment } from '../post/fsops.ts'
import { writeTags, type TagData } from '../post/tag.ts'
import {
  acoustidCheck,
  decodeProblem,
  durationProblem,
  fakeLosslessProblem,
  probe,
  sizeProblem,
  type AudioInfo,
} from '../post/verify.ts'
import { getSettings } from '../settings.ts'
import { slskd } from '../soulseek/slskd.ts'
import { errorMessage, yearOf } from '../util.ts'
import * as store from './store.ts'
import type { FileRow, JobRow } from './store.ts'

const log = logger('process')

async function enrichWithMusicBrainz(jobId: string, target: JobTarget): Promise<JobTarget> {
  if (target.album.mbChecked) return target
  store.setPhase(jobId, 'Looking up MusicBrainz')
  const release = await findRelease({
    upc: target.album.upc,
    title: target.album.title,
    artist: target.album.artist,
    trackCount: target.album.trackCount,
  })
  const next: JobTarget = structuredClone(target)
  next.album.mbChecked = true
  if (release) {
    next.album.mbReleaseId = release.id
    next.album.mbReleaseGroupId = release.releaseGroupId ?? undefined
    next.album.mbArtistId = release.artistId ?? undefined
    const original = yearOf(release.originalDate)
    if (original) next.album.originalYear = original
    for (const track of next.tracks) {
      const match =
        (track.isrc && release.tracks.find((item) => item.isrcs.includes(track.isrc!))) ||
        release.tracks.find((item) => item.disc === track.disc && item.position === track.track)
      if (match) {
        track.mbRecordingId = match.recordingId
        track.mbTrackId = match.id
        track.mbArtistId = match.artistId ?? undefined
      }
    }
    store.logJob(jobId, 'info', `Matched MusicBrainz release “${release.title}”`)
  }
  store.patchJob(jobId, { target: next })
  return next
}

async function fetchCover(target: JobTarget): Promise<Buffer | null> {
  const urls: string[] = []
  if (target.album.coverUrl) urls.push(target.album.coverUrl.replace(/\/\d+x\d+-/, '/1200x1200-'), target.album.coverUrl)
  if (target.album.mbReleaseId) urls.push(`${config.coverArtUrl}/release/${target.album.mbReleaseId}/front-1200`)
  for (const url of [...new Set(urls)]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
      if (!response.ok) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > 2048) return buffer
    } catch {
      // try the next source
    }
  }
  return null
}

function tagsFor(target: JobTarget, track: TargetTrack): TagData {
  const album = target.album
  return {
    title: track.title,
    artists: [track.artist || album.artist],
    albumArtist: album.artist,
    album: album.title,
    year: album.originalYear ?? album.year ?? null,
    track: track.track,
    trackCount: target.tracks.filter((item) => item.disc === track.disc).length || album.trackCount,
    disc: track.disc,
    discCount: album.discCount,
    genres: album.genres ?? [],
    isrc: track.isrc,
    label: album.label,
    compilation: album.compilation,
    mbRecordingId: track.mbRecordingId,
    mbReleaseId: album.mbReleaseId,
    mbReleaseGroupId: album.mbReleaseGroupId,
    mbArtistId: track.mbArtistId,
    mbAlbumArtistId: album.mbArtistId,
  }
}

interface Verdict {
  problem: string | null
  note: string | null
}

async function verify(
  file: string,
  info: AudioInfo,
  track: TargetTrack | null,
  checks: Settings['checks'],
  isImport: boolean,
): Promise<Verdict> {
  const tooSmall = await sizeProblem(file)
  if (tooSmall) return { problem: tooSmall, note: null }
  // Your own files are trusted beyond being readable.
  if (isImport) return { problem: null, note: null }
  if (checks.duration && track) {
    const problem = durationProblem(info.duration, track.duration)
    if (problem) return { problem, note: null }
  }
  if (checks.integrity) {
    const problem = await decodeProblem(file)
    if (problem) return { problem, note: null }
  }
  if (checks.fakeLossless && info.lossless) {
    const problem = await fakeLosslessProblem(file, info.sampleRate)
    if (problem) return { problem, note: null }
  }
  const acoustidKey = checks.acoustidKey || config.acoustidKey
  if (acoustidKey && track) {
    const verdict = await acoustidCheck(file, acoustidKey, {
      title: track.title,
      artist: track.artist,
      mbRecordingId: track.mbRecordingId,
    })
    if (verdict && !verdict.ok) return { problem: verdict.detail, note: null }
    if (verdict?.ok) return { problem: null, note: 'fingerprint matches' }
  }
  return { problem: null, note: null }
}

function qualityRank(info: AudioInfo): number {
  return info.lossless ? 10_000 + (info.bitDepth ?? 16) * 100 + (info.sampleRate ?? 44_100) / 1000 : (info.bitrate ?? 0)
}

// The same track already in the library, possibly with another extension.
async function existingVariant(destination: string): Promise<string | null> {
  if (await exists(destination)) return destination
  const dir = path.dirname(destination)
  const stem = path.basename(destination, path.extname(destination))
  try {
    for (const name of await fs.readdir(dir)) {
      const ext = path.extname(name).toLowerCase()
      if (AUDIO_EXTENSIONS.has(ext) && path.basename(name, path.extname(name)) === stem) return path.join(dir, name)
    }
  } catch {
    // directory doesn't exist yet
  }
  return null
}

function extensionFor(file: string, info: AudioInfo): string {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (ext === 'mp4' || ext === 'alac') return 'm4a'
  if (ext === 'wave') return 'wav'
  if (ext === 'aif') return 'aiff'
  return ext || (info.lossless ? 'flac' : 'mp3')
}

async function destinationFromTags(file: string, row: FileRow, template: string, ext: string): Promise<string> {
  try {
    const meta = await parseFile(file, { skipCovers: true })
    const common = meta.common
    if (common.title && (common.albumartist || common.artist) && common.album) {
      return path.join(
        config.musicDir,
        renderPath(
          template,
          {
            albumartist: common.albumartist || common.artist || '',
            artist: common.artist || common.albumartist || '',
            album: common.album,
            year: common.year ?? null,
            title: common.title,
            track: common.track?.no ?? 0,
            disc: common.disk?.no ?? 1,
            discCount: common.disk?.of ?? 1,
          },
          ext,
        ),
      )
    }
  } catch {
    // fall through to the folder name
  }
  const parts = row.filename.split(/[\\/]+/).filter(Boolean)
  const folder = parts[parts.length - 2] ?? row.username
  return path.join(config.musicDir, '_Unsorted', sanitizeSegment(folder), sanitizeSegment(path.basename(file)))
}

const insideLibrary = (file: string) => path.resolve(file).startsWith(config.musicDir + path.sep)

interface Tagged {
  // The file to move into the library: the original, or a tagged copy of it.
  file: string
  info: string | null
  // Shown with the filed track when it kept its old tags.
  note: string | null
}

// When Seeker isn't allowed to change a file (another user's download, a read-only file), it tags a
// copy instead, provided it can remove the original afterwards. If it can't do either, nothing is
// filed: a track with the uploader's tags in the library is worse than a clear error.
async function tagForLibrary(file: string, data: TagData, cover: Buffer | null, copy: string, isImport: boolean): Promise<Tagged> {
  try {
    writeTags(file, data, cover)
    return { file, info: null, note: null }
  } catch (error) {
    if (!isPermissionError(error)) return { file, info: null, note: `filed without new tags (${errorMessage(error)})` }
    const dir = path.dirname(file)
    if (folderProblem(dir)) {
      throw new Error(
        isImport
          ? `Seeker isn’t allowed to change ${file} or move it out of ${dir}. Let ${describeIdentity()} write there, or import with Copy.`
          : `Seeker isn’t allowed to change the downloaded file or move it out of ${dir}. Run Seeker as the same user as slskd, or let ${describeIdentity()} write there.`,
      )
    }
    await fs.mkdir(path.dirname(copy), { recursive: true })
    await fs.copyFile(file, copy)
    await fs.chmod(copy, 0o644)
    writeTags(copy, data, cover)
    return { file: copy, info: 'Seeker isn’t allowed to change the original, so it tagged a copy', note: null }
  }
}

// When upgrading, remove the old copy of a track if it lives somewhere else in the library.
async function replaceOldTrack(albumId: string, track: TargetTrack, destination: string, info: AudioInfo): Promise<boolean> {
  const rows = all<{ path: string; disc_no: number | null; track_no: number | null; norm_title: string }>(
    'SELECT path, disc_no, track_no, norm_title FROM lib_tracks WHERE album_id = ?',
    [albumId],
  )
  const title = normalize(stripExtras(track.title))
  const old =
    rows.find((row) => row.track_no === track.track && (row.disc_no ?? 1) === track.disc) ??
    rows.find((row) => row.norm_title === title)
  if (!old || path.resolve(old.path) === path.resolve(destination) || !insideLibrary(old.path)) return false
  const current = await probe(old.path).catch(() => null)
  if (current && qualityRank(info) <= qualityRank(current)) return false
  await fs.rm(old.path, { force: true })
  await removeEmptyDirs(path.dirname(old.path), config.musicDir)
  return true
}

export async function processJob(jobId: string): Promise<{ failedTracks: number[] }> {
  const job = store.getJob(jobId)
  if (!job) return { failedTracks: [] }
  const settings = getSettings()
  const isImport = job.kind === 'import'
  let target = store.jobTarget(job)
  const rows = store.jobFiles(jobId).filter((row) => row.state === 'downloaded')
  const dir = path.join(config.downloadsDir, 'seeker', jobId)
  const failedTracks: number[] = []
  const imported: string[] = []
  let touchedLibrary = false

  // Filing into a share that isn't mounted would put music where nobody looks for it (or inside
  // the container), so nothing moves until the folder is back.
  const musicProblem = rows.length ? await musicFolderProblem() : null
  if (musicProblem) {
    for (const row of rows) store.patchFile(row.id, { state: 'failed', error: musicProblem })
    store.logJob(jobId, 'error', `${musicProblem} Nothing was moved; retry once the folder is back.`)
    return { failedTracks }
  }

  if (target && rows.some((row) => row.track_index !== null)) {
    try {
      target = await enrichWithMusicBrainz(jobId, target)
    } catch (error) {
      log.warn('MusicBrainz lookup failed', error)
    }
  }
  const cover = target ? await fetchCover(target) : null
  const copyMode = isImport && target?.importMode === 'copy'

  for (const [position, row] of rows.entries()) {
    const track = target && row.track_index !== null ? (target.tracks[row.track_index] ?? null) : null
    const name = track ? `“${track.title}”` : path.basename(row.filename.replace(/\\/g, '/'))
    store.setPhase(jobId, `${isImport ? 'Importing' : 'Checking'} files (${position + 1} of ${rows.length})`)

    let local: string | null
    if (row.local_path && isImport) {
      local = (await exists(row.local_path)) ? row.local_path : null
    } else {
      const basename = row.filename.split(/[\\/]/).pop() ?? row.filename
      local = await locateDownload(dir, basename, row.size, config.timing.locateMs)
    }
    if (!local) {
      store.patchFile(row.id, {
        state: 'failed',
        error: isImport ? 'file not found' : 'downloaded file not found; check that Seeker and slskd share the same downloads folder',
      })
      store.logJob(jobId, 'error', isImport ? `${name}: file not found` : `${name}: downloaded, but the file isn't in ${dir}`)
      continue
    }

    let working = local
    try {
      if (copyMode) {
        const tempDir = path.join(config.dataDir, 'tmp', jobId)
        await fs.mkdir(tempDir, { recursive: true })
        working = path.join(tempDir, `${row.id}${path.extname(local)}`)
        await fs.copyFile(local, working)
      }
      const info = await probe(working)
      const verdict = await verify(working, info, track, settings.checks, isImport)
      if (verdict.problem) {
        if (!isImport || copyMode) await fs.rm(working, { force: true })
        store.patchFile(row.id, { state: 'failed', error: verdict.problem })
        store.logJob(jobId, 'warn', `${name}${row.username !== 'local' ? ` from ${row.username}` : ''} rejected: ${verdict.problem}`)
        if (track && !isImport) failedTracks.push(track.index)
        continue
      }
      if (verdict.note) store.logJob(jobId, 'info', `${name}: ${verdict.note}`)

      const ext = extensionFor(working, info)
      const destination =
        target && track
          ? path.join(
              config.musicDir,
              renderPath(
                settings.naming.template,
                {
                  albumartist: target.album.artist,
                  artist: track.artist,
                  album: target.album.title,
                  year: target.album.originalYear ?? target.album.year ?? null,
                  title: track.title,
                  track: track.track,
                  disc: track.disc,
                  discCount: target.album.discCount,
                },
                ext,
              ),
            )
          : await destinationFromTags(working, row, settings.naming.template, ext)

      const existing = await existingVariant(destination)
      const sameFile = existing && path.resolve(existing) === path.resolve(local)
      if (existing && !sameFile) {
        const current = await probe(existing).catch(() => null)
        if (current && qualityRank(info) <= qualityRank(current) + 10) {
          if (!isImport || copyMode) await fs.rm(working, { force: true })
          store.patchFile(row.id, { state: 'skipped', local_path: existing, error: 'already in your library' })
          store.logJob(jobId, 'info', `${name} is already in your library in the same or better quality`)
          continue
        }
      }

      let filed = working
      let note: string | null = null
      if (target && track) {
        const copy = path.join(config.dataDir, 'tmp', jobId, `${row.id}-tagged${path.extname(working)}`)
        const tagged = await tagForLibrary(working, tagsFor(target, track), cover, copy, isImport)
        filed = tagged.file
        note = tagged.note
        if (tagged.info) store.logJob(jobId, 'info', `${name}: ${tagged.info}`)
        if (note) store.logJob(jobId, 'warn', `${name}: ${note}`)
      }
      if (path.resolve(filed) !== path.resolve(destination)) {
        const leftover = await moveFile(filed, destination)
        if (leftover) store.logJob(jobId, 'warn', `${name}: filed, but ${filed} couldn’t be removed (${fileErrorMessage(leftover)})`)
      }
      // A tagged copy went in because the original couldn't be changed; remove the original, as a move would.
      if (filed !== working && !copyMode && path.resolve(working) !== path.resolve(destination)) {
        await fs.rm(working, { force: true }).catch((error) => {
          store.logJob(jobId, 'warn', `${name}: filed a tagged copy, but couldn’t remove ${working} (${fileErrorMessage(error)})`)
        })
      }
      if (existing && !sameFile && path.resolve(existing) !== path.resolve(destination)) await fs.rm(existing, { force: true })
      if (target?.replaceLibraryAlbumId && track && (await replaceOldTrack(target.replaceLibraryAlbumId, track, destination, info))) {
        touchedLibrary = true
      }
      if (insideLibrary(local) && path.resolve(local) !== path.resolve(destination)) {
        touchedLibrary = true
        await removeEmptyDirs(path.dirname(local), config.musicDir)
      }
      if (isImport && !copyMode && path.resolve(local).startsWith(config.importDir + path.sep)) {
        await removeEmptyDirs(path.dirname(local), config.importDir)
      }
      store.patchFile(row.id, { state: 'imported', local_path: destination, error: note })
      exec(
        `INSERT OR REPLACE INTO imports (path, deezer_album_id, deezer_track_id, mb_release_id, job_id, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [destination, target?.album.deezerId ?? null, track?.deezerId ?? null, target?.album.mbReleaseId ?? null, jobId, Date.now()],
      )
      imported.push(destination)
      if (row.transfer_id) void slskd.cancel(row.username, row.transfer_id, true)
    } catch (error) {
      if (copyMode) await fs.rm(working, { force: true }).catch(() => {})
      store.patchFile(row.id, { state: 'failed', error: fileErrorMessage(error) })
      store.logJob(jobId, 'error', `${name}: ${fileErrorMessage(error)}`)
    }
  }
  // Copies made for copy-mode imports, and tagged copies of files Seeker couldn't change.
  await fs.rm(path.join(config.dataDir, 'tmp', jobId), { recursive: true, force: true }).catch(() => {})

  if (imported.length) {
    if (cover) {
      const coverPath = path.join(path.dirname(imported[0]!), 'cover.jpg')
      if (!(await exists(coverPath))) await fs.writeFile(coverPath, cover).catch(() => {})
    }
    store.setPhase(jobId, 'Adding to library')
    if (touchedLibrary) await scanLibrary()
    else await scanFiles(imported)
    scheduleJellyfinRefresh()
    store.logJob(jobId, 'info', `Added ${imported.length} ${imported.length === 1 ? 'track' : 'tracks'} to your library`)
  }
  return { failedTracks }
}

export type { JobRow }
