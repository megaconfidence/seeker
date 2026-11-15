import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { FakeSlskd } from './fakes/slskd.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-share-startup-'))
const music = path.join(root, 'music')
await fs.mkdir(music)
const fake = await new FakeSlskd({ apiKey: 'seeker-test-key', downloadsDir: path.join(root, 'downloads') }).start()
Object.assign(process.env, { SEEKER_DATA_DIR: path.join(root, 'data'), SEEKER_MUSIC_DIR: music, SLSKD_URL: fake.url, SLSKD_API_KEY: 'seeker-test-key', SEEKER_LOG_LEVEL: 'error' })
const { exec } = await import('../server/db.ts')
// Existing settings need no migration: the new field falls back to false and zero becomes safe.
exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['shares', JSON.stringify({ autoRescan: true, quietMinutes: 0 })])
const { getSettings, updateSettings } = await import('../server/settings.ts')
const { scanLibrary } = await import('../server/library/scan.ts')
const shares = await import('../server/shares.ts')
after(async () => {
  updateSettings({ shares: { autoRescan: false } })
  await fake.close()
  await fs.rm(root, { recursive: true, force: true })
})

async function reset() {
  updateSettings({ shares: { autoRescan: false } })
  if (shares.shareRescanStatus().pending) await shares.rescanSharesNow()
  // Ends any scan an earlier test left running.
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now() + 1 })
  exec('DELETE FROM lib_tracks')
  exec('DELETE FROM lib_albums')
  exec("DELETE FROM meta WHERE key = 'library_indexed'")
  await fs.rm(music, { recursive: true })
  await fs.mkdir(music)
  updateSettings({ shares: { autoRescan: true, rescanOnFirstScan: false } })
}

// What a freshly started Seeker would do about share rescans, against the same database.
async function afterRestart(): Promise<{ pending: boolean; scheduledAt: number | null }> {
  const module = pathToFileURL(path.join(import.meta.dirname, '../server/shares.ts')).href
  const script = `const shares = await import(${JSON.stringify(module)}); shares.startShares(); console.log(JSON.stringify(shares.shareRescanStatus())); process.exit(0)`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: process.env })
  return JSON.parse(stdout.trim().split('\n').at(-1)!)
}

test('old share settings load with safe defaults and no database migration', () => {
  assert.deepEqual(getSettings().shares, { autoRescan: true, quietMinutes: 1, rescanOnFirstScan: false })
})

test('initial indexing does not rescan already-shared music, but later new files do', async () => {
  await reset()
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 42 })
  await fs.writeFile(path.join(music, 'existing.mp3'), '')
  assert.equal((await scanLibrary()).updated, 1)
  assert.equal(shares.shareRescanStatus().pending, false)
  assert.equal(shares.shareRescanStatus().scheduledAt, null)
  await fs.writeFile(path.join(music, 'new.mp3'), '')
  assert.equal((await scanLibrary()).updated, 1)
  assert.equal(shares.shareRescanStatus().pending, true)
})

test('initial indexing still plans a rescan when slskd shares zero files', async () => {
  await reset()
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 0 })
  await fs.writeFile(path.join(music, 'existing.mp3'), '')
  await scanLibrary()
  assert.ok(shares.shareRescanStatus().scheduledAt)
})

test('initial indexing waits for status instead of guessing that shares are empty', async () => {
  await reset()
  shares.noteSlskdShares({ reachable: false, scanning: false, at: Date.now() })
  await fs.writeFile(path.join(music, 'existing.mp3'), '')
  await scanLibrary()
  assert.equal(shares.shareRescanStatus().scheduledAt, null)
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 0 })
  assert.ok(shares.shareRescanStatus().scheduledAt)
})

test('the first-index decision waits for a recent share count, not an old one', async () => {
  await reset()
  // Status polls come every 10 s, so a count from a minute ago may no longer be true.
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now() - 60_000, sharedFiles: 0 })
  await fs.writeFile(path.join(music, 'existing.mp3'), '')
  await scanLibrary()
  assert.equal(shares.shareRescanStatus().scheduledAt, null)
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 0 })
  assert.ok(shares.shareRescanStatus().scheduledAt)
})

test('the first-index decision ignores what slskd shares while it scans', async () => {
  await reset()
  shares.noteSlskdShares({ reachable: true, scanning: true, at: Date.now(), sharedFiles: 0 })
  await fs.writeFile(path.join(music, 'existing.mp3'), '')
  await scanLibrary()
  assert.equal(shares.shareRescanStatus().scheduledAt, null)
  // slskd's scan ends with the music shared, so there's nothing to ask for.
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now() + 1, sharedFiles: 42 })
  assert.equal(shares.shareRescanStatus().pending, false)
  assert.equal(shares.shareRescanStatus().scheduledAt, null)
})

test('rescanOnFirstScan explicitly opts into the first rescan', async () => {
  await reset()
  updateSettings({ shares: { rescanOnFirstScan: true } })
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 42 })
  await fs.writeFile(path.join(music, 'existing.mp3'), '')
  await scanLibrary()
  assert.ok(shares.shareRescanStatus().scheduledAt)
})

test('new files after a genuinely empty first scan still schedule a rescan', async () => {
  await reset()
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now(), sharedFiles: 42 })
  await scanLibrary()
  await fs.writeFile(path.join(music, 'new.mp3'), '')
  await scanLibrary()
  assert.ok(shares.shareRescanStatus().scheduledAt)
})

test('a share rescan that was still to come survives a restart; one that happened doesn’t come back', async () => {
  await reset()
  shares.noteLibraryChange()
  const pending = await afterRestart()
  assert.equal(pending.pending, true)
  assert.ok(pending.scheduledAt, 'the restarted Seeker plans the rescan again')
  await shares.rescanSharesNow()
  shares.noteSlskdShares({ reachable: true, scanning: false, at: Date.now() + 1 })
  const done = await afterRestart()
  assert.deepEqual([done.pending, done.scheduledAt], [false, null])
})
