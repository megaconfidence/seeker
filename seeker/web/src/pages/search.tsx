import { useMutation, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { CornerDownLeft, Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import type { CatalogAlbum, CatalogSearchResult, LibraryAlbum, MatchCandidate, MatchPreview } from '../../../shared/types.ts'
import { AlbumCard, AlbumGrid } from '../components/album-card.tsx'
import { Cover } from '../components/cover.tsx'
import { shortcutLabel } from '../components/layout.tsx'
import { candidateHref, candidateRequest, MatchRow } from '../components/match.tsx'
import { AlbumGridSkeleton, RowsSkeleton } from '../components/skeleton.tsx'
import { TrackList } from '../components/track-list.tsx'
import { Button, Section, Spinner, Tabs } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useStartDownload } from '../lib/downloads.ts'
import { coverUrl } from '../lib/player.tsx'

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

const EXAMPLES = ['Radiohead - In Rainbows', 'Daft Punk - Discovery', 'Nine Inch Nails - Ghosts I-IV', 'Kendrick Lamar - DAMN.']

function RecentlyAdded() {
  const { data } = useQuery({
    queryKey: ['library', 'albums', 'recent'],
    queryFn: () => api.get<LibraryAlbum[]>('/library/albums?sort=recent'),
  })
  if (!data?.length) return null
  return (
    <Section title="Recently added" actions={<Link to="/library" className="text-12.5 text-muted hover:text-fg">Library</Link>}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {data.slice(0, 6).map((album) => (
          <Link key={album.id} to={`/library/album/${album.id}`} className="group min-w-0">
            <Cover src={album.hasCover ? coverUrl(album.id) : null} className="w-full transition group-hover:brightness-[0.85]" />
            <div className="mt-2 truncate text-13 font-medium">{album.title}</div>
            <div className="truncate text-12.5 text-muted">{album.artist}</div>
          </Link>
        ))}
      </div>
    </Section>
  )
}

function Preview({
  preview,
  onClose,
  onDownload,
  selected,
  setSelected,
}: {
  preview: MatchPreview
  onClose: () => void
  onDownload: (candidate: MatchCandidate) => void
  selected: number
  setSelected: (index: number) => void
}) {
  const list = [...(preview.best ? [preview.best] : []), ...preview.alternatives]
  return (
    <div className="mb-8 animate-pop-in overflow-hidden rounded-xl border border-line-strong bg-raised shadow-lg shadow-black/5">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-12 font-medium text-muted">{preview.best ? 'Best match' : 'No confident match. Did you mean one of these?'}</span>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-subtle hover:bg-hover hover:text-fg" aria-label="Close preview">
          <X className="size-4" />
        </button>
      </div>
      <div role="listbox" className="p-1.5">
        {list.map((candidate, index) => (
          <div key={`${candidate.kind}-${candidate.mbid ?? candidate.id}`}>
            {index === 1 && preview.best && <div className="px-2.5 pt-3 pb-1 text-12 font-medium text-muted">Other matches</div>}
            <MatchRow
              candidate={candidate}
              selected={index === selected}
              large={index === 0 && !!preview.best}
              onSelect={() => setSelected(index)}
              onDownload={() => onDownload(candidate)}
            />
          </div>
        ))}
        {list.length === 0 && <p className="px-3 py-4 text-13 text-muted">Nothing in the catalog matches. Try the Soulseek file search.</p>}
      </div>
    </div>
  )
}

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [text, setText] = useState(params.get('q') ?? '')
  const query = useDebounced(text.trim(), 300)
  const input = useRef<HTMLInputElement>(null)
  const start = useStartDownload()
  const [selected, setSelected] = useState(0)
  const [showMb, setShowMb] = useState(false)

  useEffect(() => {
    const current = params.get('q') ?? ''
    if (query !== current) setParams(query ? { q: query } : {}, { replace: true })
    setShowMb(false)
  }, [query, params, setParams])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) {
        event.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = useQuery({
    queryKey: ['catalog', 'search', query],
    queryFn: () => api.get<CatalogSearchResult>(`/catalog/search?q=${encodeURIComponent(query)}`),
    enabled: query.length > 1,
    placeholderData: (previous) => previous,
  })

  const preview = useMutation({
    mutationFn: (q: string) => api.get<MatchPreview>(`/catalog/preview?q=${encodeURIComponent(q)}`),
    onSuccess: () => setSelected(0),
  })
  const previewList = preview.data ? [...(preview.data.best ? [preview.data.best] : []), ...preview.data.alternatives] : []

  const data = query.length > 1 ? results.data : undefined
  const albums = useMemo(() => data?.albums.slice(0, 12) ?? [], [data])
  const missingYears = albums.filter((album) => album.year === null).map((album) => album.id)
  const years = useQuery({
    queryKey: ['catalog', 'years', missingYears.join(',')],
    queryFn: () => api.get<Record<number, number | null>>(`/catalog/years?ids=${missingYears.join(',')}`),
    enabled: missingYears.length > 0,
    staleTime: Infinity,
  })
  const withYears: CatalogAlbum[] = albums.map((album) => (album.year === null && years.data?.[album.id] ? { ...album, year: years.data[album.id]! } : album))

  const mb = useQuery({
    queryKey: ['catalog', 'mb', query],
    queryFn: () => api.get<CatalogAlbum[]>(`/catalog/mb/search?q=${encodeURIComponent(query)}`),
    enabled: showMb && query.length > 1,
  })

  const empty = data && !data.artists.length && !data.albums.length && !data.tracks.length

  const download = (candidate: MatchCandidate) => {
    if (candidate.owned === 'complete') {
      const href = candidateHref(candidate)
      if (href) navigate(href)
      return
    }
    start.mutate(candidateRequest(candidate))
    preview.reset()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!preview.data) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected(Math.min(previewList.length - 1, selected + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(Math.max(0, selected - 1))
    } else if (event.key === 'Escape') {
      preview.reset()
    }
  }

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const q = text.trim()
          if (!q) return
          const candidate = previewList[selected]
          if (preview.data && preview.variables === q && candidate) download(candidate)
          else preview.mutate(q)
        }}
        className="mb-6"
      >
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2 text-subtle" />
          <input
            ref={input}
            autoFocus
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              if (preview.data) preview.reset()
            }}
            onKeyDown={onKeyDown}
            placeholder="Search for an artist, album or song"
            className="h-12 w-full rounded-lg border border-line-strong bg-raised pr-12 pl-11 text-15 placeholder:text-subtle focus:border-fg/30 focus:outline-none"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search"
          />
          {text && (
            <button
              type="button"
              onClick={() => {
                setText('')
                preview.reset()
                input.current?.focus()
              }}
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg"
              aria-label="Clear"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Tabs
            value="catalog"
            onChange={(value) => value === 'soulseek' && navigate(`/soulseek${text.trim() ? `?q=${encodeURIComponent(text.trim())}` : ''}`)}
            options={[
              { value: 'catalog', label: 'Catalog' },
              { value: 'soulseek', label: 'Soulseek files' },
            ]}
          />
          <button
            type="submit"
            disabled={!text.trim() || preview.isPending}
            className="inline-flex items-center gap-2 text-12.5 text-muted transition hover:text-fg disabled:opacity-40"
          >
            {preview.isPending ? (
              <Spinner className="size-3.5" />
            ) : (
              <kbd className="inline-flex h-5 items-center rounded border border-line-strong px-1.5 font-sans text-11">
                <CornerDownLeft className="size-3" />
              </kbd>
            )}
            {preview.data ? 'Download the highlighted match' : 'Find the best match'}
          </button>
        </div>
      </form>

      {preview.isError && <p className="mb-6 text-13 text-bad">{(preview.error as Error).message}</p>}
      {preview.data && (
        <Preview preview={preview.data} onClose={() => preview.reset()} onDownload={download} selected={selected} setSelected={setSelected} />
      )}

      {query.length <= 1 && (
        <>
          <RecentlyAdded />
          <div className="rounded-xl border border-line px-6 py-8">
            <p className="text-15 font-medium">Type what you want to hear.</p>
            <p className="mt-1 max-w-lg text-13 text-muted">
              Search the catalog and download albums or songs from Soulseek. Seeker picks the best copy it can find, checks it, tags it and
              files it in your library. Press Enter to see the best match, and Enter again to get it. Press{' '}
              <kbd className="rounded border border-line-strong px-1 font-sans text-11">{shortcutLabel}</kbd> anywhere for the quick bar.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setText(example)
                    input.current?.focus()
                  }}
                  className="h-7 rounded-full border border-line-strong px-3 text-12.5 text-muted hover:bg-hover hover:text-fg"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {query.length > 1 && results.isPending && (
        <>
          <Section title="Albums">
            <AlbumGridSkeleton count={6} />
          </Section>
          <Section title="Songs">
            <RowsSkeleton count={5} />
          </Section>
        </>
      )}
      {results.isError && query.length > 1 && <p className="text-13 text-bad">{(results.error as Error).message}</p>}
      {empty && (
        <div className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
          <p className="font-medium">No results for “{query}”</p>
          <p className="mt-1 text-13 text-muted">Check the spelling, or look further afield.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowMb(true)}>
              Search MusicBrainz
            </Button>
            <Link to={`/soulseek?q=${encodeURIComponent(query)}`}>
              <Button size="sm" variant="ghost">
                Search Soulseek files
              </Button>
            </Link>
          </div>
        </div>
      )}

      {data && !empty && (
        <div className={clsx('animate-content-in transition-opacity', results.isFetching && 'opacity-70')}>
          {data.artists.length > 0 && (
            <Section title="Artists">
              <div className="scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                {data.artists.map((artist) => (
                  <Link key={artist.id} to={`/artist/${artist.id}`} className="group w-28 shrink-0 rounded-lg p-2 text-center hover:bg-hover">
                    <Cover src={artist.picture} rounded="full" kind="artist" className="mx-auto w-24" />
                    <div className="mt-2 truncate text-13 font-medium">{artist.name}</div>
                    {artist.watched && <div className="text-11.5 text-muted">Following</div>}
                  </Link>
                ))}
              </div>
            </Section>
          )}
          {withYears.length > 0 && (
            <Section title="Albums">
              <AlbumGrid>
                {withYears.map((album) => (
                  <AlbumCard key={album.id} album={album} />
                ))}
              </AlbumGrid>
            </Section>
          )}
          {data.tracks.length > 0 && (
            <Section title="Songs">
              <TrackList tracks={data.tracks.slice(0, 10)} variant="list" />
            </Section>
          )}
        </div>
      )}

      {(data || empty) && query.length > 1 && (
        <Section
          title="MusicBrainz"
          actions={!showMb && <span className="text-12.5 text-muted">For albums the catalog doesn’t have</span>}
        >
          {!showMb ? (
            <Button size="sm" variant="secondary" onClick={() => setShowMb(true)}>
              Search MusicBrainz for “{query}”
            </Button>
          ) : mb.isPending ? (
            <AlbumGridSkeleton count={6} />
          ) : mb.data?.length ? (
            <AlbumGrid>
              {mb.data.map((album) => (
                <AlbumCard key={album.mbid} album={album} />
              ))}
            </AlbumGrid>
          ) : (
            <p className="text-13 text-muted">MusicBrainz has nothing for “{query}” either.</p>
          )}
        </Section>
      )}
    </div>
  )
}
