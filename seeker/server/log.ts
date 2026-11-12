type Level = 'debug' | 'info' | 'warn' | 'error'

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = order[(process.env.SEEKER_LOG_LEVEL as Level) || 'info'] ?? order.info

export interface Problem {
  at: number
  level: 'warn' | 'error'
  scope: string
  message: string
}

// The last warnings and errors, so MCP clients (who can't read container logs) can see what went wrong.
const problems: Problem[] = []
const KEEP = 50

export function recentProblems(limit = 10): Problem[] {
  return problems.slice(-limit).reverse()
}

function write(level: Level, scope: string, message: string, extra?: unknown) {
  if (level === 'warn' || level === 'error') {
    const detail = extra === undefined ? '' : `: ${extra instanceof Error ? extra.message : String(extra)}`
    problems.push({ at: Date.now(), level, scope, message: `${message}${detail}` })
    if (problems.length > KEEP) problems.shift()
  }
  if (order[level] < threshold) return
  const time = new Date().toISOString().slice(11, 19)
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  const stream = level === 'error' || level === 'warn' ? console.error : console.log
  if (extra === undefined) stream(line)
  else stream(line, extra instanceof Error ? extra.message : extra)
}

export function logger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => write('debug', scope, message, extra),
    info: (message: string, extra?: unknown) => write('info', scope, message, extra),
    warn: (message: string, extra?: unknown) => write('warn', scope, message, extra),
    error: (message: string, extra?: unknown) => write('error', scope, message, extra),
  }
}
