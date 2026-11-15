import clsx from 'clsx'
import { AudioLines, Play } from 'lucide-react'
import { Link } from 'react-router'
import type { CatalogTrack } from '../../../shared/types.ts'
import { duration } from '../lib/format.ts'
import { fromPreview, usePlayer, type PlayerTrack } from '../lib/player.tsx'
import { Cover } from './cover.tsx'
import { TrackDownloadIcon } from './download-button.tsx'

function Explicit() {
  return (
    <span className="ml-1.5 inline-flex h-3.5 shrink-0 items-center rounded-[0.1875rem] bg-subtle/30 px-1 text-9.5 font-semibold text-muted" title="Explicit">
      E
    </span>
  )
}

// Songs you own play from your library; anything else plays Deezer's 30-second preview.
export function playable(track: CatalogTrack): PlayerTrack | null {
  if (track.owned && track.libraryTrackId) {
    return {
      key: `lib:${track.libraryTrackId}`,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      src: `/api/library/tracks/${track.libraryTrackId}/stream`,
      cover: track.cover,
      href: track.albumId ? `/album/${track.albumId}` : null,
    }
  }
  return track.id ? fromPreview(track) : null
}

export function TrackList({
  tracks,
  variant,
  albumArtist,
}: {
  tracks: CatalogTrack[]
  variant: 'album' | 'list'
  albumArtist?: string
}) {
  const player = usePlayer()
  const discs = new Set(tracks.map((track) => track.disc ?? 1))
  const multiDisc = variant === 'album' && discs.size > 1
  let lastDisc: number | null = null

  const start = (track: CatalogTrack) => {
    const items = tracks.map((item) => ({ item, playable: playable(item) })).filter((entry) => entry.playable)
    const index = items.findIndex((entry) => entry.item === track)
    if (index >= 0) player.play(items.map((entry) => entry.playable!), index)
  }

  return (
    <div className="flex flex-col">
      {tracks.map((track, index) => {
        const disc = track.disc ?? 1
        const header = multiDisc && disc !== lastDisc
        lastDisc = disc
        const item = playable(track)
        const isCurrent = !!item && player.current?.key === item.key
        const title = item?.preview ? `Play a preview of ${track.title}` : `Play ${track.title}`
        return (
          <div key={`${track.id}-${index}`}>
            {header && <div className="mt-4 mb-1 px-3 text-12 font-medium text-subtle first:mt-0">Disc {disc}</div>}
            <div
              className={clsx(
                'group grid h-12 items-center gap-3 rounded-md px-3 hover:bg-hover',
                isCurrent && 'bg-hover',
                variant === 'album' ? 'grid-cols-[1.75rem_1fr_auto_1.75rem]' : 'grid-cols-[2.5rem_1fr_auto_1.75rem] md:grid-cols-[2.5rem_1fr_1fr_auto_1.75rem]',
              )}
              onDoubleClick={() => item && start(track)}
            >
              {variant === 'album' ? (
                <div className="relative flex justify-center text-12.5 text-subtle tabular">
                  {isCurrent && player.playing ? (
                    <AudioLines className="size-4 text-accent" />
                  ) : (
                    <>
                      <span className={clsx(item && 'group-hover:invisible')}>{track.track ?? index + 1}</span>
                      {item && (
                        <button
                          type="button"
                          onClick={() => start(track)}
                          className="invisible absolute inset-0 flex items-center justify-center text-fg group-hover:visible focus-visible:visible"
                          aria-label={title}
                          title={item.preview ? 'Preview' : 'Play'}
                        >
                          <Play className="size-3.5" fill="currentColor" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="relative size-10">
                  <Cover src={track.cover} className="size-10" rounded="sm" />
                  {item && (
                    <button
                      type="button"
                      onClick={() => start(track)}
                      className={clsx(
                        'absolute inset-0 flex items-center justify-center rounded-sm bg-black/45 text-white transition-opacity',
                        isCurrent && player.playing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                      )}
                      aria-label={title}
                      title={item.preview ? 'Preview' : 'Play'}
                    >
                      {isCurrent && player.playing ? <AudioLines className="size-4" /> : <Play className="size-4" fill="currentColor" />}
                    </button>
                  )}
                </div>
              )}
              <div className="min-w-0">
                <div className={clsx('flex items-center truncate text-13 font-medium', isCurrent && 'text-accent')}>
                  <span className="truncate">{track.title}</span>
                  {track.explicit && <Explicit />}
                </div>
                {(albumArtist ? track.artist !== albumArtist : variant === 'list') &&
                  (track.artistId ? (
                    <Link to={`/artist/${track.artistId}`} className="block truncate text-12.5 text-muted hover:text-fg hover:underline">
                      {track.artist}
                    </Link>
                  ) : (
                    <span className="block truncate text-12.5 text-muted">{track.artist}</span>
                  ))}
              </div>
              {variant === 'list' && (
                <Link to={`/album/${track.albumId}`} className="hidden truncate text-12.5 text-muted hover:text-fg hover:underline md:block">
                  {track.album}
                </Link>
              )}
              <span className="text-12.5 text-subtle tabular">{duration(track.duration)}</span>
              {track.id ? (
                <TrackDownloadIcon trackId={track.id} owned={track.owned} job={track.job} />
              ) : (
                <span className="flex size-7 items-center justify-center">
                  {track.owned && <span className="size-1.5 rounded-full bg-ok" title="In your library" />}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
