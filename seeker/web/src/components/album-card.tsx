import { ArrowDownToLine, Check, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { CatalogAlbum } from '../../../shared/types.ts'
import { coverAt } from '../lib/covers.ts'
import { albumHref, albumRequest, useStartDownload } from '../lib/downloads.ts'
import { recordTypeLabel } from '../lib/format.ts'
import { isActive } from '../lib/live.ts'
import { useLiveJob } from './download-button.tsx'
import { Cover } from './cover.tsx'

export function useAlbumJob(album: Pick<CatalogAlbum, 'id' | 'mbid' | 'source' | 'job'>) {
  return useLiveJob(album.job, (item) =>
    item.kind === 'album' && (album.source === 'musicbrainz' ? item.mbReleaseId === album.mbid && !item.deezerAlbumId : item.deezerAlbumId === album.id),
  )
}

export function AlbumCard({ album, showArtist = true }: { album: CatalogAlbum; showArtist?: boolean }) {
  const start = useStartDownload()
  const job = useAlbumJob(album)
  const active = isActive(job)
  const owned = album.owned === 'complete' && !active
  const href = albumHref(album)
  const meta = [album.year, album.type !== 'album' ? recordTypeLabel[album.type] : null].filter(Boolean).join(' · ')

  return (
    <div className="group min-w-0">
      <Link to={href} className="relative block">
        <Cover src={coverAt(album.cover, 500)} alt="" className="w-full transition group-hover:brightness-[0.85]" />
        <div className="absolute right-2 bottom-2 flex gap-1.5">
          {active ? (
            <span className="flex size-8 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur" title="Downloading">
              <LoaderCircle className="size-4 animate-spin" />
            </span>
          ) : owned ? (
            <span className="flex size-6 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur" title="In your library">
              <Check className="size-3.5" />
            </span>
          ) : (
            <button
              type="button"
              title={album.owned === 'partial' ? 'Download the missing tracks' : 'Download'}
              aria-label={`Download ${album.title}`}
              disabled={start.isPending}
              onClick={(event) => {
                event.preventDefault()
                start.mutate(albumRequest(album))
              }}
              className="flex size-8 translate-y-1 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100"
            >
              {start.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
            </button>
          )}
        </div>
      </Link>
      <div className="mt-2 min-w-0">
        <Link to={href} className="block truncate text-13 font-medium hover:underline" title={album.title}>
          {album.title}
        </Link>
        <div className="truncate text-12.5 text-muted">
          {showArtist &&
            (album.artistId ? (
              <Link to={`/artist/${album.artistId}`} className="hover:text-fg hover:underline">
                {album.artist}
              </Link>
            ) : (
              album.artist
            ))}
          {showArtist && meta ? ' · ' : ''}
          {meta}
          {album.owned === 'partial' && <span className="text-warn"> · Partly owned</span>}
        </div>
      </div>
    </div>
  )
}

export function AlbumGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">{children}</div>
}
