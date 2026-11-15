// Saved share settings outside today's limits load within them, so no timer can fire at once.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-settings-'))
Object.assign(process.env, { SEEKER_DATA_DIR: path.join(root, 'data'), SEEKER_MUSIC_DIR: path.join(root, 'music'), SEEKER_LOG_LEVEL: 'error' })
const { exec } = await import('../server/db.ts')
// As saved by hand: setTimeout can't wait this long (the most is about 24.8 days) and fires at once.
exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['shares', JSON.stringify({ autoRescan: true, quietMinutes: 99_999 })])
const { getSettings, updateSettings } = await import('../server/settings.ts')
after(() => fs.rm(root, { recursive: true, force: true }))

test('a saved quiet period above the maximum loads as 1440 minutes', () => {
  assert.equal(getSettings().shares.quietMinutes, 1440)
})

test('quiet periods are kept within 1–1440 minutes, and anything that isn’t a number falls back to 30', () => {
  assert.equal(updateSettings({ shares: { quietMinutes: 0 } }).shares.quietMinutes, 1)
  assert.equal(updateSettings({ shares: { quietMinutes: 99_999 } }).shares.quietMinutes, 1440)
  assert.equal(updateSettings({ shares: { quietMinutes: 45 } }).shares.quietMinutes, 45)
  assert.equal(updateSettings({ shares: { quietMinutes: Number.NaN } }).shares.quietMinutes, 30)
})
