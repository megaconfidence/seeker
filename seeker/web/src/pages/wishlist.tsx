import { Hourglass, RotateCw, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { Cover } from '../components/cover.tsx'
import { Skeleton } from '../components/skeleton.tsx'
import { Button, Empty, IconButton, PageHeader } from '../components/ui.tsx'
import { coverAt } from '../lib/covers.ts'
import { jobLink, useJobAction } from '../lib/downloads.ts'
import { plural, relativeTime } from '../lib/format.ts'
import { useJobs } from '../lib/live.ts'
import { KIND } from './downloads.tsx'

export function WishlistPage() {
  const { data: jobs, isPending } = useJobs()
  const action = useJobAction()
  const wanted = (jobs ?? [])
    .filter((job) => job.status === 'wanted')
    .sort((a, b) => (a.nextRetryAt ?? 0) - (b.nextRetryAt ?? 0))

  return (
    <div>
      <PageHeader
        title="Wishlist"
        subtitle="Things that couldn’t be found yet. Seeker keeps looking: after 1 hour, then 4, 12, 24, and every 3 days after that."
        actions={
          wanted.length > 1 && (
            <Button
              size="sm"
              variant="secondary"
              icon={<RotateCw className="size-3.5" />}
              onClick={() => wanted.forEach((job) => action.mutate({ id: job.id, action: 'retry' }))}
            >
              Try all now
            </Button>
          )
        }
      />
      {isPending ? (
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-3 py-3">
              <Skeleton className="size-11" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="mt-1.5 h-3 w-1/4" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : wanted.length === 0 ? (
        <Empty icon={<Hourglass className="size-6" />} title="Nothing waiting">
          When an album or song can’t be found on Soulseek right now, it lands here and is retried automatically.
        </Empty>
      ) : (
        <div className="flex animate-content-in flex-col divide-y divide-line rounded-lg border border-line">
          {wanted.map((job) => {
            const link = jobLink(job)
            return (
              <div key={job.id} className="flex items-center gap-3 px-3 py-3">
                <Cover src={coverAt(job.coverUrl, 250)} className="size-11" rounded="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">
                    {link ? (
                      <Link to={link} className="hover:underline">
                        {job.title}
                      </Link>
                    ) : (
                      job.title
                    )}
                  </div>
                  <div className="truncate text-[12.5px] text-muted">
                    {job.artist} · {KIND[job.kind]}
                  </div>
                  <div className="mt-1 truncate text-[12.5px] text-muted">
                    <span className="text-fg/80">{job.error ?? 'Not found yet'}</span>
                    {job.nextRetryAt && <span> · next try {relativeTime(job.nextRetryAt)}</span>}
                    <span> · {plural(job.attempts, 'attempt')}</span>
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => action.mutate({ id: job.id, action: 'retry' })}>
                  Try now
                </Button>
                <IconButton label="Remove from wishlist" onClick={() => action.mutate({ id: job.id, action: 'remove' })}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
