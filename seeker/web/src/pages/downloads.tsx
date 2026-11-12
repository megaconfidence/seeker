import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDownToLine, ChevronDown, RotateCw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import type { Job, JobDetail, JobFile } from '../../../shared/types.ts'
import { Cover } from '../components/cover.tsx'
import { progressLine, StatusIcon, statusLabel } from '../components/job.tsx'
import { Skeleton } from '../components/skeleton.tsx'
import { Badge, Button, Empty, IconButton, PageHeader, Progress, Section, Spinner } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { coverAt } from '../lib/covers.ts'
import { jobLink, jobPercent, useJobAction } from '../lib/downloads.ts'
import { bytes, relativeTime, speed } from '../lib/format.ts'
import { isActive, useJobs } from '../lib/live.ts'

export const KIND: Record<Job['kind'], string> = { album: 'Album', track: 'Song', files: 'Files', import: 'Import' }

function fileState(file: JobFile): { text: string; tone: string } {
  switch (file.state) {
    case 'queued':
      return { text: file.queuePosition ? `In queue · #${file.queuePosition}` : 'Queued', tone: 'text-muted' }
    case 'downloading': {
      const percent = file.size ? Math.round((file.bytes / file.size) * 100) : 0
      return { text: `${percent}%${speed(file.speed) ? ` · ${speed(file.speed)}` : ''}`, tone: 'text-accent' }
    }
    case 'downloaded':
      return { text: 'Downloaded', tone: 'text-muted' }
    case 'imported':
      return { text: 'In library', tone: 'text-ok' }
    case 'skipped':
      return { text: 'Already had it', tone: 'text-muted' }
    case 'failed':
      return { text: file.error ? `Failed · ${file.error}` : 'Failed', tone: 'text-bad' }
    case 'cancelled':
      return { text: file.error && file.error !== 'cancelled' ? `Dropped · ${file.error}` : 'Cancelled', tone: 'text-subtle' }
    default:
      return { text: file.state, tone: 'text-muted' }
  }
}

function FileRow({ file, title }: { file: JobFile; title: string }) {
  const state = fileState(file)
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-line py-1.5 text-[12.5px] last:border-0">
      <div className="min-w-0">
        <div className={clsx('truncate', (file.state === 'failed' || file.state === 'cancelled') && 'text-muted line-through decoration-subtle/60')}>
          {title}
        </div>
        <div className="truncate text-[11.5px] text-subtle" title={file.filename}>
          {file.username === 'local' ? 'Your file' : file.username} · {bytes(file.size)}
        </div>
      </div>
      <div className={clsx('max-w-72 truncate text-right', state.tone)} title={state.text}>
        {state.text}
      </div>
    </div>
  )
}

