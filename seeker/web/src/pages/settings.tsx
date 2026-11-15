import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Copy, ExternalLink, KeyRound, LogOut, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { ApiToken, AppStatus, QualityFormat, RecordType, Settings } from '../../../shared/types.ts'
import { Skeleton } from '../components/skeleton.tsx'
import { Badge, Button, Field, IconButton, Input, PageHeader, Select, Toggle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useConfirm } from '../lib/confirm.tsx'
import { clockTime, minutesLabel, relativeTime } from '../lib/format.ts'
import { useStatus } from '../lib/live.ts'
import { useToast } from '../lib/toast.tsx'

const FORMAT_LABELS: Record<QualityFormat, string> = {
  flac: 'FLAC',
  alac: 'ALAC',
  wav: 'WAV / AIFF',
  mp3: 'MP3',
  aac: 'AAC / M4A',
  ogg: 'Ogg Vorbis',
  opus: 'Opus',
}
const ALL_FORMATS = Object.keys(FORMAT_LABELS) as QualityFormat[]

const SECTIONS = [
  { id: 'soulseek', label: 'Soulseek' },
  { id: 'quality', label: 'Quality' },
  { id: 'library', label: 'Library' },
  { id: 'checks', label: 'Download checks' },
  { id: 'jellyfin', label: 'Jellyfin' },
  { id: 'wishlist', label: 'Wishlist & watchlist' },
  { id: 'mcp', label: 'MCP' },
  { id: 'account', label: 'Account' },
]

function Card({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mb-6 scroll-mt-6 rounded-lg border border-line">
      <div className="border-b border-line px-5 py-3.5">
        <h2 className="text-14 font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-12.5 text-muted">{description}</p>}
      </div>
      <div className="divide-y divide-line px-5">{children}</div>
    </section>
  )
}

