import { ArrowDownToLine, Check, Clock, LoaderCircle, RotateCw } from 'lucide-react'
import type { Job, JobRef, OwnedState } from '../../../shared/types.ts'
import { useConfirm } from '../lib/confirm.tsx'
import { useStartDownload, type JobRequest } from '../lib/downloads.ts'
import { isActive, useJobs } from '../lib/live.ts'
import { Button } from './ui.tsx'

export function useLiveJob(ref: JobRef | null, match: (job: Job) => boolean): JobRef | null {
  const { data: jobs } = useJobs()
  const found = jobs?.find((job) => match(job) && job.status !== 'cancelled')
  if (found) return { id: found.id, status: found.status }
  if (!ref) return null
  const live = jobs?.find((job) => job.id === ref.id)
  return live ? { id: live.id, status: live.status } : ref
}

const ACTIVE_LABEL: Record<string, string> = {
  queued: 'Queued',
  searching: 'Searching',
  downloading: 'Downloading',
  processing: 'Tagging',
}

export function DownloadButton({
  request,
  owned,
  job,
  size = 'md',
  label = 'Download',
}: {
  request: JobRequest
  owned: OwnedState | boolean
  job: JobRef | null
  size?: 'sm' | 'md'
  label?: string
}) {
  const start = useStartDownload()
  const confirm = useConfirm()
  const ownedState: OwnedState = owned === true ? 'complete' : owned === false ? 'none' : owned

  if (job && isActive(job)) {
    return (
      <Button size={size} variant="secondary" disabled icon={<LoaderCircle className="size-3.5 animate-spin" />}>
        {ACTIVE_LABEL[job.status] ?? 'Downloading'}
      </Button>
    )
  }
  if (job?.status === 'wanted' || job?.status === 'failed') {
    return (
      <Button
        size={size}
        variant="secondary"
        icon={job.status === 'wanted' ? <Clock className="size-3.5" /> : <RotateCw className="size-3.5" />}
        loading={start.isPending}
        onClick={() => start.mutate(request)}
        title="Try again now"
      >
        {job.status === 'wanted' ? 'Waiting · try now' : 'Try again'}
      </Button>
    )
  }
  if (ownedState === 'complete') {
    return (
      <Button
        size={size}
        variant="secondary"
        icon={<Check className="size-3.5 text-ok" />}
        loading={start.isPending}
        title="Download again"
        onClick={async () => {
          const again = await confirm({
            title: 'Download it again?',
            description: 'This is already in your library. Seeker keeps whichever copy is better.',
            confirmLabel: 'Download again',
          })
          if (again) start.mutate({ ...request, force: true } as JobRequest)
        }}
      >
        In library
      </Button>
    )
  }
  return (
    <Button
      size={size}
      variant="primary"
      icon={<ArrowDownToLine className="size-3.5" />}
      loading={start.isPending}
      onClick={() => start.mutate(request)}
    >
      {ownedState === 'partial' ? 'Download missing' : label}
    </Button>
  )
}

export function TrackDownloadIcon({ trackId, owned, job }: { trackId: number; owned: boolean; job: JobRef | null }) {
  const start = useStartDownload()
  const live = useLiveJob(job, (item) => item.kind === 'track' && item.deezerTrackId === trackId)
  if (live && isActive(live)) {
    return (
      <span className="flex size-7 items-center justify-center" title="Downloading">
        <LoaderCircle className="size-4 animate-spin text-accent" />
      </span>
    )
  }
  if (owned) {
    return (
      <span className="flex size-7 items-center justify-center" title="In your library">
        <Check className="size-4 text-ok" />
      </span>
    )
  }
  if (live?.status === 'wanted') {
    return (
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-md text-warn hover:bg-hover"
        title="Waiting to try again. Click to try now."
        aria-label="Try again now"
        onClick={() => start.mutate({ type: 'track', trackId })}
      >
        <Clock className="size-4" />
      </button>
    )
  }
  return (
    <button
      type="button"
      className="flex size-7 items-center justify-center rounded-md text-subtle opacity-70 transition hover:bg-hover hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      title="Download this song"
      aria-label="Download this song"
      disabled={start.isPending}
      onClick={(event) => {
        event.stopPropagation()
        start.mutate({ type: 'track', trackId })
      }}
    >
      {start.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
    </button>
  )
}