function JobDetailPanel({ job }: { job: Job }) {
  const [showDropped, setShowDropped] = useState(false)
  const detail = useQuery({
    queryKey: ['job', job.id],
    queryFn: () => api.get<JobDetail>(`/jobs/${job.id}`),
    refetchInterval: isActive(job) ? 3000 : false,
  })
  if (detail.isPending) {
    return (
      <div className="flex items-center gap-2 border-t border-line px-4 py-4 text-[12.5px] text-muted">
        <Spinner className="size-3.5" /> Loading…
      </div>
    )
  }
  if (!detail.data) return null
  const { files, log, target } = detail.data
  const title = (file: JobFile) => {
    const track = file.trackIndex !== null ? target?.tracks[file.trackIndex] : undefined
    return track ? `${track.track}. ${track.title}` : (file.filename.split(/[\\/]/).pop() ?? file.filename)
  }
  const order = (a: JobFile, b: JobFile) => (a.trackIndex ?? 999) - (b.trackIndex ?? 999) || a.id - b.id
  const current = files.filter((file) => file.state !== 'failed' && file.state !== 'cancelled').sort(order)
  const dropped = files.filter((file) => file.state === 'failed' || file.state === 'cancelled').sort(order)
  return (
    <div className="grid animate-content-in gap-6 border-t border-line bg-panel/40 px-4 py-4 lg:grid-cols-[3fr_2fr]">
      <div className="min-w-0">
        <div className="mb-2 text-[12px] font-medium text-muted">Files</div>
        {files.length === 0 ? (
          <p className="text-[12.5px] text-subtle">No files yet.</p>
        ) : (
          <div className="flex flex-col">
            {current.map((file) => (
              <FileRow key={file.id} file={file} title={title(file)} />
            ))}
            {dropped.length > 0 && (
              <button
                type="button"
                onClick={() => setShowDropped((value) => !value)}
                className="mt-2 self-start text-[12px] text-muted hover:text-fg"
              >
                {showDropped ? 'Hide' : 'Show'} {dropped.length} dropped {dropped.length === 1 ? 'source' : 'sources'}
              </button>
            )}
            {showDropped && (
              <div className="mt-1 flex flex-col">
                {dropped.map((file) => (
                  <FileRow key={file.id} file={file} title={title(file)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="mb-2 text-[12px] font-medium text-muted">Activity</div>
        <ol className="scrollbar-thin max-h-72 overflow-y-auto font-mono text-[11.5px] leading-relaxed">
          {[...log].reverse().map((entry, index) => (
            <li key={index} className="flex gap-2">
              <span className="shrink-0 text-subtle tabular">{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <span className={clsx(entry.level === 'warn' && 'text-warn', entry.level === 'error' && 'text-bad', entry.level === 'info' && 'text-muted')}>
                {entry.message}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

export function JobRow({ job, defaultOpen = false }: { job: Job; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const action = useJobAction()
  const ref = useRef<HTMLDivElement>(null)
  const active = isActive(job)
  const link = jobLink(job)

  useEffect(() => {
    if (defaultOpen) ref.current?.scrollIntoView({ block: 'center' })
  }, [defaultOpen])

  return (
    <div ref={ref} className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-3 px-3 py-3">
        {link ? (
          <Link to={link}>
            <Cover src={coverAt(job.coverUrl, 250)} className="size-12" rounded="sm" />
          </Link>
        ) : (
          <Cover src={coverAt(job.coverUrl, 250)} className="size-12" rounded="sm" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{job.title}</span>
            <Badge>{KIND[job.kind]}</Badge>
            {job.origin === 'watchlist' && <Badge tone="accent">New release</Badge>}
          </div>
          <div className="truncate text-[12.5px] text-muted">
            {job.artist}
            {job.kind === 'track' && job.album ? ` · ${job.album}` : ''}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[12.5px]">
            <StatusIcon status={job.status} className="size-3.5" />
            <span className={clsx('min-w-0 truncate', job.status === 'failed' ? 'text-bad' : 'text-fg/90')}>{statusLabel(job)}</span>
            <span className="ml-auto hidden shrink-0 text-[12px] text-muted tabular sm:inline">{progressLine(job)}</span>
          </div>
          {active && <Progress value={jobPercent(job)} className="mt-2" tone="accent" />}
        </div>
        <div className="flex shrink-0 items-center">
          {active && (
            <IconButton label="Cancel" onClick={() => action.mutate({ id: job.id, action: 'cancel' })}>
              <X className="size-4" />
            </IconButton>
          )}
          {(job.status === 'failed' || job.status === 'cancelled' || job.status === 'wanted') && (
            <IconButton label="Try again" onClick={() => action.mutate({ id: job.id, action: 'retry' })}>
              <RotateCw className="size-4" />
            </IconButton>
          )}
          {!active && (
            <IconButton label="Remove from list" onClick={() => action.mutate({ id: job.id, action: 'remove' })}>
              <Trash2 className="size-4" />
            </IconButton>
          )}
          <IconButton label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen((value) => !value)}>
            <ChevronDown className={clsx('size-4 transition-transform', open && 'rotate-180')} />
          </IconButton>
        </div>
      </div>
      {open && <JobDetailPanel job={job} />}
    </div>
  )
}

export function DownloadsPage() {
  const { data: jobs, isPending } = useJobs()
  const [params] = useSearchParams()
  const focus = params.get('job')
  const [filter, setFilter] = useState('')
  const client = useQueryClient()
  const clear = useMutation({
    mutationFn: () => api.post('/jobs/clear'),
    onSuccess: () => client.invalidateQueries({ queryKey: ['jobs'] }),
  })

  if (isPending) {
    return (
      <div>
        <PageHeader title="Downloads" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 rounded-lg border border-line px-3 py-3">
              <Skeleton className="size-12" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="mt-1.5 h-3 w-1/4" />
                <Skeleton className="mt-2.5 h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const all = jobs ?? []
  const q = filter.trim().toLowerCase()
  const list = q ? all.filter((job) => `${job.title} ${job.artist} ${job.album ?? ''}`.toLowerCase().includes(q)) : all
  const active = list.filter(isActive)
  const attention = list.filter((job) => job.status === 'failed')
  const waiting = list.filter((job) => job.status === 'wanted').length
  const finished = list.filter((job) => job.status === 'completed' || job.status === 'cancelled')

  return (
    <div>
      <PageHeader
        title="Downloads"
        subtitle={
          waiting ? (
            <>
              {waiting} waiting to retry in your{' '}
              <Link to="/wishlist" className="underline hover:text-fg">
                wishlist
              </Link>
            </>
          ) : undefined
        }
        actions={
          finished.length > 0 && (
            <Button size="sm" variant="ghost" loading={clear.isPending} onClick={() => clear.mutate()}>
              Clear finished
            </Button>
          )
        }
      />
      {all.length > 6 && (
        <div className="relative mb-6 max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-subtle" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter downloads"
            className="h-8.5 w-full rounded-md border border-line-strong bg-raised pr-3 pl-8 text-[13px] placeholder:text-subtle focus:border-fg/30 focus:outline-none"
          />
        </div>
      )}
      {all.length === 0 && (
        <Empty icon={<ArrowDownToLine className="size-6" />} title="Nothing downloading">
          Search for an album or song and press Download. Progress shows up here.
        </Empty>
      )}
      {all.length > 0 && list.length === 0 && <p className="text-[13px] text-muted">No downloads match “{filter}”.</p>}
      {active.length > 0 && (
        <Section className="animate-content-in" title="In progress" count={active.length}>
          <div className="flex flex-col gap-2">
            {active.map((job) => (
              <JobRow key={job.id} job={job} defaultOpen={focus === job.id} />
            ))}
          </div>
        </Section>
      )}
      {attention.length > 0 && (
        <Section className="animate-content-in" title="Failed" count={attention.length}>
          <div className="flex flex-col gap-2">
            {attention.map((job) => (
              <JobRow key={job.id} job={job} defaultOpen={focus === job.id} />
            ))}
          </div>
        </Section>
      )}
      {finished.length > 0 && (
        <Section className="animate-content-in" title="Finished" count={finished.length}>
          <div className="flex flex-col gap-2">
            {finished.map((job) => (
              <JobRow key={job.id} job={job} defaultOpen={focus === job.id} />
            ))}
          </div>
          <p className="mt-3 text-[12px] text-subtle">Finished downloads stay here for two weeks. Last updated {relativeTime(finished[0]?.updatedAt)}.</p>
        </Section>
      )}
    </div>
  )
}
