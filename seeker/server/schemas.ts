import { z } from 'zod'

// Request shapes shared by the web API and the MCP tools.

export const recordTypes = z.array(z.enum(['album', 'ep', 'single', 'compile']))

export const settingsSchema = z
  .object({
    quality: z
      .object({
        formats: z.array(z.enum(['flac', 'alac', 'wav', 'mp3', 'aac', 'ogg', 'opus'])).min(1),
        minBitrate: z.number().int().min(64).max(1411),
        acceptVbr: z.boolean(),
        hiRes: z.enum(['prefer', 'accept', 'avoid']),
      })
      .partial(),
    naming: z.object({ template: z.string().min(3).max(300).refine((value) => value.includes('{title}'), 'The template needs {title}') }).partial(),
    checks: z.object({ duration: z.boolean(), integrity: z.boolean(), fakeLossless: z.boolean(), acoustidKey: z.string().max(100) }).partial(),
    jellyfin: z.object({ url: z.string().max(300), apiKey: z.string().max(200) }).partial(),
    watchlist: z.object({ intervalHours: z.number().min(1).max(168), types: recordTypes }).partial(),
    wishlist: z.object({ enabled: z.boolean() }).partial(),
    shares: z.object({ autoRescan: z.boolean(), quietMinutes: z.number().min(0).max(1440) }).partial(),
  })
  .partial()

export const choiceSchema = z.union([
  z.object({ albumId: z.number().int() }),
  z.object({ mbid: z.string().uuid() }),
  z.object({ asIs: z.literal(true) }),
])
