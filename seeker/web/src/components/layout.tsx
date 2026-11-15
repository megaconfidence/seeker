import clsx from 'clsx'
import { ArrowDownToLine, Hourglass, Library, Menu, Radar, Search, Settings2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { NavLink, useLocation, useNavigationType } from 'react-router'
import { useJobs, useStatus } from '../lib/live.ts'
import { usePlayer } from '../lib/player.tsx'
import { usePresence } from '../lib/presence.ts'
import { CommandPalette } from './command-palette.tsx'
import { PlayerBar } from './player-bar.tsx'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
export const shortcutLabel = isMac ? '⌘K' : 'Ctrl K'

function useCounts() {
  const { data: jobs } = useJobs()
  const active = jobs?.filter((job) => ['queued', 'searching', 'downloading', 'processing'].includes(job.status)).length ?? 0
  const wanted = jobs?.filter((job) => job.status === 'wanted' || job.status === 'failed').length ?? 0
  return { active, wanted }
}

function NavItem({ to, icon, label, count }: { to: string; icon: ReactNode; label: string; count?: number }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        clsx(
          'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-13 font-medium transition-colors',
          isActive ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        )
      }
    >
      <span className="[&>svg]:size-4">{icon}</span>
      <span className="flex-1">{label}</span>
      {!!count && <span className="text-11.5 text-subtle tabular">{count}</span>}
    </NavLink>
  )
}

function ConnectionStatus() {
  const { data: status } = useStatus()
  const slskd = status?.slskd
  const tone = !slskd ? 'idle' : slskd.loggedIn ? 'ok' : slskd.reachable ? 'warn' : 'bad'
  const text = !slskd
    ? 'Checking slskd…'
    : slskd.loggedIn
      ? slskd.username ?? 'Connected'
      : slskd.reachable
        ? 'Not logged in to Soulseek'
        : 'slskd unreachable'
  return (
    <div className="flex items-center gap-2 px-2.5 text-12 text-muted" title={slskd?.error ?? slskd?.state ?? ''}>
      <span
        className={clsx(
          'size-1.5 shrink-0 rounded-full',
          tone === 'ok' && 'bg-ok',
          tone === 'warn' && 'bg-warn',
          tone === 'bad' && 'bg-bad',
          tone === 'idle' && 'bg-subtle',
        )}
      />
      <span className="truncate">{text}</span>
    </div>
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 64 64" className="size-5" aria-hidden>
      <circle cx="29" cy="29" r="15" fill="none" stroke="currentColor" strokeWidth="6" />
      <circle cx="29" cy="29" r="4" fill="currentColor" />
      <path d="M40 40l11 11" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
    </svg>
  )
}

function Sidebar({ onNavigate, onQuickSearch }: { onNavigate?: () => void; onQuickSearch: () => void }) {
  const { active, wanted } = useCounts()
  return (
    <nav className="flex h-full flex-col gap-5 px-3 py-4" onClick={onNavigate}>
      <div className="flex items-center gap-2 px-2.5 pt-1">
        <Logo />
        <span className="text-15 font-semibold tracking-tight">Seeker</span>
      </div>
      <button
        type="button"
        onClick={onQuickSearch}
        className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-raised px-2.5 text-left text-12.5 text-subtle transition-colors hover:border-fg/20 hover:text-muted"
      >
        <Search className="size-3.5" />
        <span className="flex-1">Quick get</span>
        <kbd className="font-sans text-11 text-subtle">{shortcutLabel}</kbd>
      </button>
      <div className="flex flex-col gap-0.5">
        <NavItem to="/" icon={<Search />} label="Search" />
        <NavItem to="/library" icon={<Library />} label="Library" />
        <NavItem to="/downloads" icon={<ArrowDownToLine />} label="Downloads" count={active} />
        <NavItem to="/wishlist" icon={<Hourglass />} label="Wishlist" count={wanted} />
        <NavItem to="/watchlist" icon={<Radar />} label="Watchlist" />
      </div>
      <div className="mt-auto flex flex-col gap-3">
        <NavItem to="/settings" icon={<Settings2 />} label="Settings" />
        <ConnectionStatus />
      </div>
    </nav>
  )
}

// New pages start at the top; going back returns to where you were.
function useScrollMemory(main: RefObject<HTMLElement | null>) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const positions = useRef(new Map<string, number>())
  const key = useRef(location.key)
  const pathname = useRef(location.pathname)

  useEffect(() => {
    const element = main.current
    if (!element) return
    const onScroll = () => positions.current.set(key.current, element.scrollTop)
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [main])

  useLayoutEffect(() => {
    const element = main.current
    const samePage = pathname.current === location.pathname
    key.current = location.key
    pathname.current = location.pathname
    if (!element || samePage) return
    element.scrollTop = navigationType === 'POP' ? (positions.current.get(location.key) ?? 0) : 0
  }, [location.key, location.pathname, navigationType, main])
}

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  const location = useLocation()
  const { current } = usePlayer()
  const main = useRef<HTMLElement>(null)
  const drawer = usePresence(open, 180)
  useScrollMemory(main)

  useEffect(() => setOpen(false), [location.pathname])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 border-r border-line bg-panel md:block">
        <Sidebar onQuickSearch={() => setPalette(true)} />
      </aside>

      {drawer.mounted && (
        <div className={clsx('fixed inset-0 z-40 md:hidden', drawer.closing && 'pointer-events-none')}>
          <div className={clsx('absolute inset-0 bg-black/50', drawer.closing ? 'animate-fade-out' : 'animate-fade-in')} onClick={() => setOpen(false)} />
          <aside
            className={clsx(
              'absolute inset-y-0 left-0 w-64 border-r border-line bg-panel shadow-2xl shadow-black/30',
              drawer.closing ? 'animate-drawer-out' : 'animate-drawer-in',
            )}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute top-4 right-3 rounded-md p-1.5 text-muted hover:bg-hover"
              aria-label="Close menu"
            >
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} onQuickSearch={() => setPalette(true)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-line px-3 md:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
          <span className="flex flex-1 items-center gap-2 text-15 font-semibold tracking-tight">
            <Logo />
            Seeker
          </span>
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
            aria-label="Quick get"
          >
            <Search className="size-5" />
          </button>
        </header>
        <main ref={main} className={clsx('scrollbar-thin min-h-0 flex-1 overflow-y-auto', current && 'pb-20')}>
          {/* Keyed by page, so every navigation eases the new page in. */}
          <div key={location.pathname} className="mx-auto w-full max-w-295 animate-page-in px-4 py-6 md:px-8 md:py-8">
            {children}
          </div>
        </main>
        <PlayerBar />
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  )
}
