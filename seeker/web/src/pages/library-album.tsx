import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowUpCircle, AudioLines, Disc3, Link2, Play, Shuffle, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { ImportCandidate, ImportChoice, Job, LibraryAlbumDetail, LibraryTrack } from '../../../shared/types.ts'
import { Cover } from '../components/cover.tsx'
import { MatchAlbumDialog } from '../components/match-album-dialog.tsx'
import { Menu } from '../components/menu.tsx'
import { HeaderSkeleton, RowsSkeleton } from '../components/skeleton.tsx'
import { Button, Empty } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useConfirm } from '../lib/confirm.tsx'
import { duration, longDuration, plural } from '../lib/format.ts'
import { coverUrl, fromLibrary, usePlayer } from '../lib/player.tsx'
import { useToast } from '../lib/toast.tsx'

export function trackQuality(track: Pick<LibraryTrack, 'codec' | 'lossless' | 'bitDepth' | 'sampleRate' | 'bitrate'>): string {
  const codec = (track.codec ?? '').toUpperCase()
  const name = codec.includes('FLAC')
    ? 'FLAC'
    : codec.includes('MPEG') || codec.includes('MP3')
      ? 'MP3'
      : codec.includes('AAC')
        ? 'AAC'
        : codec.includes('ALAC')
          ? 'ALAC'
          : codec.split(' ')[0] || ''
  if (track.lossless && track.bitDepth && track.sampleRate) return `${name} ${track.bitDepth}/${(track.sampleRate / 1000).toString()}`
  return track.bitrate ? `${name} ${track.bitrate}` : name
}

