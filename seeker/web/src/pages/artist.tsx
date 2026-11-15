import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Radar } from 'lucide-react'
import { useParams } from 'react-router'
import type { CatalogAlbum, CatalogArtistPage, RecordType } from '../../../shared/types.ts'
import { AlbumCard, AlbumGrid } from '../components/album-card.tsx'
import { Cover } from '../components/cover.tsx'
import { AlbumGridSkeleton, HeaderSkeleton } from '../components/skeleton.tsx'
import { TrackList } from '../components/track-list.tsx'
import { Button, Empty, Section } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useToast } from '../lib/toast.tsx'

const SECTIONS: { type: RecordType; title: string }[] = [
  { type: 'album', title: 'Albums' },
  { type: 'ep', title: 'EPs' },
  { type: 'single', title: 'Singles' },
  { type: 'compile', title: 'Compilations' },
]

function formatFans(count: number | undefined): string | null {
  if (!count) return null
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M fans`
  if (count >= 1000) return `${Math.round(count / 1000)}K fans`
  return `${count} fans`
}

export function ArtistPage() {
  const { id } = useParams()
  const artistId = Number(id)
  const client = useQueryClient()
  const toast = useToast()
  const page = useQuery({
    queryKey: ['catalog', 'artist', artistId],
    queryFn: () => api.get<CatalogArtistPage>(`/catalog/artist/${artistId}`),
  })
  const follow = useMutation({
    mutationFn: (watch: boolean) => (watch ? api.post('/watchlist', { artistId }) : api.del(`/watchlist/${artistId}`)),
    onSuccess: (_, watch) => {
      client.setQueryData<CatalogArtistPage>(['catalog', 'artist', artistId], (data) =>
        data ? { ...data, artist: { ...data.artist, watched: watch } } : data,
      )
      void client.invalidateQueries({ queryKey: ['watchlist'] })
      if (watch) toast('Following. New releases will download automatically.')
      else toast('Unfollowed', { action: { label: 'Undo', onClick: () => follow.mutate(true) } })
    },
    onError: (error) => toast(error.message, 'error'),
  })

  if (page.isPending) {
    return (
      <div>
        <HeaderSkeleton round />
        <AlbumGridSkeleton count={6} />
      </div>
    )
  }
  if (page.isError) return <Empty title="Couldn’t load this artist">{(page.error as Error).message}</Empty>

  const { artist, top, albums } = page.data
  const byType = new Map<RecordType, CatalogAlbum[]>()
  for (const album of albums) byType.set(album.type, [...(byType.get(album.type) ?? []), album])
  const owned = albums.filter((album) => album.owned === 'complete').length

  return (
    <div className="animate-content-in">
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end">
        <Cover src={artist.picture} rounded="full" kind="artist" className="w-36 sm:w-44" />
        <div className="min-w-0 flex-1">
          <div className="text-12 font-medium text-muted">Artist</div>
          <h1 className="mt-1 text-30 leading-tight font-semibold tracking-tight sm:text-38">{artist.name}</h1>
          <div className="mt-2 text-13 text-muted">
            {[formatFans(artist.fans), `${albums.length} releases`, owned ? `${owned} in your library` : null].filter(Boolean).join(' · ')}
          </div>
          <div className="mt-5">
            <Button
              variant={artist.watched ? 'secondary' : 'primary'}
              icon={<Radar className="size-3.5" />}
              loading={follow.isPending}
              onClick={() => follow.mutate(!artist.watched)}
              title={artist.watched ? 'Stop downloading new releases' : 'Download new releases automatically'}
            >
              {artist.watched ? 'Following' : 'Follow new releases'}
            </Button>
          </div>
        </div>
      </div>

      {top.length > 0 && (
        <Section title="Popular">
          <TrackList tracks={top.slice(0, 5)} variant="list" albumArtist={artist.name} />
        </Section>
      )}

      {SECTIONS.map(({ type, title }) => {
        const list = byType.get(type)
        if (!list?.length) return null
        return (
          <Section key={type} title={title} count={list.length}>
            <AlbumGrid>
              {list.map((album) => (
                <AlbumCard key={album.id} album={album} showArtist={false} />
              ))}
            </AlbumGrid>
          </Section>
        )
      })}
    </div>
  )
}
