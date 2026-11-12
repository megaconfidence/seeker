import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { ApiToken } from '../shared/types.ts'
import { config } from './config.ts'
import { all, exec, get, getMeta, setMeta } from './db.ts'
import { logger } from './log.ts'

const log = logger('auth')
const COOKIE = 'seeker_session'
const SESSION_DAYS = 365

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function loginPassword(): string {
  if (config.password) return config.password
  let generated = getMeta('generated_password')
  if (!generated) {
    generated = randomBytes(12).toString('base64url')
    setMeta('generated_password', generated)
  }
  return generated
}

export function announcePassword() {
  if (config.password) return
  log.warn(`SEEKER_PASSWORD is not set. Log in with this generated password: ${loginPassword()}`)
}

export function checkPassword(input: string): boolean {
  return timingSafeEqual(sha256(input), sha256(loginPassword()))
}

const failures = new Map<string, { count: number; until: number }>()

export function loginBlockedFor(ip: string): number {
  const entry = failures.get(ip)
  if (!entry || entry.until < Date.now()) return 0
  return Math.ceil((entry.until - Date.now()) / 1000)
}

export function recordLoginFailure(ip: string) {
  const entry = failures.get(ip) ?? { count: 0, until: 0 }
  entry.count += 1
  if (entry.count >= 5) entry.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (entry.count - 5))
  failures.set(ip, entry)
}

export function clearLoginFailures(ip: string) {
  failures.delete(ip)
}

export function createSession(c: Context) {
  const id = randomBytes(32).toString('base64url')
  const now = Date.now()
  exec('INSERT INTO sessions (id, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?)', [
    id,
    now,
    now,
    c.req.header('user-agent')?.slice(0, 200),
  ])
  const secure = c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:'
  setCookie(c, COOKIE, id, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  })
}

export function destroySession(c: Context) {
  const id = getCookie(c, COOKIE)
  if (id) exec('DELETE FROM sessions WHERE id = ?', [id])
  deleteCookie(c, COOKIE, { path: '/' })
}

const touched = new Map<string, number>()

export function hasSession(c: Context): boolean {
  const id = getCookie(c, COOKIE)
  if (!id) return false
  const session = get<{ last_seen_at: number }>('SELECT last_seen_at FROM sessions WHERE id = ?', [id])
  if (!session) return false
  const now = Date.now()
  if (now - session.last_seen_at > SESSION_DAYS * 24 * 3600 * 1000) {
    exec('DELETE FROM sessions WHERE id = ?', [id])
    return false
  }
  if (now - (touched.get(id) ?? 0) > 60_000) {
    touched.set(id, now)
    exec('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now, id])
  }
  return true
}

export const requireSession: MiddlewareHandler = async (c, next) => {
  if (!hasSession(c)) return c.json({ error: 'Not logged in' }, 401)
  await next()
}

export function createToken(name: string): { token: string; info: ApiToken } {
  const token = `seeker_${randomBytes(24).toString('base64url')}`
  const info: ApiToken = {
    id: randomBytes(8).toString('hex'),
    name: name.trim().slice(0, 60) || 'Token',
    prefix: token.slice(0, 10),
    createdAt: Date.now(),
    lastUsedAt: null,
  }
  exec('INSERT INTO tokens (id, name, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)', [
    info.id,
    info.name,
    sha256(token).toString('hex'),
    info.prefix,
    info.createdAt,
  ])
  return { token, info }
}

export function listTokens(): ApiToken[] {
  return all<{ id: string; name: string; prefix: string; created_at: number; last_used_at: number | null }>(
    'SELECT id, name, prefix, created_at, last_used_at FROM tokens ORDER BY created_at DESC',
  ).map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }))
}

export function revokeToken(id: string) {
  exec('DELETE FROM tokens WHERE id = ?', [id])
}

// Older versions kept an always-valid token for a command-line tool next to the database. The tool
// is gone, so revoke that token and delete the file.
export function removeCliToken() {
  exec("DELETE FROM tokens WHERE name = 'Built-in command line'")
  fs.rmSync(path.join(config.dataDir, 'cli-token'), { force: true })
}

export function verifyToken(header: string | undefined): boolean {
  const match = header?.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const hash = sha256(match[1]!.trim()).toString('hex')
  const row = get<{ id: string }>('SELECT id FROM tokens WHERE hash = ?', [hash])
  if (!row) return false
  exec('UPDATE tokens SET last_used_at = ? WHERE id = ?', [Date.now(), row.id])
  return true
}