// Highlights the section currently in view.
function SectionNav() {
  const [active, setActive] = useState(SECTIONS[0]!.id)
  useEffect(() => {
    const root = document.querySelector('main')
    if (!root) return
    let frame = 0
    // The active section is the last one whose top has scrolled past the upper part of the page.
    const update = () => {
      frame = 0
      const top = root.getBoundingClientRect().top + 120
      let current = SECTIONS[0]!.id
      for (const section of SECTIONS) {
        const element = document.getElementById(section.id)
        if (element && element.getBoundingClientRect().top <= top) current = section.id
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1]!.id
      setActive(current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [])
  return (
    <nav className="sticky top-0 hidden flex-col gap-0.5 self-start lg:flex" aria-label="Settings sections">
      {SECTIONS.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          onClick={(event) => {
            event.preventDefault()
            document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
          className={clsx(
            'rounded-md px-2.5 py-1.5 text-12.5 transition-colors',
            active === section.id ? 'bg-hover font-medium text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {section.label}
        </a>
      ))}
    </nav>
  )
}

interface Info {
  commit: string | null
  musicDir: string
  downloadsDir: string
  importDir: string
  folderProblems: Record<'downloads' | 'music' | 'import', string | null>
  slskdUrl: string
  version: string
  acoustidFromEnv: boolean
  searchBudget: { used: number; limit: number; waiting: number }
}

function sharingHint(status: AppStatus | undefined, settings: Settings): string {
  const rescan = status?.shareRescan
  if (status?.slskd.sharedFiles === 0) {
    return 'You aren’t sharing anything. Many Soulseek users won’t send files to people who don’t share. Check that slskd shares your music folder.'
  }
  if (rescan?.running || status?.slskd.scanningShares) {
    return 'slskd is rescanning its shares. On a big library this takes minutes, and slskd may not respond meanwhile.'
  }
  if (rescan?.scheduledAt) return `New music will be shared after slskd rescans, at about ${clockTime(rescan.scheduledAt)}.`
  if (rescan?.waitingForDownloads) return 'New music will be shared after slskd rescans, once the downloads in progress finish.'
  if (rescan?.pending && !settings.shares.autoRescan) return 'New music isn’t shared yet. Press Rescan, or let slskd’s own rescans pick it up.'
  return settings.shares.autoRescan
    ? 'Seeker asks slskd to rescan once new music has stopped arriving, so what you download gets shared back.'
    : 'Seeker doesn’t ask slskd to rescan by itself. Press Rescan to share new music.'
}

const QUIET_MINUTES = [5, 15, 30, 60, 180, 360, 1440]

function quietOptions(current: number) {
  const minutes = QUIET_MINUTES.includes(current) ? QUIET_MINUTES : [...QUIET_MINUTES, current].sort((a, b) => a - b)
  return minutes.map((value) => ({ value: String(value), label: `After ${minutesLabel(value)}` }))
}

function useSettings() {
  const client = useQueryClient()
  const toast = useToast()
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') })
  const save = useMutation({
    mutationFn: (patch: Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>) => api.put<Settings>('/settings', patch),
    onSuccess: (settings) => client.setQueryData(['settings'], settings),
    onError: (error) => toast(error.message, 'error'),
  })
  return { settings: query.data, save }
}

function previewTemplate(template: string): string {
  const values: Record<string, string> = {
    albumartist: 'Radiohead',
    artist: 'Radiohead',
    album: 'In Rainbows',
    year: '2007',
    title: 'Reckoner',
    track: '07',
    disc: '',
    disctrack: '07',
  }
  return `${template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)}.flac`
}

function QualityCard({ settings, save }: ReturnType<typeof useSettings> & { settings: Settings }) {
  const formats = settings.quality.formats
  const set = (next: QualityFormat[]) => next.length && save.mutate({ quality: { formats: next } })
  const move = (index: number, delta: number) => {
    const next = [...formats]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item!)
    set(next)
  }
  return (
    <Card id="quality" title="Quality" description="Seeker takes the best format on this list that someone is sharing, in this order.">
      <div className="py-4">
        <div className="flex flex-col gap-1.5">
          {formats.map((format, index) => (
            <div key={format} className="flex h-9 items-center gap-3 rounded-md border border-line bg-raised pr-1 pl-3">
              <span className="w-5 text-12 text-subtle tabular">{index + 1}</span>
              <span className="flex-1 text-13 font-medium">{FORMAT_LABELS[format]}</span>
              <IconButton label="Move up" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUp className="size-3.5" />
              </IconButton>
              <IconButton label="Move down" size="sm" disabled={index === formats.length - 1} onClick={() => move(index, 1)}>
                <ArrowDown className="size-3.5" />
              </IconButton>
              <IconButton label="Remove" size="sm" disabled={formats.length === 1} onClick={() => set(formats.filter((item) => item !== format))}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {ALL_FORMATS.filter((format) => !formats.includes(format)).map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => set([...formats, format])}
              className="h-7 rounded-full border border-dashed border-line-strong px-2.5 text-12 text-muted hover:border-solid hover:text-fg"
            >
              + {FORMAT_LABELS[format]}
            </button>
          ))}
        </div>
      </div>
      <Field label="Minimum bitrate for MP3" hint="Lossy files below this are skipped.">
        <Select
          value={String(settings.quality.minBitrate)}
          onChange={(value) => save.mutate({ quality: { minBitrate: Number(value) } })}
          options={['192', '256', '320'].map((value) => ({ value, label: `${value} kbps` }))}
        />
      </Field>
      <Field label="Accept VBR MP3 (V0)" hint="Variable-bitrate MP3s average around 245 kbps and sound the same as 320.">
        <Toggle checked={settings.quality.acceptVbr} onChange={(value) => save.mutate({ quality: { acceptVbr: value } })} label="Accept VBR" />
      </Field>
      <Field label="Hi-res FLAC (24-bit)" hint="Hi-res files are much larger and rarely sound different.">
        <Select
          value={settings.quality.hiRes}
          onChange={(value) => save.mutate({ quality: { hiRes: value } })}
          options={[
            { value: 'accept', label: 'Accept' },
            { value: 'prefer', label: 'Prefer' },
            { value: 'avoid', label: 'Avoid' },
          ]}
        />
      </Field>
    </Card>
  )
}

function TextSetting({ value, onSave, placeholder, type = 'text', mono }: { value: string; onSave: (value: string) => void; placeholder?: string; type?: string; mono?: boolean }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Input
      value={draft}
      type={type}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
      className={clsx('w-full sm:w-80', mono && 'font-mono text-12')}
    />
  )
}

function TokensCard() {
  const client = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<ApiToken[]>('/tokens') })
  const create = useMutation({
    mutationFn: () => api.post<{ token: string; info: ApiToken }>('/tokens', { name: name || 'Token' }),
    onSuccess: ({ token }) => {
      setCreated(token)
      setName('')
      void client.invalidateQueries({ queryKey: ['tokens'] })
    },
  })
  const confirm = useConfirm()
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/tokens/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['tokens'] }),
  })
  const askRevoke = async (token: ApiToken) => {
    const yes = await confirm({
      title: `Revoke ${token.name}?`,
      description: 'Apps using this token will stop working until you give them a new one.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (yes) revoke.mutate(token.id)
  }
  const origin = window.location.origin
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
    toast('Copied')
  }
  const shownToken = created ?? '<token>'
  const snippet = `claude mcp add --transport http seeker ${origin}/mcp --header "Authorization: Bearer ${shownToken}"`
  const config = JSON.stringify(
    { mcpServers: { seeker: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${shownToken}` } } } },
    null,
    2,
  )

  return (
    <Card
      id="mcp"
      title="MCP"
      description="Let AI assistants control Seeker: find and download music, manage downloads, your library, imports, the watchlist and these settings. Each app gets its own token."
    >
      <div className="py-4">
        <div className="flex gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Token name, e.g. Claude or laptop" className="max-w-xs" />
          <Button variant="secondary" icon={<KeyRound className="size-3.5" />} loading={create.isPending} onClick={() => create.mutate()}>
            Create token
          </Button>
        </div>
        {created && (
          <div className="mt-3 rounded-md border border-warn/40 bg-warn/8 p-3">
            <p className="text-12.5">Copy this token now. It won’t be shown again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-raised px-2 py-1.5 font-mono text-12">{created}</code>
              <IconButton label="Copy token" onClick={() => copy(created)}>
                <Copy className="size-4" />
              </IconButton>
            </div>
          </div>
        )}
        {tokens.data && tokens.data.length > 0 && (
          <div className="mt-4 flex flex-col divide-y divide-line rounded-md border border-line">
            {tokens.data.map((token) => (
              <div key={token.id} className="flex items-center gap-3 px-3 py-2 text-13">
                <span className="font-medium">{token.name}</span>
                <code className="font-mono text-11.5 text-subtle">{token.prefix}…</code>
                <span className="ml-auto text-12 text-muted">
                  {token.lastUsedAt ? `Used ${relativeTime(token.lastUsedAt)}` : `Created ${relativeTime(token.createdAt)}`}
                </span>
                <IconButton label="Revoke" size="sm" onClick={() => void askRevoke(token)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="py-4 text-12.5 text-muted">
        <p className="mb-2 font-medium text-fg">Connect an MCP client</p>
        <p>
          MCP endpoint: <code className="font-mono text-fg">{origin}/mcp</code> (streamable HTTP) with the token as a Bearer header. For Claude
          Code:
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded bg-raised px-2 py-1.5 font-mono text-11.5 whitespace-nowrap">{snippet}</code>
          <IconButton label="Copy command" onClick={() => copy(snippet)}>
            <Copy className="size-4" />
          </IconButton>
        </div>
        <p className="mt-4 mb-2">For clients configured with JSON:</p>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded bg-raised px-2 py-1.5 font-mono text-11.5 whitespace-pre">{config}</code>
          <IconButton label="Copy configuration" onClick={() => copy(config)}>
            <Copy className="size-4" />
          </IconButton>
        </div>
      </div>
    </Card>
  )
}

export function SettingsPage() {
  const { settings, save } = useSettings()
  const { data: status } = useStatus()
  const info = useQuery({ queryKey: ['info'], queryFn: () => api.get<Info>('/info'), refetchInterval: 15_000 })
  const client = useQueryClient()
  const toast = useToast()
  const [jellyfinResult, setJellyfinResult] = useState<{ ok: boolean; message: string } | null>(null)
  const testJellyfin = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/settings/jellyfin/test', settings!.jellyfin),
    onSuccess: setJellyfinResult,
  })
  const [acoustidResult, setAcoustidResult] = useState<{ ok: boolean; message: string } | null>(null)
  const testAcoustid = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/settings/acoustid/test'),
    onSuccess: setAcoustidResult,
    onError: (error) => setAcoustidResult({ ok: false, message: error.message }),
  })
  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => client.setQueryData(['me'], { loggedIn: false }),
  })
  const reconnect = useMutation({
    mutationFn: () => api.post('/slskd/connect'),
    onSuccess: () => toast('Reconnecting to Soulseek'),
    onError: (error) => toast(error.message, 'error'),
  })
  const rescanShares = useMutation({
    mutationFn: () => api.post<{ started: boolean }>('/slskd/rescan'),
    onSuccess: (result) => toast(result.started ? 'slskd is rescanning your shared folders' : 'slskd is already rescanning your shared folders'),
    onError: (error) => toast(error.message, 'error'),
  })

  if (!settings) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Settings" />
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="mb-6 rounded-lg border border-line p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-5 h-3.5 w-2/3" />
            <Skeleton className="mt-3 h-3.5 w-1/2" />
          </div>
        ))}
      </div>
    )
  }

  const slskd = status?.slskd
  const slskdWeb = info.data?.slskdUrl.replace('://slskd:', `://${window.location.hostname}:`)
  const budget = info.data?.searchBudget
  const sharing = slskd?.sharedFiles

  return (
    <div className="grid max-w-250 animate-content-in gap-10 lg:grid-cols-[minmax(0,1fr)_10.5rem]">
      <div className="min-w-0">
        <PageHeader title="Settings" />

        <Card id="soulseek" title="Soulseek">
          <Field
            label="Connection"
            hint={
              slskd?.error ??
              (slskd?.reachable && !slskd.loggedIn
                ? 'If Soulseek keeps disconnecting, your account is probably signed in on another app. Soulseek allows one session per account.'
                : undefined)
            }
          >
            {slskd?.loggedIn ? (
              <Badge tone="ok">Logged in as {slskd.username}</Badge>
            ) : slskd?.reachable ? (
              <>
                <Badge tone="warn">Not logged in ({slskd.state ?? 'disconnected'})</Badge>
                <Button size="sm" variant="secondary" loading={reconnect.isPending} onClick={() => reconnect.mutate()}>
                  Reconnect
                </Button>
              </>
            ) : (
              <Badge tone="bad">Can’t reach slskd</Badge>
            )}
          </Field>
          <Field label="Sharing" hint={sharingHint(status, settings)}>
            {sharing === null || sharing === undefined ? (
              <Badge>Unknown</Badge>
            ) : slskd?.scanningShares ? (
              <Badge tone="accent">Scanning…</Badge>
            ) : (
              <Badge tone={sharing === 0 ? 'warn' : 'ok'}>
                {sharing.toLocaleString()} {sharing === 1 ? 'file' : 'files'}
                {slskd?.sharedFolders ? ` in ${slskd.sharedFolders.toLocaleString()} folders` : ''}
              </Badge>
            )}
            <Button size="sm" variant="ghost" loading={rescanShares.isPending} disabled={!slskd?.reachable || slskd.scanningShares} onClick={() => rescanShares.mutate()}>
              Rescan
            </Button>
          </Field>
          <Field
            label="Rescan shares automatically"
            hint="Seeker asks slskd to rescan once new music has stopped arriving for this long and nothing is downloading. On a big library a rescan can take minutes, and slskd may not respond meanwhile."
          >
            {settings.shares.autoRescan && (
              <Select
                value={String(settings.shares.quietMinutes)}
                onChange={(value) => save.mutate({ shares: { quietMinutes: Number(value) } })}
                options={quietOptions(settings.shares.quietMinutes)}
              />
            )}
            <Toggle checked={settings.shares.autoRescan} onChange={(value) => save.mutate({ shares: { autoRescan: value } })} label="Rescan shares automatically" />
          </Field>
          <Field label="Rescan after first library scan" hint="Usually slskd already shares your existing music. Leave this off to avoid an unnecessary scan during initial indexing.">
            <Toggle checked={settings.shares.rescanOnFirstScan} onChange={(value) => save.mutate({ shares: { rescanOnFirstScan: value } })} label="Rescan after first library scan" />
          </Field>
          {budget && (
            <Field
              label="Search budget"
              hint="The Soulseek server bans clients that search too often, so Seeker paces its searches."
            >
              <span className="text-13 text-muted tabular">
                {budget.used} of {budget.limit} used in the last 4 minutes{budget.waiting ? ` · ${budget.waiting} waiting` : ''}
              </span>
            </Field>
          )}
          <Field label="slskd" hint="Raw transfers, share folders and the Soulseek login live in slskd’s own interface.">
            {slskdWeb && (
              <a href={slskdWeb} target="_blank" rel="noreferrer">
                <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />}>
                  Open slskd
                </Button>
              </a>
            )}
          </Field>
        </Card>

        <QualityCard settings={settings} save={save} />

        <Card id="library" title="Library" description={info.data ? <>Files are saved to <code className="font-mono">{info.data.musicDir}</code>.</> : undefined}>
          {info.data &&
            Object.values(info.data.folderProblems)
              .filter((problem): problem is string => !!problem)
              .map((problem) => (
                <p key={problem} className="pt-4 text-12.5 text-bad">
                  {problem}
                </p>
              ))}
          <div className="py-4">
            <div className="text-13 font-medium">File names</div>
            <div className="mt-0.5 mb-2 text-12.5 text-muted">
              Use <code className="font-mono">{'{albumartist} {artist} {album} {year} {track} {disctrack} {title}'}</code>. Folders are separated with /.
              Changing this only affects new downloads.
            </div>
            <TextSetting value={settings.naming.template} mono onSave={(template) => save.mutate({ naming: { template } })} />
            <p className="mt-2 font-mono text-11.5 text-subtle">{previewTemplate(settings.naming.template)}</p>
          </div>
          {info.data && (
            <Field label="Import folder" hint="Music you put here can be tagged and added to your library.">
              <code className="font-mono text-12 text-muted">{info.data.importDir}</code>
              <Link to="/import">
                <Button size="sm" variant="ghost">
                  Open
                </Button>
              </Link>
            </Field>
          )}
        </Card>

        <Card id="checks" title="Download checks" description="Files that fail a check are thrown away and Seeker tries another copy.">
          <Field label="Length matches the track" hint="Catches previews, cut-off files and different versions.">
            <Toggle checked={settings.checks.duration} onChange={(value) => save.mutate({ checks: { duration: value } })} label="Check length" />
          </Field>
          <Field label="File plays all the way through" hint="Decodes every file to find corruption.">
            <Toggle checked={settings.checks.integrity} onChange={(value) => save.mutate({ checks: { integrity: value } })} label="Check integrity" />
          </Field>
          <Field label="Catch fake lossless" hint="Rejects FLACs that were converted from low-bitrate MP3s.">
            <Toggle checked={settings.checks.fakeLossless} onChange={(value) => save.mutate({ checks: { fakeLossless: value } })} label="Fake lossless check" />
          </Field>
          <Field
            label="AcoustID key (optional)"
            hint={
              info.data?.acoustidFromEnv && !settings.checks.acoustidKey ? (
                'Fingerprints each song to make sure it’s the right one. Using the ACOUSTID_API_KEY environment variable; a key here overrides it.'
              ) : (
                <>
                  Fingerprints each song to make sure it’s the right one. Get a free key at{' '}
                  <a href="https://acoustid.org/new-application" target="_blank" rel="noreferrer" className="underline">
                    acoustid.org
                  </a>
                  .
                </>
              )
            }
          >
            <TextSetting
              value={settings.checks.acoustidKey}
              placeholder={info.data?.acoustidFromEnv ? 'Set by ACOUSTID_API_KEY' : 'Not set'}
              onSave={(acoustidKey) => save.mutate({ checks: { acoustidKey } })}
            />
          </Field>
          {(settings.checks.acoustidKey || info.data?.acoustidFromEnv) && (
            <Field
              label="Test AcoustID key"
              hint={acoustidResult ? <span className={acoustidResult.ok ? 'text-ok' : 'text-bad'}>{acoustidResult.message}</span> : undefined}
            >
              <Button size="sm" variant="secondary" loading={testAcoustid.isPending} onClick={() => testAcoustid.mutate()}>
                Test
              </Button>
            </Field>
          )}
        </Card>

        <Card id="jellyfin" title="Jellyfin" description="Tell Jellyfin to rescan after new music arrives.">
          <Field label="Server URL">
            <TextSetting value={settings.jellyfin.url} placeholder="http://jellyfin:8096" onSave={(url) => save.mutate({ jellyfin: { url } })} />
          </Field>
          <Field label="API key" hint="Jellyfin → Dashboard → API keys.">
            <TextSetting value={settings.jellyfin.apiKey} type="password" placeholder="Not set" onSave={(apiKey) => save.mutate({ jellyfin: { apiKey } })} />
          </Field>
          <Field label="Test connection" hint={jellyfinResult ? <span className={jellyfinResult.ok ? 'text-ok' : 'text-bad'}>{jellyfinResult.message}</span> : undefined}>
            <Button size="sm" variant="secondary" loading={testJellyfin.isPending} disabled={!settings.jellyfin.url || !settings.jellyfin.apiKey} onClick={() => testJellyfin.mutate()}>
              Test
            </Button>
          </Field>
        </Card>

        <Card id="wishlist" title="Wishlist & watchlist">
          <Field label="Keep retrying" hint="Downloads that can’t be found go to the wishlist and are retried automatically.">
            <Toggle checked={settings.wishlist.enabled} onChange={(value) => save.mutate({ wishlist: { enabled: value } })} label="Wishlist retries" />
          </Field>
          <Field label="Check followed artists every">
            <Select
              value={String(settings.watchlist.intervalHours)}
              onChange={(value) => save.mutate({ watchlist: { intervalHours: Number(value) } })}
              options={['6', '12', '24', '72'].map((value) => ({ value, label: `${value} hours` }))}
            />
          </Field>
          <Field label="Default release types" hint="Used when you follow a new artist.">
            <div className="flex flex-wrap gap-1.5">
              {(['album', 'ep', 'single', 'compile'] as RecordType[]).map((type) => {
                const on = settings.watchlist.types.includes(type)
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      const next = on ? settings.watchlist.types.filter((item) => item !== type) : [...settings.watchlist.types, type]
                      if (next.length) save.mutate({ watchlist: { types: next } })
                    }}
                    className={clsx('h-7 rounded-full border px-2.5 text-12', on ? 'border-fg/20 bg-hover text-fg' : 'border-line text-subtle')}
                  >
                    {{ album: 'Albums', ep: 'EPs', single: 'Singles', compile: 'Compilations' }[type]}
                  </button>
                )
              })}
            </div>
          </Field>
        </Card>

        <TokensCard />

        <Card id="account" title="Account">
          <Field label="Password" hint="Set with the SEEKER_PASSWORD environment variable. Restart Seeker after changing it.">
            <span />
          </Field>
          <Field
            label="Sign out"
            hint={info.data ? `Seeker ${info.data.version}${info.data.commit ? ` · build ${info.data.commit}` : ''}` : undefined}
          >
            <Button
              size="sm"
              variant="ghost"
              icon={<LogOut className="size-3.5" />}
              onClick={() => {
                logout.mutate()
                toast('Signed out')
              }}
            >
              Sign out
            </Button>
          </Field>
        </Card>
      </div>
      <SectionNav />
    </div>
  )
}
