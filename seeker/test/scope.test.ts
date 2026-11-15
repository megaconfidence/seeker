import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const app = path.join(import.meta.dirname, '..')
const root = path.join(app, '..')

test('MIT terms are identical in the repository and the Docker build context', async () => {
  const licence = await fs.readFile(path.join(root, 'LICENSE'), 'utf8')
  assert.equal(await fs.readFile(path.join(app, 'LICENSE'), 'utf8'), licence)
  assert.match(licence, /^MIT License/)
  assert.match(licence, /Copyright \(c\) 2026 megaconfidence/)
  assert.equal(JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8')).license, 'MIT')
  assert.equal(JSON.parse(await fs.readFile(path.join(app, 'package-lock.json'), 'utf8')).packages[''].license, 'MIT')
})

test('scope and permanent deletion limitations are documented', async () => {
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8')
  assert.match(readme, /## What Seeker is not/)
  assert.match(readme, /no recycle bin or undo/)
  assert.match(readme, /database backup does not contain audio/)
  for (const feature of ['playlists', 'multi-user', 'podcasts', 'Spotify', 'Tidal', 'Lidarr']) assert.ok(readme.includes(feature))
})
