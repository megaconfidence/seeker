// Folder access: user ids as the host sees them (rootless Docker), clear problems instead of raw
// errors, and a startup that stops with the fix when the data folder isn't writable.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fsSync, { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seeker-folders-')))
process.on('exit', () => {
  // Folders made read-only by the tests can't be emptied until they're writable again.
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best effort
  }
})
const dirs = {
  data: path.join(root, 'data'),
  downloads: path.join(root, 'downloads'),
  music: path.join(root, 'music'),
  import: path.join(root, 'import'),
}
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))

Object.assign(process.env, {
  SEEKER_DATA_DIR: dirs.data,
  SEEKER_DOWNLOADS_DIR: dirs.downloads,
  SEEKER_MUSIC_DIR: dirs.music,
  SEEKER_IMPORT_DIR: dirs.import,
  SEEKER_LOG_LEVEL: process.env.SEEKER_LOG_LEVEL || 'error',
})

const folders = await import('../server/folders.ts')
// Root can write to read-only folders, so those checks only mean something for other users.
const asRoot = process.getuid?.() === 0 && 'root can write anywhere'
const uid = process.getuid?.() ?? -1
const gid = process.getgid?.() ?? -1

async function readOnlyFolder(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir)
  await fs.chmod(dir, 0o555)
  return dir
}

// Starts the real server and waits for it to exit.
function runSeeker(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.ts'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        SEEKER_PORT: String(40_000 + Math.floor(Math.random() * 20_000)),
        SLSKD_URL: 'http://127.0.0.1:9',
        SLSKD_API_KEY: 'unused-test-key',
        ...env,
      },
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Seeker didn't exit within 15 s:\n${output}`))
    }, 15_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

test('host ids: rootless Docker maps container users to subordinate ids', () => {
  const rootless = '         0       1000          1\n         1     100000      65536\n'
  assert.equal(folders.hostId(1000, rootless), 100_999)
  assert.equal(folders.hostId(0, rootless), 1000)
  assert.equal(folders.hostId(70_000, rootless), null)
  assert.equal(folders.hostId(1000, '         0          0 4294967295\n'), 1000)
  assert.equal(folders.hostId(1000, null), null)
})

test('the data folder message names the folder, the ids on both sides and the fix', () => {
  const rootless = folders.dataFolderMessage('/data', 'permission denied', { uid: 1000, gid: 1000, hostUid: 100_999, hostGid: 100_999 })
  assert.match(rootless, /^Seeker can’t use its data folder, \/data: permission denied\./)
  assert.match(rootless, /user 1000 and group 1000, which are user 100999 and group 100999 on the host/)
  assert.match(rootless, /PUID and PGID/)
  assert.match(rootless, /PUID=0 and PGID=0/)
  assert.match(rootless, /sudo chown -R 100999:100999 <folder>/)

  const plain = folders.dataFolderMessage('/data', 'permission denied', { uid: 1000, gid: 1000, hostUid: null, hostGid: null })
  assert.doesNotMatch(plain, /rootless/)
  assert.match(plain, /sudo chown -R 1000:1000 <folder>/)

  // Root that still can't write: the folder itself is read-only.
  const asRootMessage = folders.dataFolderMessage('/data', 'it’s read-only', { uid: 0, gid: 0, hostUid: null, hostGid: null })
  assert.match(asRootMessage, /read-only or a network share/)
  assert.doesNotMatch(asRootMessage, /chown/)
})

test('folder problems: missing, not a folder, not writable', { skip: asRoot }, async () => {
  assert.equal(await folders.folderProblem(dirs.music), null)
  assert.equal(await folders.folderProblem(path.join(root, 'nowhere')), 'it doesn’t exist')
  const file = path.join(root, 'a-file')
  await fs.writeFile(file, '')
  assert.equal(await folders.folderProblem(file), 'it isn’t a folder')
  assert.equal(await folders.folderProblem(await readOnlyFolder('locked')), 'permission denied')
})

test('folder checks never use synchronous calls: a slow network share would stall the server', async (t) => {
  const statSync = t.mock.method(fsSync, 'statSync')
  const accessSync = t.mock.method(fsSync, 'accessSync')
  await folders.folderProblems()
  await folders.folderProblem(dirs.music)
  assert.equal(statSync.mock.callCount() + accessSync.mock.callCount(), 0)
})

test('a folder Seeker can’t write to is reported with its path, what breaks and who Seeker runs as', async () => {
  const message = folders.folderMessage('music', 'permission denied')
  assert.match(message, new RegExp(`music folder, ${dirs.music}: permission denied`))
  assert.match(message, /can’t be filed into your library/)
  assert.match(message, new RegExp(`user ${uid} and group ${gid}`))
  // A missing import folder is fine: importing is optional.
  assert.deepEqual(await folders.folderProblems(), { downloads: null, music: null, import: null })
})

test('startup: a data folder Seeker can’t write to stops it with the fix, not an SQLite error', { skip: asRoot, timeout: 30_000 }, async () => {
  const { code, output } = await runSeeker({ SEEKER_DATA_DIR: await readOnlyFolder('read-only-data') })
  assert.equal(code, 1, output)
  assert.match(output, /Seeker can’t use its data folder, .*read-only-data: permission denied/)
  assert.match(output, new RegExp(`It runs as user ${uid} and group ${gid}`))
  assert.match(output, /To fix it:/)
  assert.doesNotMatch(output, /SQLITE_CANTOPEN|unable to open database/i)
})

test('startup: a database file Seeker can’t write to stops it the same way', { skip: asRoot, timeout: 30_000 }, async () => {
  const data = path.join(root, 'locked-db')
  await fs.mkdir(data)
  await fs.writeFile(path.join(data, 'seeker.db'), '')
  await fs.chmod(path.join(data, 'seeker.db'), 0o444)
  const { code, output } = await runSeeker({ SEEKER_DATA_DIR: data })
  assert.equal(code, 1, output)
  assert.match(output, /Seeker can’t use its data folder, .*locked-db: permission denied for seeker\.db/)
  assert.doesNotMatch(output, /SQLITE_|unable to open database|readonly database/i)
})
