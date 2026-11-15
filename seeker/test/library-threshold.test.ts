import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-threshold-'))
const music = path.join(root, 'music')
await fs.mkdir(music)
Object.assign(process.env, { SEEKER_DATA_DIR: path.join(root, 'data'), SEEKER_MUSIC_DIR: music, SEEKER_LOG_LEVEL: 'error' })
const { exec, get } = await import('../server/db.ts')
const { updateSettings } = await import('../server/settings.ts')
const { scanLibrary, libraryStatus } = await import('../server/library/scan.ts')
updateSettings({ shares: { autoRescan: false } })
after(() => fs.rm(root, { recursive: true, force: true }))

for (const [known, gone, refused] of [[150, 100, true], [199, 100, true], [101, 100, true], [1000, 500, false], [1000, 501, true], [99, 99, false]] as const) {
  test(`${gone} of ${known} missing tracks: ${refused ? 'refused' : 'below the mass-removal threshold'}`, async () => {
    exec('DELETE FROM lib_tracks')
    exec('DELETE FROM lib_albums')
    await fs.rm(music, { recursive: true })
    await fs.mkdir(music)
    // For the 99/99 case a newly added file keeps the walk nonempty. An entirely empty walk
    // must still be refused by the independent empty-library guard.
    await fs.writeFile(path.join(music, 'new.mp3'), '')
    for (let i = 0; i < known; i++) {
      const file = path.join(music, `${i}.mp3`)
      let mtime = 0
      if (i >= gone) {
        await fs.writeFile(file, '')
        mtime = Math.floor((await fs.stat(file)).mtimeMs)
      }
      exec(`INSERT INTO lib_tracks (path, album_id, mtime, size, title, artist, album, album_artist, norm_artist, norm_title, has_cover, added_at)
        VALUES (?, 'album', ?, 0, 'Song', 'Artist', 'Album', 'Artist', 'artist', 'song', 0, 0)`, [file, mtime])
    }
    const scan = await scanLibrary()
    assert.equal(scan.outcome, refused ? 'refused' : 'done', scan.message)
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM lib_tracks WHERE path != ?', [path.join(music, 'new.mp3')])!.n, refused ? known : known - gone)
    assert.equal(libraryStatus().problem?.canForce ?? false, refused)
  })
}

test('the empty-walk guard still protects a library smaller than 100 tracks', async () => {
  exec('DELETE FROM lib_tracks')
  exec('DELETE FROM lib_albums')
  await fs.rm(music, { recursive: true })
  await fs.mkdir(music)
  exec(`INSERT INTO lib_tracks (path, album_id, mtime, size, title, artist, album, album_artist, norm_artist, norm_title, has_cover, added_at)
    VALUES (?, 'album', 0, 0, 'Song', 'Artist', 'Album', 'Artist', 'artist', 'song', 0, 0)`, [path.join(music, 'gone.mp3')])
  assert.equal((await scanLibrary()).outcome, 'refused')
})
