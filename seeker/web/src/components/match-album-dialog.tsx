import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { CatalogAlbum, CatalogSearchResult, ImportCandidate, ImportChoice } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { coverAt } from '../lib/covers.ts'
import { plural } from '../lib/format.ts'
import { Cover } from './cover.tsx'
import { Dialog } from './dialog.tsx'
import { Skeleton } from './skeleton.tsx'
import { Badge, Button } from './ui.tsx'

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function Row({
  cover,
  title,
  meta,
  badge,
  pending,
  disabled,
  onChoose,
  label,
}: {
  cover: string | null
  title: string
  meta: string
  badge?: ReactNode
  pending: boolean
  disabled: boolean
  onChoose: () => void
  label: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
      <Cover src={coverAt(cover, 250)} className="size-12" rounded="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{title}</div>
        <div className="truncate text-[12.5px] text-muted">{meta}</div>
        {badge && <div className="mt-1">{badge}</div>}
      </div>
      <Button size="sm" loading={pending} disabled={disabled} onClick={onChoose}>
        {label}
      </Button>
    </div>
  )
}

export function coverageBadge(candidate: ImportCandidate) {
  const all = candidate.matched === candidate.files
  return (
    <Badge tone={all ? 'ok' : candidate.matched === 0 ? 'bad' : 'warn'}>
      {all ? `All ${plural(candidate.files, 'file')} match` : `${candidate.matched} of ${plural(candidate.files, 'file')} match`}
      {candidate.trackCount !== candidate.files && ` · album has ${candidate.trackCount}`}
    </Badge>
  )
}

export function MatchAlbumDialog({
  open,
  onClose,
  title,
  description,
  candidatesKey,
  loadCandidates,
  onChoose,
  asIsLabel,
  chooseLabel = 'Use this',
  initialQuery = '',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  candidatesKey: unknown[]
  loadCandidates: () => Promise<ImportCandidate[]>
  onChoose: (choice: ImportChoice) => Promise<unknown>
  asIsLabel?: string
  chooseLabel?: string
  initialQuery?: string
}) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const query = useDebounced(text.trim(), 300)

  useEffect(() => {
    if (open) {
      setText('')
      setPending(null)
    }
  }, [open])

  const candidates = useQuery({ queryKey: candidatesKey, queryFn: loadCandidates, enabled: open, staleTime: 5 * 60_000, retry: false })
  const search = useQuery({
    queryKey: ['catalog', 'search', query],
    queryFn: () => api.get<CatalogSearchResult>(`/catalog/search?q=${encodeURIComponent(query)}`),
    enabled: open && query.length > 1,
  })

  const choose = async (key: string, choice: ImportChoice) => {
    setPending(key)
    try {
      await onChoose(choice)
      onClose()
    } finally {
      setPending(null)
    }
  }

  const searching = query.length > 1
  const albums: CatalogAlbum[] = search.data?.albums.slice(0, 12) ?? []

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      footer={
        asIsLabel ? (
          <Button variant="ghost" loading={pending === 'as-is'} disabled={!!pending} onClick={() => choose('as-is', { asIs: true })}>
            {asIsLabel}
          </Button>
        ) : undefined
      }
    >
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-subtle" />
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={initialQuery ? `Search the catalog, e.g. ${initialQuery}` : 'Search the catalog for the right album'}
          className="h-9 w-full rounded-md border border-line-strong bg-raised pr-3 pl-8 text-[13px] placeholder:text-subtle focus:border-fg/30 focus:outline-none"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {searching ? (
        <div className="flex flex-col">
          {search.isPending &&
            Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 px-2 py-2">
                <Skeleton className="size-12" />
                <div className="flex-1">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="mt-1.5 h-3 w-1/3" />
                </div>
              </div>
            ))}
          {search.data && albums.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-muted">No albums found for “{query}”.</p>}
          {albums.map((album) => (
            <Row
              key={album.id}
              cover={album.coverSmall ?? album.cover}
              title={album.title}
              meta={[album.artist, album.year, album.tracks ? plural(album.tracks, 'song') : null].filter(Boolean).join(' · ')}
              pending={pending === `dz:${album.id}`}
              disabled={!!pending}
              label={chooseLabel}
              onChoose={() => choose(`dz:${album.id}`, { albumId: album.id })}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="px-2 pb-1 text-[12px] font-medium text-muted">Suggested from the files’ tags</div>
          {candidates.isPending && (
            <>
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 px-2 py-2">
                  <Skeleton className="size-12" />
                  <div className="flex-1">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="mt-1.5 h-3 w-1/3" />
                  </div>
                </div>
              ))}
              <p className="px-2 pt-1 text-[12px] text-subtle">Comparing the files with catalog albums…</p>
            </>
          )}
          {candidates.isError && <p className="px-2 py-4 text-[13px] text-bad">{(candidates.error as Error).message}</p>}
          {candidates.data?.length === 0 && (
            <p className="px-2 py-6 text-center text-[13px] text-muted">No likely albums. Search the catalog above.</p>
          )}
          {candidates.data?.map((candidate) => {
            const key = `${candidate.source}:${candidate.mbid ?? candidate.id}`
            return (
              <Row
                key={key}
                cover={candidate.cover}
                title={candidate.title}
                meta={[candidate.artist, candidate.year, candidate.source === 'musicbrainz' ? 'MusicBrainz' : null].filter(Boolean).join(' · ')}
                badge={coverageBadge(candidate)}
                pending={pending === key}
                disabled={!!pending || candidate.matched === 0}
                label={chooseLabel}
                onChoose={() => choose(key, candidate.source === 'musicbrainz' && candidate.mbid ? { mbid: candidate.mbid } : { albumId: candidate.id })}
              />
            )
          })}
        </div>
      )}
    </Dialog>
  )
}
