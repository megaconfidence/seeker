import clsx from 'clsx'

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-hover', className)} />
}

export function AlbumGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          <Skeleton className="aspect-square w-full" />
          <Skeleton className="mt-2.5 h-3.5 w-4/5" />
          <Skeleton className="mt-1.5 h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

export function RowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-12 items-center gap-3 px-3">
          <Skeleton className="size-5" />
          <div className="flex-1">
            <Skeleton className="h-3.5" />
          </div>
          <Skeleton className="h-3 w-9" />
        </div>
      ))}
    </div>
  )
}

export function HeaderSkeleton({ round = false }: { round?: boolean }) {
  return (
    <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
      <Skeleton className={clsx('aspect-square w-44 sm:w-56', round && 'rounded-full')} />
      <div className="flex-1">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-8 w-2/3" />
        <Skeleton className="mt-3 h-3.5 w-1/2" />
        <Skeleton className="mt-6 h-8.5 w-40" />
      </div>
    </div>
  )
}
