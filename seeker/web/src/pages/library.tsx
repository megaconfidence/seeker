import { useMutation, useQuery } from '@tanstack/react-query'
import { FolderInput, Library as LibraryIcon, Play, RefreshCw, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import type { LibraryAlbum, LibraryArtist, LibraryTrack } from '../../../shared/types.ts'
import { Cover } from '../components/cover.tsx'
import { AlbumGridSkeleton, Skeleton } from '../components/skeleton.tsx'
import { Button, Empty, PageHeader, Select, Tabs } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { plural } from '../lib/format.ts'
import { useStatus } from '../lib/live.ts'
import { coverUrl, fromLibrary, usePlayer } from '../lib/player.tsx'

type Sort = 'recent' | 'artist' | 'title' | 'year'

function AlbumTile({ album }: { album: LibraryAlbum }) {
  const player = usePlayer()
  const play = async (event: React.MouseEvent) => {
    event.preventDefault()
    const data = await api.get<{ tracks: LibraryTrack[] }>(`/library/albums/${album.id}`)
    if (data.tracks.length) player.play(data.tracks.map(fromLibrary))
  }
  return (
    <Link to={`/library/album/${album.id}`} className="group min-w-0">
      <div className="relative">
        <Cover src={album.hasCover ? coverUrl(album.id) : null} className="w-full transition group-hover:brightness-[0.85]" />
        <button
          type="button"
          onClick={play}
          aria-label={`Play ${album.title}`}
          className="absolute right-2 bottom-2 flex size-9 translate-y-1 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100"
        >
          <Play className="ml-0.5 size-4" fill="currentColor" />
        </button>
      </div>
      <div className="mt-2 truncate text-[13px] font-medium" title={album.title}>
        {album.title}
      </div>
      <div className="truncate text-[12.5px] text-muted">
        {album.artist}
        {album.year ? ` · ${album.year}` : ''}
      </div>
    </Link>
  )
}

export function LibraryPage() {
  const [params, setParams] = useSearchParams()
  const artist = params.get('artist')
  const [tab, setTab] = useState<'albums' | 'artists'>(params.get('tab') === 'artists' ? 'artists' : 'albums')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<Sort>((params.get('sort') as Sort) || 'recent')
  const { data: status } = useStatus()

  const albums = useQuery({
    queryKey: ['library', 'albums', sort, artist ?? ''],
    queryFn: () => api.get<LibraryAlbum[]>(`/library/albums?sort=${sort}${artist ? `&artist=${encodeURIComponent(artist)}` : ''}`),
  })
  const artists = useQuery({
    queryKey: ['library', 'artists'],
    queryFn: () => api.get<LibraryArtist[]>('/library/artists'),
    enabled: tab === 'artists',
  })
  const rescan = useMutation({ mutationFn: () => api.post('/library/scan') })

  const shownAlbums = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return albums.data ?? []
    return (albums.data ?? []).filter((album) => `${album.title} ${album.artist}`.toLowerCase().includes(q))
  }, [albums.data, filter])

  const shownArtists = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (artists.data ?? []).filter((item) => !q || item.name.toLowerCase().includes(q))
  }, [artists.data, filter])

  const scanning = status?.library.scanning || rescan.isPending
  const total = status?.library

  return (
    <div>
      <PageHeader
        title={artist ?? 'Library'}
        subtitle={
          artist ? (
            <button type="button" onClick={() => setParams({})} className="inline-flex items-center gap-1 hover:text-fg">
              <X className="size-3.5" /> Show all artists
            </button>
          ) : total ? (
            `${plural(total.albums, 'album')} · ${plural(total.tracks, 'track')}`
          ) : undefined
        }
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<RefreshCw className={scanning ? 'size-3.5 animate-spin' : 'size-3.5'} />} disabled={scanning} onClick={() => rescan.mutate()}>
              {scanning ? 'Scanning' : 'Rescan'}
            </Button>
            <Link to="/import">
              <Button size="sm" icon={<FolderInput className="size-3.5" />}>
                Import music
              </Button>
            </Link>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        {!artist && (
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: 'albums', label: 'Albums' },
              { value: 'artists', label: 'Artists' },
            ]}
          />
        )}
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-subtle" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={tab === 'albums' ? 'Filter albums' : 'Filter artists'}
            className="h-8.5 w-full rounded-md border border-line-strong bg-raised pr-3 pl-8 text-[13px] placeholder:text-subtle focus:border-fg/30 focus:outline-none"
          />
        </div>
        {tab === 'albums' && (
          <Select
            value={sort}
            onChange={setSort}
            className="ml-auto"
            options={[
              { value: 'recent', label: 'Recently added' },
              { value: 'artist', label: 'Artist' },
              { value: 'title', label: 'Title' },
              { value: 'year', label: 'Year' },
            ]}
          />
        )}
      </div>

      {tab === 'albums' || artist ? (
        albums.isPending ? (
          <AlbumGridSkeleton />
        ) : shownAlbums.length === 0 ? (
          <Empty icon={<LibraryIcon className="size-6" />} title={filter ? 'No matching albums' : 'Your library is empty'}>
            {filter ? (
              'Try a different filter.'
            ) : (
              <>
                Music you download with Seeker, and anything already in your music folder, shows up here. Have music somewhere else?{' '}
                <Link to="/import" className="underline">
                  Import it
                </Link>
                .
              </>
            )}
          </Empty>
        ) : (
          <div className="grid animate-content-in grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {shownAlbums.map((album) => (
              <AlbumTile key={album.id} album={album} />
            ))}
          </div>
        )
      ) : artists.isPending ? (
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 p-2">
              <Skeleton className="size-11 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="mt-1.5 h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid animate-content-in grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {shownArtists.map((item) => (
            <button
              key={item.name}
              type="button"
              onClick={() => setParams({ artist: item.name })}
              className="flex items-center gap-3 rounded-lg p-2 text-left hover:bg-hover"
            >
              <Cover src={item.coverAlbumId ? coverUrl(item.coverAlbumId) : null} rounded="full" kind="artist" className="size-11" />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{item.name}</div>
                <div className="text-[12px] text-muted">
                  {plural(item.albums, 'album')} · {plural(item.tracks, 'track')}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
