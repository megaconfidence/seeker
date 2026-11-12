import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.ts'
import { db, getMeta, setMeta } from './db.ts'
import { logger } from './log.ts'
import { errorMessage } from './util.ts'

const log = logger('backup')
const DAY = 24 * 3600_000
const KEEP = 7

export const backupDir = path.join(config.dataDir, 'backups')

// A consistent copy of the database (settings, tokens, downloads, watchlist), one per day.
export async function backupDatabase(): Promise<string> {
  await fs.mkdir(backupDir, { recursive: true })
  const file = path.join(backupDir, `seeker-${new Date().toISOString().slice(0, 10)}.db`)
  await fs.rm(file, { force: true })
  db.prepare('VACUUM INTO ?').run(file)
  setMeta('last_backup_at', String(Date.now()))
  const old = (await fs.readdir(backupDir)).filter((name) => /^seeker-\d{4}-\d{2}-\d{2}\.db$/.test(name)).sort().reverse()
  for (const name of old.slice(KEEP)) await fs.rm(path.join(backupDir, name), { force: true })
  return file
}

export function startBackups() {
  const tick = async () => {
    const last = Number(getMeta('last_backup_at') ?? 0)
    if (Date.now() - last < DAY - 60_000) return
    try {
      const file = await backupDatabase()
      log.info(`Backed up the database to ${file}`)
    } catch (error) {
      log.warn(`Database backup failed: ${errorMessage(error)}`)
    }
  }
  setTimeout(() => void tick(), 60_000).unref()
  setInterval(() => void tick(), 3600_000).unref()
}
