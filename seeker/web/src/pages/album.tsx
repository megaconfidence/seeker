import { useQuery } from '@tanstack/react-query'
import { Headphones, Play, Search } from 'lucide-react'
import { Link, useParams } from 'react-router'
import type { CatalogAlbumPage, LibraryAlbumDetail } from '../../../shared/types.ts'
import { useAlbumJob } from '../components/album-card.tsx'
import { Cover } from '../components/cover.tsx'
import { DownloadButton } from '../components/download-button.tsx'
import { progressLine, StatusIcon, statusLabel } from '../components/job.tsx'
import { HeaderSkeleton, RowsSkeleton } from '../components/skeleton.tsx'
import { playable, TrackList } from '../components/track-list.tsx'
import { Badge, Button, Empty, Progress } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { coverAt } from '../lib/covers.ts'
import { albumRequest, jobPercent } from '../lib/downloads.ts'
import { longDuration, plural, recordTypeLabel } from '../lib/format.ts'
import { isActive, useJobs } from '../lib/live.ts'
import { fromLibrary, usePlayer } from '../lib/player.tsx'

export function AlbumPage() {
  const { id, mbid } = useParams()
  const albumId = Number(id ?? 0)
  const page = useQuery({
    queryKey: ['catalog', 'album', mbid ?? albumId],
    queryFn: () => api.get<CatalogAlbumPage>(mbid ? `/catalog/mb/album/${mbid}` : `/catalog/album/${albumId}`),
  })
  const library = useQuery({
    queryKey: ['library', 'album', page.data?.libraryAlbumId],
    queryFn: () => api.get<LibraryAlbumDetail>(`/library/albums/${page.data!.libraryAlbumId}`),
    enabled: !!page.data?.libraryAlbumId,
  })
  const job = useAlbumJob(
    page.data?.album ?? { id: albumId, mbid: mbid ?? null, source: mbid ? 'musicbrainz' : 'deezer', job: null },
  )
  const { data: jobs } = useJobs()
  const fullJob = job ? jobs?.find((item) => item.id === job.id) : undefined
  const player = usePlayer()

  if (page.isPending) {
    return (
      <div>
        <HeaderSkeleton />
        <RowsSkeleton count={10} />
      </div>
    )
  }
  if (page.isError) return <Empty title="Couldn’t load this album">{(page.error as Error).message}</Empty>

  const { album, tracks } = page.data
  const libraryTracks = library.data?.tracks ?? []
  const previews = tracks.map(playable).filter((track) => track !== null)
  const canPreview = album.source === 'deezer' && album.owned !== 'complete' && previews.length > 0

  const meta = [album.year, plural(tracks.length, 'song'), longDuration(album.duration), album.label].filter(Boolean)
  const soulseekQuery = `/soulseek?q=${encodeURIComponent(`${album.artist} ${album.title}`)}${album.source === 'deezer' ? `&album=${album.id}` : ''}`

  return (
    <div className="animate-content-in">
      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <Cover src={coverAt(album.cover, 500)} className="w-44 shadow-xl shadow-black/20 sm:w-56" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-12 font-medium text-muted">
            {recordTypeLabel[album.type]}
            {album.source === 'musicbrainz' && <Badge>MusicBrainz</Badge>}
          </div>
          <h1 className="mt-1 text-28 leading-tight font-semibold tracking-tight sm:text-34">{album.title}</h1>
          <div className="mt-2 text-13.5 text-muted">
            {album.artistId ? (
              <Link to={`/artist/${album.artistId}`} className="font-medium text-fg hover:underline">
                {album.artist}
              </Link>
            ) : (
              <Link to={`/?q=${encodeURIComponent(album.artist)}`} className="font-medium text-fg hover:underline">
                {album.artist}
              </Link>
            )}
            {meta.map((item) => (
              <span key={String(item)}> · {item}</span>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <DownloadButton request={albumRequest(album)} owned={album.owned} job={job} />
            {libraryTracks.length > 0 ? (
              <Button icon={<Play className="size-3.5" fill="currentColor" />} onClick={() => player.play(libraryTracks.map(fromLibrary))}>
                Play
              </Button>
            ) : (
              canPreview && (
                <Button icon={<Headphones className="size-3.5" />} onClick={() => player.play(previews)} title="Play 30-second previews">
                  Preview
                </Button>
              )
            )}
            <Link to={soulseekQuery}>
              <Button variant="ghost" icon={<Search className="size-3.5" />}>
                Pick a copy on Soulseek
              </Button>
            </Link>
            {page.data.libraryAlbumId && (
              <Link to={`/library/album/${page.data.libraryAlbumId}`} className="text-12.5 text-muted hover:text-fg hover:underline">
                Open in library
              </Link>
            )}
          </div>
        </div>
      </div>

      {fullJob && fullJob.status !== 'completed' && fullJob.status !== 'cancelled' && (
        <Link
          to={`/downloads?job=${fullJob.id}`}
          className="mb-6 block rounded-lg border border-line bg-panel px-4 py-3 transition hover:border-line-strong"
        >
          <div className="flex items-center gap-2.5 text-13">
            <StatusIcon status={fullJob.status} />
            <span className="min-w-0 flex-1 truncate">{statusLabel(fullJob)}</span>
            <span className="text-12 text-muted tabular">{progressLine(fullJob)}</span>
          </div>
          {isActive(fullJob) && <Progress value={jobPercent(fullJob)} className="mt-2.5" tone="accent" />}
          {fullJob.status === 'wanted' && fullJob.error && <p className="mt-1 text-12.5 text-muted">{fullJob.error}</p>}
        </Link>
      )}

      <TrackList tracks={tracks} variant="album" albumArtist={album.artist} />

      {album.genres.length > 0 && <p className="mt-6 px-3 text-12 text-subtle">{album.genres.join(', ')}</p>}
      {album.source === 'musicbrainz' && (
        <p className="mt-6 px-3 text-12 text-subtle">
          From MusicBrainz, for releases the main catalog doesn’t have. Songs can only be downloaded as part of the album.
        </p>
      )}
    </div>
  )
}
