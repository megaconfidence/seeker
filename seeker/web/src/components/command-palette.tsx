import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDownToLine, FolderInput, Hourglass, Library, Radar, Search, Settings2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import type { MatchCandidate, MatchPreview } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useStartDownload } from '../lib/downloads.ts'
import { usePresence } from '../lib/presence.ts'
import { candidateHref, candidateRequest, MatchRow } from './match.tsx'
import { Spinner } from './ui.tsx'

const PAGES: { label: string; to: string; icon: ReactNode }[] = [
  { label: 'Search', to: '/', icon: <Search /> },
  { label: 'Library', to: '/library', icon: <Library /> },
  { label: 'Downloads', to: '/downloads', icon: <ArrowDownToLine /> },
  { label: 'Wishlist', to: '/wishlist', icon: <Hourglass /> },
  { label: 'Watchlist', to: '/watchlist', icon: <Radar /> },
  { label: 'Import music', to: '/import', icon: <FolderInput /> },
  { label: 'Settings', to: '/settings', icon: <Settings2 /> },
]

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('')
  const [selected, setSelected] = useState(0)
  const query = useDebounced(text.trim(), 250)
  const input = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const start = useStartDownload()
  const { mounted, closing } = usePresence(open, 140)

  useEffect(() => {
    if (open) {
      setText('')
      setSelected(0)
      setTimeout(() => input.current?.focus(), 0)
    }
  }, [open])

  const preview = useQuery({
    queryKey: ['catalog', 'preview', query],
    queryFn: () => api.get<MatchPreview>(`/catalog/preview?q=${encodeURIComponent(query)}`),
    enabled: open && query.length > 1,
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  })

  const candidates = useMemo<MatchCandidate[]>(() => {
    if (query.length <= 1 || !preview.data) return []
    return [...(preview.data.best ? [preview.data.best] : []), ...preview.data.alternatives]
  }, [query, preview.data])

  const pages = query.length <= 1 ? PAGES.filter((page) => page.label.toLowerCase().includes(text.trim().toLowerCase())) : []
  const count = candidates.length || pages.length

  useEffect(() => setSelected(0), [query])

  if (!mounted) return null

  const download = (candidate: MatchCandidate) => {
    if (candidate.owned === 'complete') {
      const href = candidateHref(candidate)
      if (href) navigate(href)
    } else {
      start.mutate(candidateRequest(candidate))
    }
    onClose()
  }

  const openPage = (candidate: MatchCandidate) => {
    const href = candidateHref(candidate)
    if (href) navigate(href)
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((value) => Math.min(count - 1, value + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((value) => Math.max(0, value - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const candidate = candidates[selected]
      if (candidate) {
        if (event.metaKey || event.ctrlKey) openPage(candidate)
        else download(candidate)
        return
      }
      const page = pages[selected]
      if (page) {
        navigate(page.to)
        onClose()
      } else if (text.trim()) {
        navigate(`/?q=${encodeURIComponent(text.trim())}`)
        onClose()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return createPortal(
    <div className={clsx('fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]', closing && 'pointer-events-none')}>
      <div className={clsx('absolute inset-0 bg-black/45 backdrop-blur-[2px]', closing ? 'animate-fade-out' : 'animate-fade-in')} onClick={onClose} />
      <div
        className={clsx(
          'relative w-full max-w-xl overflow-hidden rounded-xl border border-line-strong bg-raised shadow-2xl shadow-black/40',
          closing ? 'animate-pop-out' : 'animate-pop-in',
        )}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-subtle" />
          <input
            ref={input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Artist - album or song, or jump to a page"
            className="h-13 flex-1 bg-transparent text-15 placeholder:text-subtle focus:outline-none"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={count > 0}
          />
          {preview.isFetching && <Spinner className="size-4" />}
        </div>
        <div role="listbox" className="scrollbar-thin max-h-[52vh] overflow-y-auto p-1.5">
          {candidates.map((candidate, index) => (
            <MatchRow
              key={`${candidate.kind}-${candidate.mbid ?? candidate.id}`}
              candidate={candidate}
              selected={index === selected}
              onSelect={() => setSelected(index)}
              onDownload={() => download(candidate)}
            />
          ))}
          {pages.map((page, index) => (
            <button
              key={page.to}
              type="button"
              onMouseEnter={() => setSelected(index)}
              onClick={() => {
                navigate(page.to)
                onClose()
              }}
              className={clsx(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-13',
                index === selected ? 'bg-hover text-fg' : 'text-muted',
              )}
            >
              <span className="[&>svg]:size-4">{page.icon}</span>
              {page.label}
            </button>
          ))}
          {query.length > 1 && !preview.isFetching && candidates.length === 0 && (
            <p className="px-3 py-6 text-center text-13 text-muted">
              Nothing in the catalog. Press Enter to search, or try the Soulseek file search.
            </p>
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-11.5 text-subtle">
          <span>↵ {candidates.length ? 'Download' : 'Open'}</span>
          {candidates.length > 0 && <span>⌘↵ Open page</span>}
          <span>↑↓ Move</span>
          <span className="ml-auto">esc Close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
