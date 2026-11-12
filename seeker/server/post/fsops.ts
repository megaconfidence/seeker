import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sleep } from '../util.ts'

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let out = ''
  for (const char of value) {
    if (Buffer.byteLength(out + char) > maxBytes) break
    out += char
  }
  return out
}

export function sanitizeSegment(value: string, fallback = 'Unknown'): string {
  let out = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (RESERVED.test(out)) out = `_${out}`
  out = truncateBytes(out, 200).replace(/[.\s]+$/g, '')
  return out || fallback
}

export interface TemplateVars {
  albumartist: string
  artist: string
  album: string
  year: number | null
  title: string
  track: number
  disc: number
  discCount: number
}

export function renderPath(template: string, vars: TemplateVars, ext: string): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const values: Record<string, string> = {
    albumartist: vars.albumartist || vars.artist || 'Unknown Artist',
    artist: vars.artist || vars.albumartist || 'Unknown Artist',
    album: vars.album || 'Unknown Album',
    year: vars.year ? String(vars.year) : '',
    title: vars.title || 'Untitled',
    track: pad(vars.track || 0),
    disc: vars.discCount > 1 ? String(vars.disc || 1) : '',
    disctrack: vars.discCount > 1 ? `${vars.disc || 1}-${pad(vars.track || 0)}` : pad(vars.track || 0),
  }
  const segments = template
    .split('/')
    .map((segment) =>
      segment
        .replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key]! : match))
        .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
        .replace(/\s+-\s*$|^\s*-\s+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment))
  const file = segments.pop() ?? 'Untitled'
  return path.join(...segments, `${file}.${ext}`)
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

// Atomic move: rename when possible, otherwise copy to a hidden temp file in the destination and rename.
export async function moveFile(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    const temp = path.join(path.dirname(destination), `.seeker-${randomBytes(6).toString('hex')}.tmp`)
    try {
      await fs.copyFile(source, temp)
      const handle = await fs.open(temp, 'r+')
      await handle.sync()
      await handle.close()
      await fs.rename(temp, destination)
    } catch (copyError) {
      await fs.rm(temp, { force: true })
      throw copyError
    }
    await fs.rm(source, { force: true })
  }
  await fs.chmod(destination, 0o644).catch(() => {})
}

async function listFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

// slskd marks a transfer complete just before moving it out of its incomplete folder, and renames
// clashes to "<stem>_<ticks><ext>", so look for the file by name and size for a little while.
export async function locateDownload(dir: string, basename: string, size: number, waitMs = 30_000): Promise<string | null> {
  const ext = path.extname(basename)
  const stem = basename.slice(0, basename.length - ext.length)
  const clash = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d{15,}${ext.replace('.', '\\.')}$`)
  const deadline = Date.now() + waitMs
  for (;;) {
    const files = await listFiles(dir)
    const named = files.filter((file) => {
      const name = path.basename(file)
      return name === basename || clash.test(name)
    })
    for (const file of named) {
      try {
        const stat = await fs.stat(file)
        if (!size || stat.size === size) return file
      } catch {
        // gone
      }
    }
    if (named.length === 1 && !size) return named[0]!
    if (Date.now() > deadline) return named[0] ?? null
    await sleep(1000)
  }
}

export async function removeEmptyDirs(start: string, stopAt: string): Promise<void> {
  let current = path.resolve(start)
  const root = path.resolve(stopAt)
  while (current.startsWith(root + path.sep) && current !== root) {
    let entries: string[]
    try {
      entries = await fs.readdir(current)
    } catch {
      return
    }
    if (entries.some((entry) => !entry.startsWith('.'))) return
    await fs.rm(current, { recursive: true, force: true })
    current = path.dirname(current)
  }
}
