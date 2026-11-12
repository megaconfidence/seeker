import clsx from 'clsx'
import { CircleAlert, CircleCheck, CircleX, Clock, LoaderCircle } from 'lucide-react'
import type { Job, JobStatus } from '../../../shared/types.ts'
import { jobEta } from '../lib/downloads.ts'
import { relativeTime, speed, timeLeft } from '../lib/format.ts'

export function statusLabel(job: Pick<Job, 'status' | 'phase' | 'error' | 'nextRetryAt'>): string {
  switch (job.status) {
    case 'queued':
      return job.phase ?? 'Queued'
    case 'searching':
      return job.phase ?? 'Searching Soulseek'
    case 'downloading':
      return job.phase ?? 'Downloading'
    case 'processing':
      return job.phase ?? 'Checking and tagging'
    case 'completed':
      return 'In your library'
    case 'wanted':
      return job.nextRetryAt ? `Trying again ${relativeTime(job.nextRetryAt)}` : 'Waiting to try again'
    case 'failed':
      return job.error ?? 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

export function StatusIcon({ status, className }: { status: JobStatus; className?: string }) {
  const size = clsx('size-4 shrink-0', className)
  switch (status) {
    case 'queued':
      return <Clock className={clsx(size, 'text-subtle')} />
    case 'searching':
    case 'downloading':
    case 'processing':
      return <LoaderCircle className={clsx(size, 'animate-spin text-accent')} />
    case 'completed':
      return <CircleCheck className={clsx(size, 'text-ok')} />
    case 'wanted':
      return <Clock className={clsx(size, 'text-warn')} />
    case 'failed':
      return <CircleAlert className={clsx(size, 'text-bad')} />
    case 'cancelled':
      return <CircleX className={clsx(size, 'text-subtle')} />
  }
}

export function progressLine(job: Job): string {
  const parts: string[] = []
  if (job.progress.files > 1) parts.push(`${job.progress.done} of ${job.progress.files} ${job.kind === 'import' ? 'files' : 'tracks'}`)
  const rate = speed(job.progress.speed)
  if (job.status === 'downloading' && rate) parts.push(rate)
  const left = timeLeft(jobEta(job))
  if (left) parts.push(left)
  if (job.source && job.status !== 'queued' && job.status !== 'searching') parts.push(job.source.quality)
  return parts.join(' · ')
}
