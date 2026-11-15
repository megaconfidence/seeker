import { useMutation, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronRight, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import type { CatalogAlbumPage, SlskFolder, SlskSearch } from '../../../shared/types.ts'
import { Cover } from '../components/cover.tsx'
import { Badge, Button, Empty, PageHeader, Spinner, Tabs, Toggle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useStartDownload } from '../lib/downloads.ts'
import { bytes, duration, speed } from '../lib/format.ts'

type FormatFilter = 'all' | 'lossless' | 'lossy'

function isLossless(ext: string) {
  return ['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv'].includes(ext)
}

function Peer({ folder }: { folder: SlskFolder }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-12 text-muted" title={folder.freeSlot ? 'Free upload slot' : `${folder.queue} in queue`}>
      <span className={clsx('size-1.5 rounded-full', folder.freeSlot ? 'bg-ok' : 'bg-warn')} />
      <span className="max-w-32 truncate">{folder.username}</span>
      {speed(folder.speed) && <span className="text-subtle">· {speed(folder.speed)}</span>}
      {!folder.freeSlot && folder.queue > 0 && <span className="text-subtle">· queue {folder.queue}</span>}
    </span>
  )
}

function FolderRow({ folder, albumId }: { folder: SlskFolder; albumId: number | null }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const start = useStartDownload()
  const parts = folder.folder.split(/[\\/]+/).filter((part) => part && !part.startsWith('@@'))
  const name = parts[parts.length - 1] ?? folder.folder
  const parent = parts.slice(0, -1).join(' / ')

  const download = (files: SlskFolder['files']) =>
    start.mutate({
      type: 'files',
      username: folder.username,
      files: files.map((file) => ({ filename: file.filename, size: file.size })),
      albumId,
    })

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => event.key === 'Enter' && setOpen((value) => !value)}
        className="flex cursor-pointer flex-col gap-2 px-4 py-3 hover:bg-hover md:flex-row md:items-center md:gap-4"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ChevronRight className={clsx('size-4 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
          <div className="min-w-0">
            <div className="truncate text-13 font-medium" title={folder.folder}>
              {name}
            </div>
            <div className="truncate text-12 text-subtle">{parent || '—'}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-6 md:pl-0">
          {folder.matched !== null && (
            <Badge tone={folder.matched === folder.expected ? 'ok' : folder.matched ? 'warn' : 'default'}>
              {folder.matched}/{folder.expected} tracks
            </Badge>
          )}
          <Badge tone={folder.acceptable ? 'default' : 'bad'} className="font-mono text-11!">
            {folder.quality}
          </Badge>
          <span className="text-12 text-muted tabular">
            {folder.files.length} files · {bytes(folder.size)}
          </span>
          <Peer folder={folder} />
          <Button
            size="sm"
            variant="secondary"
            loading={start.isPending}
            onClick={(event) => {
              event.stopPropagation()
              download(folder.files)
            }}
          >
            Download
          </Button>
        </div>
      </div>
      {open && (
        <div className="border-t border-line bg-panel/50">
          {folder.files.map((file) => {
            const checked = selected.has(file.filename)
            return (
              <label
                key={file.filename}
                className="grid cursor-pointer grid-cols-[1.25rem_1fr_auto] items-center gap-3 px-4 py-2 text-12.5 hover:bg-hover md:grid-cols-[1.25rem_1fr_5.625rem_4.375rem_3.75rem]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(file.filename)) next.delete(file.filename)
                      else next.add(file.filename)
                      return next
                    })
                  }
                  className="accent-current"
                />
                <span className={clsx('truncate', file.matchedTrack !== null && 'text-fg', file.matchedTrack === null && folder.matched !== null && 'text-muted')}>
                  {file.name}
                </span>
                <span className="hidden font-mono text-11 text-muted md:block">
                  {file.ext.toUpperCase()}
                  {file.bitDepth && file.sampleRate
                    ? ` ${file.bitDepth}/${(file.sampleRate / 1000).toString()}`
                    : file.bitrate
                      ? ` ${file.bitrate}`
                      : ''}
                </span>
                <span className="hidden text-right text-muted tabular md:block">{bytes(file.size)}</span>
                <span className="text-right text-muted tabular">{duration(file.length)}</span>
              </label>
            )
          })}
          {selected.size > 0 && (
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
              <span className="text-12.5 text-muted">{selected.size} selected</span>
              <Button
                size="sm"
                variant="primary"
                loading={start.isPending}
                onClick={() => download(folder.files.filter((file) => selected.has(file.filename)))}
              >
                Download selected
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function SoulseekPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const albumId = params.get('album') ? Number(params.get('album')) : null
  const [text, setText] = useState(params.get('q') ?? '')
  const [searchId, setSearchId] = useState<string | null>(null)
  const [format, setFormat] = useState<FormatFilter>('all')
  const [acceptableOnly, setAcceptableOnly] = useState(true)
  const started = useRef(false)

  const album = useQuery({
    queryKey: ['catalog', 'album', albumId],
    queryFn: () => api.get<CatalogAlbumPage>(`/catalog/album/${albumId}`),
    enabled: !!albumId,
  })

  const begin = useMutation({
    mutationFn: (query: string) => api.post<SlskSearch>('/soulseek/search', { query, albumId }),
    onSuccess: (search) => setSearchId(search.id),
  })

  const search = useQuery({
    queryKey: ['soulseek', searchId],
    queryFn: () => api.get<SlskSearch>(`/soulseek/search/${searchId}`),
    enabled: !!searchId,
    refetchInterval: (query) => (query.state.data?.complete ? false : 1000),
    staleTime: Infinity,
  })

  useEffect(() => {
    const initial = params.get('q')
    if (initial && !started.current) {
      started.current = true
      begin.mutate(initial)
    }
  }, [params, begin])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const query = text.trim()
    if (query.length < 2) return
    setParams({ q: query, ...(albumId ? { album: String(albumId) } : {}) }, { replace: true })
    begin.mutate(query)
  }

  const folders = useMemo(() => {
    const list = search.data?.folders ?? []
    return list.filter((folder) => {
      if (acceptableOnly && !folder.acceptable) return false
      if (format === 'lossless' && !folder.files.some((file) => isLossless(file.ext))) return false
      if (format === 'lossy' && folder.files.every((file) => isLossless(file.ext))) return false
      return true
    })
  }, [search.data, format, acceptableOnly])

  const running = begin.isPending || (search.data && !search.data.complete)

  return (
    <div>
      <PageHeader
        title="Soulseek files"
        subtitle="Search other users’ shares directly and pick the exact copy you want."
      />

      {albumId && album.data && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5">
          <Cover src={album.data.album.coverSmall} className="size-10" rounded="sm" />
          <div className="min-w-0 flex-1 text-13">
            <div className="truncate">
              Matching folders against <span className="font-medium">{album.data.album.title}</span> by {album.data.album.artist}
            </div>
            <div className="text-12 text-muted">Downloads will be tagged and filed under this album.</div>
          </div>
          <Link to="/soulseek" onClick={() => setParams(text ? { q: text } : {})} className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label="Stop matching">
            <X className="size-4" />
          </Link>
        </div>
      )}

      <form onSubmit={submit} className="mb-5 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Artist album, or artist song"
            className="h-9 w-full rounded-md border border-line-strong bg-raised pr-3 pl-9 text-13 placeholder:text-subtle focus:border-fg/30 focus:outline-none"
            autoFocus={!params.get('q')}
          />
        </div>
        <Button type="submit" variant="primary" loading={!!running} disabled={text.trim().length < 2}>
          Search
        </Button>
      </form>

      <div className="mb-6">
        <Tabs
          value="soulseek"
          onChange={(value) => value === 'catalog' && navigate(`/${text.trim() ? `?q=${encodeURIComponent(text.trim())}` : ''}`)}
          options={[
            { value: 'catalog', label: 'Catalog' },
            { value: 'soulseek', label: 'Soulseek files' },
          ]}
        />
      </div>

      {begin.isError && <p className="mb-4 text-13 text-bad">{(begin.error as Error).message}</p>}

      {!searchId && !begin.isPending && !begin.isError && (
        <div className="rounded-xl border border-line px-6 py-8">
          <p className="text-15 font-medium">Pick the exact copy you want.</p>
          <ul className="mt-2 max-w-xl list-disc space-y-1 pl-5 text-13 text-muted">
            <li>Use this when the catalog doesn’t have a release, or you want a particular rip, format or uploader.</li>
            <li>Results are grouped by folder, with the most complete, best-quality copies from fast users first.</li>
            <li>Open an album page and choose “Pick a copy on Soulseek” to have the files tagged and filed under that album.</li>
          </ul>
        </div>
      )}

      {running && (
        <div className="mb-5 flex items-center gap-2.5 rounded-lg border border-line px-4 py-3 text-13 text-muted">
          <Spinner />
          <span>
            Searching Soulseek
            {search.data?.responses ? ` · ${search.data.responses} users replied` : ''}. Results appear when the search finishes.
          </span>
        </div>
      )}

      {search.data?.complete && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-12.5 text-muted">
              {search.data.state.startsWith('Error')
                ? search.data.state
                : `${search.data.responses} users · ${folders.length} of ${search.data.folders.length} folders shown`}
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-12.5 text-muted">
                <Toggle checked={acceptableOnly} onChange={setAcceptableOnly} label="Only my quality" />
                Only my quality
              </label>
              <Tabs
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'lossless', label: 'Lossless' },
                  { value: 'lossy', label: 'Lossy' },
                ]}
              />
            </div>
          </div>
          {folders.length === 0 ? (
            <Empty title="No folders to show">
              {search.data.folders.length
                ? 'Try turning off the quality filter.'
                : 'Nobody answered with matching files. Try fewer words, or a different spelling. Some names are blocked by the Soulseek server.'}
            </Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {folders.map((folder) => (
                <FolderRow key={folder.key} folder={folder} albumId={albumId} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