export function LibraryAlbumPage() {
  const { id } = useParams()
  const player = usePlayer()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const toast = useToast()
  const client = useQueryClient()
  const [matching, setMatching] = useState(false)
  const { data, isPending, isError } = useQuery({
    queryKey: ['library', 'album', id],
    queryFn: () => api.get<LibraryAlbumDetail>(`/library/albums/${id}`),
    retry: false,
  })

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['library'] })
    void client.invalidateQueries({ queryKey: ['catalog'] })
  }
  const viewJob = (job: Job) => ({ label: 'View', onClick: () => navigate(`/downloads?job=${job.id}`) })

  const upgrade = useMutation({
    mutationFn: () => api.post<{ job: Job }>(`/library/albums/${id}/upgrade`),
    onSuccess: ({ job }) => toast('Looking for a better copy', { action: viewJob(job) }),
    onError: (error) => toast(error.message, 'error'),
  })
  const remove = useMutation({
    mutationFn: () => api.del<{ deleted: number }>(`/library/albums/${id}`),
    onSuccess: () => {
      toast(`Deleted ${data?.album.title ?? 'the album'}`)
      refresh()
      navigate('/library')
    },
    onError: (error) => toast(error.message, 'error'),
  })
  const removeTrack = useMutation({
    mutationFn: (track: LibraryTrack) => api.del(`/library/tracks/${track.id}`),
    onSuccess: (_, track) => {
      toast(`Deleted ${track.title}`)
      if (data && data.tracks.length <= 1) navigate('/library')
      refresh()
    },
    onError: (error) => toast(error.message, 'error'),
  })

  if (isPending) {
    return (
      <div>
        <HeaderSkeleton />
        <RowsSkeleton />
      </div>
    )
  }
  if (isError) {
    return (
      <Empty icon={<Disc3 className="size-6" />} title="This album isn’t in your library">
        It may have been deleted, or renamed after matching it to the catalog.{' '}
        <Link to="/library" className="underline">
          Back to your library
        </Link>
      </Empty>
    )
  }

  const { album, tracks, canUpgrade, unsorted } = data
  const queue = tracks.map(fromLibrary)
  const discs = new Set(tracks.map((track) => track.discNo ?? 1))
  const linked = !!(album.deezerAlbumId || album.mbAlbumId)
  const catalogHref = album.deezerAlbumId ? `/album/${album.deezerAlbumId}` : album.mbAlbumId ? `/album/mb/${album.mbAlbumId}` : null
  let lastDisc: number | null = null

  const onMatch = async (choice: ImportChoice) => {
    const { job } = await api.post<{ job: Job }>(`/library/albums/${id}/match`, choice)
    toast('Re-tagging and filing the album', { action: viewJob(job) })
  }

  const upgradeAlbum = async () => {
    const yes = await confirm({
      title: `Find a better copy of ${album.title}?`,
      description: 'Better files permanently replace the lower-quality copies after downloading. There is no recycle bin. Back up your music first.',
      confirmLabel: 'Find a better copy',
      tone: 'danger',
    })
    if (yes) upgrade.mutate()
  }

  const deleteAlbum = async () => {
    const yes = await confirm({
      title: `Delete ${album.title}?`,
      description: `This permanently deletes ${plural(tracks.length, 'file')} from your music folder. There is no recycle bin and it can’t be undone.`,
      confirmLabel: 'Delete album',
      tone: 'danger',
    })
    if (yes) remove.mutate()
  }

  const deleteTrack = async (track: LibraryTrack) => {
    const yes = await confirm({
      title: `Delete ${track.title}?`,
      description: 'This permanently deletes the file from your music folder. There is no recycle bin and it can’t be undone.',
      confirmLabel: 'Delete song',
      tone: 'danger',
    })
    if (yes) removeTrack.mutate(track)
  }

  return (
    <div className="animate-content-in">
      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <Cover src={album.hasCover ? `${coverUrl(album.id)}?v=${album.addedAt}` : null} className="w-44 shadow-xl shadow-black/20 sm:w-56" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-muted">In your library</div>
          <h1 className="mt-1 text-[28px] leading-tight font-semibold tracking-tight sm:text-[34px]">{album.title}</h1>
          <div className="mt-2 text-[13.5px] text-muted">
            <Link to={`/library?artist=${encodeURIComponent(album.artist)}`} className="font-medium text-fg hover:underline">
              {album.artist}
            </Link>
            {[album.year, plural(album.trackCount, 'song'), longDuration(album.duration), album.format].filter(Boolean).map((item) => (
              <span key={String(item)}> · {item}</span>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Play className="size-3.5" fill="currentColor" />} onClick={() => player.play(queue)}>
              Play
            </Button>
            <Button icon={<Shuffle className="size-3.5" />} onClick={() => player.play(queue, 0, { shuffle: true })}>
              Shuffle
            </Button>
            {catalogHref && (
              <Link to={catalogHref}>
                <Button variant="ghost" icon={<Disc3 className="size-3.5" />}>
                  Album page
                </Button>
              </Link>
            )}
            <Menu
              items={[
                {
                  label: 'Find a better copy',
                  icon: <ArrowUpCircle />,
                  disabled: !canUpgrade || !linked || upgrade.isPending,
                  hint: !linked
                    ? 'Match the album to the catalog first'
                    : canUpgrade
                      ? 'Download a better-quality copy and replace these files'
                      : 'Already in your preferred quality',
                  onSelect: () => void upgradeAlbum(),
                },
                { label: 'Match to album…', icon: <Link2 />, onSelect: () => setMatching(true) },
                { label: 'Delete album', icon: <Trash2 />, tone: 'danger', onSelect: () => void deleteAlbum() },
              ]}
            />
          </div>
        </div>
      </div>

      {(unsorted || !linked) && (
        <div className="mb-6 flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3 sm:flex-row sm:items-center">
          <TriangleAlert className="size-4 shrink-0 text-warn" />
          <p className="min-w-0 flex-1 text-[13px] text-muted">
            {unsorted
              ? 'Seeker couldn’t tell which album these files belong to. Match them to fix the tags, file names and cover.'
              : 'This album isn’t linked to the catalog, so Seeker can’t look for a better copy. Match it to link it.'}
          </p>
          <Button size="sm" icon={<Link2 className="size-3.5" />} onClick={() => setMatching(true)}>
            Match to album
          </Button>
        </div>
      )}

      <div className="flex flex-col">
        {tracks.map((track, index) => {
          const disc = track.discNo ?? 1
          const header = discs.size > 1 && disc !== lastDisc
          lastDisc = disc
          const current = player.current?.key === `lib:${track.id}`
          return (
            <div key={track.id}>
              {header && <div className="mt-4 mb-1 px-3 text-[12px] font-medium text-subtle first:mt-0">Disc {disc}</div>}
              <div
                onClick={() => player.play(queue, index)}
                className={clsx(
                  'group grid h-12 w-full cursor-pointer grid-cols-[28px_1fr_auto_auto_32px] items-center gap-3 rounded-md pr-1 pl-3 text-left hover:bg-hover',
                  current && 'bg-hover',
                )}
              >
                <span className="relative flex justify-center text-[12.5px] text-subtle tabular">
                  {current && player.playing ? (
                    <AudioLines className="size-4 text-accent" />
                  ) : (
                    <>
                      <span className="group-hover:invisible">{track.trackNo ?? index + 1}</span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          player.play(queue, index)
                        }}
                        className="invisible absolute inset-0 flex items-center justify-center text-fg group-hover:visible focus-visible:visible"
                        aria-label={`Play ${track.title}`}
                      >
                        <Play className="size-3.5" fill="currentColor" />
                      </button>
                    </>
                  )}
                </span>
                <span className="min-w-0">
                  <span className={clsx('block truncate text-[13px] font-medium', current && 'text-accent')}>{track.title}</span>
                  {track.artist !== album.artist && <span className="block truncate text-[12.5px] text-muted">{track.artist}</span>}
                </span>
                <span className="hidden font-mono text-[11px] text-subtle sm:block">{trackQuality(track)}</span>
                <span className="text-[12.5px] text-subtle tabular">{duration(track.duration)}</span>
                <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">
                  <Menu
                    label={`More actions for ${track.title}`}
                    items={[{ label: 'Delete from library', icon: <Trash2 />, tone: 'danger', onSelect: () => void deleteTrack(track) }]}
                  />
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <MatchAlbumDialog
        open={matching}
        onClose={() => setMatching(false)}
        title="Match to album"
        description="Pick the album these files belong to. Seeker re-tags them, renames them and moves them to the right folder."
        candidatesKey={['library', 'candidates', id]}
        loadCandidates={() => api.get<ImportCandidate[]>(`/library/albums/${id}/candidates`)}
        onChoose={onMatch}
        initialQuery={`${album.artist} ${album.title}`}
      />
    </div>
  )
}
