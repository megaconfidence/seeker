import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { logger } from './log.ts'
import { errorMessage } from './util.ts'

const log = logger('folders')

// Users in a container can be other users on the host: rootless Docker maps container user 1000 to
// a subordinate id such as 100999. Each line of /proc/self/uid_map reads "<inside> <outside> <count>".
export function hostId(id: number, map: string | null): number | null {
  for (const line of map?.trim().split('\n') ?? []) {
    const [inside, outside, count] = line.trim().split(/\s+/).map(Number)
    if (inside === undefined || outside === undefined || count === undefined) continue
    if (![inside, outside, count].every(Number.isFinite)) continue
    if (id >= inside && id < inside + count) return outside + (id - inside)
  }
  return null
}

export interface Identity {
  uid: number
  gid: number
  // Only set when the host knows these ids by other numbers.
  hostUid: number | null
  hostGid: number | null
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

let current: Identity | null = null

export function identity(): Identity {
  if (current) return current
  const uid = process.getuid?.() ?? -1
  const gid = process.getgid?.() ?? -1
  const hostUid = hostId(uid, readText('/proc/self/uid_map'))
  const hostGid = hostId(gid, readText('/proc/self/gid_map'))
  current = {
    uid,
    gid,
    hostUid: hostUid !== null && hostUid !== uid ? hostUid : null,
    hostGid: hostGid !== null && hostGid !== gid ? hostGid : null,
  }
  return current
}

export function describeIdentity(who: Identity = identity()): string {
  const ids = `user ${who.uid} and group ${who.gid}`
  if (who.hostUid === null && who.hostGid === null) return ids
  return `${ids}, which are user ${who.hostUid ?? who.uid} and group ${who.hostGid ?? who.gid} on the host`
}

const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code

// A file system error in a few words, for messages like "Seeker can't read /music (permission denied)".
export function fsReason(error: unknown): string {
  switch (code(error)) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied'
    case 'EROFS':
      return 'it’s read-only'
    case 'ENOENT':
      return 'it doesn’t exist'
    case 'ENOTDIR':
      return 'it isn’t a folder'
    default:
      return errorMessage(error)
  }
}

// Why Seeker can't read and write a folder, or null when it can. Never synchronous: a network share
// that's slow to answer would stall the whole server, health check included.
export async function folderProblem(dir: string): Promise<string | null> {
  try {
    if (!(await fs.promises.stat(dir)).isDirectory()) return 'it isn’t a folder'
    await fs.promises.access(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)
    return null
  } catch (error) {
    return fsReason(error)
  }
}

// Only for the data folder at startup: the database opens there synchronously right after.
function folderProblemSync(dir: string): string | null {
  try {
    if (!fs.statSync(dir).isDirectory()) return 'it isn’t a folder'
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)
    return null
  } catch (error) {
    return fsReason(error)
  }
}

function databaseProblem(dir: string): string | null {
  for (const name of ['seeker.db', 'seeker.db-wal', 'seeker.db-shm']) {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.R_OK | fs.constants.W_OK)
    } catch (error) {
      if (code(error) !== 'ENOENT') return `${fsReason(error)} for ${name}`
    }
  }
  return null
}

export function dataFolderMessage(dir: string, problem: string, who: Identity = identity()): string {
  const mapped = who.hostUid !== null || who.hostGid !== null
  const owner = `${who.hostUid ?? who.uid}:${who.hostGid ?? who.gid}`
  const chown = `On the host, give the folder you mount at ${dir} to that user: sudo chown -R ${owner} <folder>`
  const fixes =
    who.uid !== 0
      ? [
          'Start the container as root (without --user or "user:") and set PUID and PGID instead. Seeker then gives the folder to that user itself.' +
            (mapped ? ' With rootless Docker, PUID=0 and PGID=0 make Seeker’s files yours on the host.' : ''),
          chown,
        ]
      : mapped
        ? [chown]
        : [`Root can’t write there either, so the folder is read-only or a network share that doesn’t let root write. Mount a folder Seeker can write to at ${dir}.`]
  return [
    `Seeker can’t use its data folder, ${dir}: ${problem}.`,
    `It runs as ${describeIdentity(who)}${mapped ? ' (rootless Docker gives container users other ids on the host)' : ''}.`,
    'To fix it:',
    ...fixes.map((fix) => `- ${fix}`),
  ].join('\n')
}

function stop(message: string): never {
  log.error(message)
  process.exit(1)
}

// Seeker can't run without its data folder, so it stops with what to do instead of an SQLite error.
export function ensureDataDir(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
  } catch {
    // folderProblem says why
  }
  const problem = folderProblemSync(config.dataDir) ?? databaseProblem(config.dataDir)
  if (problem) stop(dataFolderMessage(config.dataDir, problem))
}

export function databaseOpenFailed(error: unknown): never {
  stop(dataFolderMessage(config.dataDir, `the database couldn’t be opened (${errorMessage(error)})`))
}

type Folder = 'downloads' | 'music' | 'import'

const FOLDERS: Record<Folder, { dir: () => string; name: string; effect: string }> = {
  downloads: {
    dir: () => config.downloadsDir,
    name: 'downloads folder',
    effect: 'Seeker can’t pick up finished downloads. It must be the folder slskd downloads to.',
  },
  music: { dir: () => config.musicDir, name: 'music folder', effect: 'New music can’t be filed into your library.' },
  import: { dir: () => config.importDir, name: 'import folder', effect: 'Importing music you already have won’t work.' },
}

export function folderMessage(folder: Folder, problem: string): string {
  const { dir, name, effect } = FOLDERS[folder]
  return `Seeker can’t use the ${name}, ${dir()}: ${problem}. ${effect} Seeker runs as ${describeIdentity()}.`
}

// The import folder is optional, so a missing one isn't a problem.
export async function folderProblems(): Promise<Record<Folder, string | null>> {
  const folders = Object.keys(FOLDERS) as Folder[]
  const found = await Promise.all(folders.map((folder) => folderProblem(FOLDERS[folder].dir())))
  const problems = {} as Record<Folder, string | null>
  folders.forEach((folder, index) => {
    const problem = found[index] ?? null
    problems[folder] = problem && !(folder === 'import' && problem === fsReason({ code: 'ENOENT' })) ? folderMessage(folder, problem) : null
  })
  return problems
}

export async function checkFolders(): Promise<void> {
  for (const message of Object.values(await folderProblems())) if (message) log.warn(message)
}

// For job logs: a failed file operation, with who Seeker runs as when permissions are the cause.
export function fileErrorMessage(error: unknown): string {
  const message = errorMessage(error)
  if (code(error) === 'EACCES' || code(error) === 'EPERM') return `${message}. Seeker runs as ${describeIdentity()}; let that user write there.`
  return message
}

export const isPermissionError = (error: unknown) => ['EACCES', 'EPERM', 'EROFS'].includes(code(error) ?? '')
