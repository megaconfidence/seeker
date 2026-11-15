// Files without tags get their artist, album, title, track and year from where they sit in the music
// folder; tags always win where they exist.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { metadataFromPath, type PathMetadata } from '../server/library/pathmeta.ts'

const music = '/music'
const from = (relative: string) => metadataFromPath(path.join(music, relative), music)
const none: PathMetadata = { albumArtist: null, artist: null, album: null, title: '', track: null, disc: null, year: null }

test('artist and album folders, years and release details in folder names, track numbers', () => {
  assert.deepEqual(from('Nine Inch Nails/The Slip (2008)/01 - 999,999.flac'), {
    ...none, albumArtist: 'Nine Inch Nails', artist: 'Nine Inch Nails', album: 'The Slip', title: '999,999', track: 1, year: 2008,
  })
  assert.deepEqual(from('Nine Inch Nails/2008 - Ghosts I-IV [FLAC 24bit]/CD 2/05. 14 Ghosts II.flac'), {
    ...none, albumArtist: 'Nine Inch Nails', artist: 'Nine Inch Nails', album: 'Ghosts I-IV', title: '14 Ghosts II', track: 5, disc: 2, year: 2008,
  })
  assert.deepEqual(from('Jonathan Coulton/Jonathan Coulton - Thing a Week Two/1-03 Jonathan Coulton - Bacteria.mp3'), {
    ...none, albumArtist: 'Jonathan Coulton', artist: 'Jonathan Coulton', album: 'Thing a Week Two', title: 'Bacteria', track: 3, disc: 1,
  })
  assert.deepEqual(from('Nine Inch Nails/Nine Inch Nails - 2008 - The Slip/02_Letting_You.mp3'), {
    ...none, albumArtist: 'Nine Inch Nails', artist: 'Nine Inch Nails', album: 'The Slip', title: 'Letting You', track: 2, year: 2008,
  })
})

test('"Artist - Album" folders, also under _Unsorted, and compilations whose file names carry the artist', () => {
  assert.deepEqual(from('Jonathan Coulton - Thing a Week One (2006) [320]/03 - Flickr.mp3'), {
    ...none, albumArtist: 'Jonathan Coulton', artist: 'Jonathan Coulton', album: 'Thing a Week One', title: 'Flickr', track: 3, year: 2006,
  })
  assert.deepEqual(from('_Unsorted/Nine Inch Nails - The Slip/04 - Discipline.mp3'), {
    ...none, albumArtist: 'Nine Inch Nails', artist: 'Nine Inch Nails', album: 'The Slip', title: 'Discipline', track: 4,
  })
  assert.deepEqual(from('Various Artists/Free Sampler/07 - Some Band - Some Song.mp3'), {
    ...none, albumArtist: 'Various Artists', artist: 'Some Band', album: 'Free Sampler', title: 'Some Song', track: 7,
  })
})

test('names that only look numbered stay titles, and loose files keep just a title', () => {
  assert.deepEqual(from('Spice Girls/Spice/2 Become 1.mp3'), { ...none, albumArtist: 'Spice Girls', artist: 'Spice Girls', album: 'Spice', title: '2 Become 1' })
  assert.deepEqual(from('Prince/1999/1999.mp3'), { ...none, albumArtist: 'Prince', artist: 'Prince', album: '1999', title: '1999' })
  assert.deepEqual(from('loose_track_name.mp3'), { ...none, title: 'loose track name' })
  // A disc folder with nothing above it is the album.
  assert.deepEqual(from('CD1/01 - Song.mp3'), { ...none, album: 'CD1', title: 'Song', track: 1 })
  assert.deepEqual(metadataFromPath('/elsewhere/Artist/Album/01 - Song.mp3', music), { ...none, title: 'Song', track: 1 })
})

test('a scan names untagged files after their folders, and leaves tagged ones as they are', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-pathmeta-')))
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
  const dirs = { data: path.join(root, 'data'), music: path.join(root, 'music'), downloads: path.join(root, 'downloads'), import: path.join(root, 'import') }
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))
  Object.assign(process.env, {
    SEEKER_DATA_DIR: dirs.data, SEEKER_MUSIC_DIR: dirs.music, SEEKER_DOWNLOADS_DIR: dirs.downloads, SEEKER_IMPORT_DIR: dirs.import,
    SLSKD_URL: 'http://127.0.0.1:9', SLSKD_API_KEY: 'seeker-test-key', SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
  })
  const { updateSettings } = await import('../server/settings.ts')
  updateSettings({ shares: { autoRescan: false } })
  const { scanLibrary } = await import('../server/library/scan.ts')
  const { all } = await import('../server/db.ts')

  const album = path.join(dirs.music, 'Nine Inch Nails', 'The Slip (2008)')
  await fs.mkdir(album, { recursive: true })
  const ffmpeg = (...args: string[]) => promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=1', '-c:a', 'libmp3lame', '-b:a', '64k', ...args])
  // No tags at all, and one with its own tags, which win.
  await ffmpeg('-id3v2_version', '0', path.join(album, '03 - Head Down.mp3'))
  await ffmpeg('-metadata', 'title=Tagged Title', '-metadata', 'artist=Tagged Artist', '-metadata', 'album=Tagged Album', '-metadata', 'track=9', path.join(album, '04 - Discipline.mp3'))

  assert.equal((await scanLibrary()).outcome, 'done')
  const rows = all<{ title: string; artist: string; album: string; album_artist: string; track_no: number | null; year: number | null }>(
    'SELECT title, artist, album, album_artist, track_no, year FROM lib_tracks ORDER BY path',
  )
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { title: 'Head Down', artist: 'Nine Inch Nails', album: 'The Slip', album_artist: 'Nine Inch Nails', track_no: 3, year: 2008 },
    { title: 'Tagged Title', artist: 'Tagged Artist', album: 'Tagged Album', album_artist: 'Tagged Artist', track_no: 9, year: null },
  ])
})
