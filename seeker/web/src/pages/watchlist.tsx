import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Radar, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import type { RecordType, Settings, WatchArtist } from '../../../shared/types.ts'
import { Cover } from '../components/cover.tsx'
import { Skeleton } from '../components/skeleton.tsx'
import { Button, Empty, PageHeader } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { relativeTime } from '../lib/format.ts'
import { useToast } from '../lib/toast.tsx'

const TYPES: { value: RecordType; label: string }[] = [
  { value: 'album', label: 'Albums' },
  { value: 'ep', label: 'EPs' },
  { value: 'single', label: 'Singles' },
  { value: 'compile', label: 'Compilations' },
]

export function WatchlistPage() {
  const client = useQueryClient()
  const toast = useToast()
  const { data, isPending } = useQuery({ queryKey: ['watchlist'], queryFn: () => api.get<WatchArtist[]>('/watchlist') })
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') })
  const refresh = () => client.invalidateQueries({ queryKey: ['watchlist'] })

  const update = useMutation({
    mutationFn: ({ id, types }: { id: number; types: RecordType[] }) => api.put(`/watchlist/${id}`, { types }),
    onSuccess: refresh,
    onError: (error) => toast(error.message, 'error'),
  })
  const follow = useMutation({
    mutationFn: (artistId: number) => api.post('/watchlist', { artistId }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (artist: WatchArtist) => api.del(`/watchlist/${artist.id}`),
    onSuccess: (_, artist) => {
      void refresh()
      toast(`Unfollowed ${artist.name}`, { action: { label: 'Undo', onClick: () => follow.mutate(artist.id) } })
    },
    onError: (error) => toast(error.message, 'error'),
  })
  const checkAll = useMutation({
    mutationFn: () => api.post('/watchlist/check'),
    onSuccess: () => toast('Checking for new releases'),
  })

  const interval = settings.data?.watchlist.intervalHours

  return (
    <div>
      <PageHeader
        title="Watchlist"
        subtitle={`New releases from these artists download automatically${interval ? `. Checked every ${interval} hours` : ''}.`}
        actions={
          data && data.length > 0 ? (
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} loading={checkAll.isPending} onClick={() => checkAll.mutate()}>
              Check now
            </Button>
          ) : null
        }
      />
      {isPending ? (
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-3 py-3">
              <Skeleton className="size-11 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-1/4" />
                <Skeleton className="mt-1.5 h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : !data?.length ? (
        <Empty icon={<Radar className="size-6" />} title="Not following anyone yet">
          Open an artist and choose <span className="font-medium text-fg">Follow new releases</span>. Seeker will grab their next album as soon as it’s out.
        </Empty>
      ) : (
        <div className="flex animate-content-in flex-col divide-y divide-line rounded-lg border border-line">
          {data.map((artist) => (
            <div key={artist.id} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center">
              <Link to={`/artist/${artist.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                <Cover src={artist.picture} rounded="full" kind="artist" className="size-11" />
                <div className="min-w-0">
                  <div className="truncate text-13.5 font-medium hover:underline">{artist.name}</div>
                  <div className="text-12 text-muted">
                    {artist.lastCheckedAt ? `Checked ${relativeTime(artist.lastCheckedAt)}` : 'Not checked yet'}
                    {artist.lastFound > 0 && ` · ${artist.lastFound} new release${artist.lastFound === 1 ? '' : 's'} found`}
                  </div>
                </div>
              </Link>
              <div className="flex flex-wrap items-center gap-1.5">
                {TYPES.map((type) => {
                  const on = artist.types.includes(type.value)
                  return (
                    <button
                      key={type.value}
                      type="button"
                      onClick={() => {
                        const next = on ? artist.types.filter((item) => item !== type.value) : [...artist.types, type.value]
                        if (next.length) update.mutate({ id: artist.id, types: next })
                      }}
                      className={clsx(
                        'h-7 rounded-full border px-2.5 text-12 transition-colors',
                        on ? 'border-fg/20 bg-hover text-fg' : 'border-line text-subtle hover:text-muted',
                      )}
                    >
                      {type.label}
                    </button>
                  )
                })}
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(artist)}>
                  Unfollow
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
