export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>()
  private readonly max: number

  constructor(max = 500) {
    this.max = max
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires < Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: V, ttlMs: number) {
    this.entries.delete(key)
    this.entries.set(key, { value, expires: Date.now() + ttlMs })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

// Allows at most `limit` calls per `windowMs`, queueing the rest in order.
export class RateLimiter {
  private stamps: number[] = []
  private chain: Promise<void> = Promise.resolve()
  private readonly limit: number
  private readonly windowMs: number

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  wait(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now()
        this.stamps = this.stamps.filter((stamp) => now - stamp < this.windowMs)
        if (this.stamps.length < this.limit) {
          this.stamps.push(now)
          return
        }
        await sleep(this.windowMs - (now - this.stamps[0]!) + 5)
      }
    })
    this.chain = next.catch(() => {})
    return next
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function yearOf(date: string | null | undefined): number | null {
  const year = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN
  return Number.isFinite(year) && year > 0 ? year : null
}
