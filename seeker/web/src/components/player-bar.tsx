import clsx from 'clsx'
import {
  ChevronDown,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { duration } from '../lib/format.ts'
import { largeCover, usePlayer } from '../lib/player.tsx'
import { usePresence } from '../lib/presence.ts'
import { Cover } from './cover.tsx'
import { MiniProgress, Scrubber } from './scrubber.tsx'

function ModeButtons() {
  const { shuffle, repeat, toggleShuffle, cycleRepeat } = usePlayer()
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat
  return (
    <>
      <button
        type="button"
        onClick={toggleShuffle}
        className={clsx('rounded-md p-2 transition-colors', shuffle ? 'text-accent' : 'text-muted hover:text-fg')}
        aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}
        aria-pressed={shuffle}
        title="Shuffle"
      >
        <Shuffle className="size-4" />
      </button>
      <button
        type="button"
        onClick={cycleRepeat}
        className={clsx('rounded-md p-2 transition-colors', repeat !== 'off' ? 'text-accent' : 'text-muted hover:text-fg')}
        aria-label={`Repeat ${repeat}`}
        title={repeat === 'off' ? 'Repeat' : repeat === 'all' ? 'Repeating the queue' : 'Repeating this song'}
      >
        <RepeatIcon className="size-4" />
      </button>
    </>
  )
}

function Transport({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const { playing, toggle, next, previous } = usePlayer()
  const big = size === 'lg'
  return (
    <div className={clsx('flex items-center', big ? 'gap-6' : 'gap-1')}>
      <button type="button" onClick={previous} className="rounded-md p-2 text-muted hover:text-fg" aria-label="Previous">
        <SkipBack className={big ? 'size-6' : 'size-4'} fill="currentColor" />
      </button>
      <button
        type="button"
        onClick={toggle}
        className={clsx(
          'flex items-center justify-center rounded-full bg-fg text-inverse transition-transform hover:scale-105',
          big ? 'size-16' : 'size-8',
        )}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <Pause className={big ? 'size-7' : 'size-4'} fill="currentColor" />
        ) : (
          <Play className={clsx(big ? 'ml-1 size-7' : 'ml-0.5 size-4')} fill="currentColor" />
        )}
      </button>
      <button type="button" onClick={next} className="rounded-md p-2 text-muted hover:text-fg" aria-label="Next">
        <SkipForward className={big ? 'size-6' : 'size-4'} fill="currentColor" />
      </button>
    </div>
  )
}

function QueueList({ onPick }: { onPick?: () => void }) {
  const { queue, index, jump } = usePlayer()
  return (
    <>
      {queue.map((track, position) => (
        <button
          key={`${track.key}-${position}`}
          type="button"
          onClick={() => {
            jump(position)
            onPick?.()
          }}
          className={clsx(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover',
            position === index && 'bg-hover',
          )}
        >
          <span className={clsx('w-5 text-right text-[11px] tabular', position === index ? 'text-fg' : 'text-subtle')}>{position + 1}</span>
          <span className="min-w-0 flex-1">
            <span className={clsx('block truncate', position === index && 'font-medium')}>{track.title}</span>
            <span className="block truncate text-[12px] text-muted">{track.artist}</span>
          </span>
          <span className="text-[11px] text-subtle tabular">{duration(track.duration)}</span>
        </button>
      ))}
    </>
  )
}

function QueuePopover({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])
  return (
    <div
      ref={ref}
      className="scrollbar-thin absolute right-0 bottom-12 max-h-96 w-80 origin-bottom-right animate-pop-in overflow-y-auto rounded-lg border border-line-strong bg-raised p-1.5 shadow-xl shadow-black/30"
    >
      <div className="px-2 py-1.5 text-[12px] font-medium text-muted">Queue</div>
      <QueueList />
    </div>
  )
}

function PreviewBadge() {
  return <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-accent uppercase">Preview</span>
}

function MobileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { current } = usePlayer()
  const [showQueue, setShowQueue] = useState(false)
  const { mounted, closing } = usePresence(open, 200)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])
  if (!current || !mounted) return null
  return createPortal(
    <div
      className={clsx(
        'fixed inset-0 z-50 flex flex-col bg-bg px-6 pt-[max(env(safe-area-inset-top),1rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)]',
        closing ? 'animate-sheet-out' : 'animate-sheet-in',
      )}
    >
      <div className="flex items-center justify-between">
        <button type="button" onClick={onClose} className="-ml-2 rounded-md p-2 text-muted hover:text-fg" aria-label="Close player">
          <ChevronDown className="size-6" />
        </button>
        <span className="text-[12px] font-medium text-muted">{showQueue ? 'Queue' : current.preview ? 'Preview' : 'Now playing'}</span>
        <button
          type="button"
          onClick={() => setShowQueue((value) => !value)}
          className={clsx('-mr-2 rounded-md p-2', showQueue ? 'text-fg' : 'text-muted')}
          aria-label="Queue"
        >
          <ListMusic className="size-5" />
        </button>
      </div>
      {showQueue ? (
        <div className="scrollbar-thin mt-4 min-h-0 flex-1 overflow-y-auto">
          <QueueList onPick={() => setShowQueue(false)} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-8">
          <Cover src={largeCover(current.cover)} className="mx-auto w-full max-w-[340px] shadow-2xl shadow-black/30" />
          <div>
            <div className="truncate text-[20px] font-semibold tracking-tight">{current.title}</div>
            <div className="truncate text-[15px] text-muted">{current.artist}</div>
          </div>
          <Scrubber large />
          <div className="flex items-center justify-between">
            <ModeButtons />
            <Transport size="lg" />
            <span className="w-[72px]" />
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}

export function PlayerBar() {
  const { current, playing, toggle, volume, setVolume } = usePlayer()
  const [showQueue, setShowQueue] = useState(false)
  const [sheet, setSheet] = useState(false)
  const closeSheet = useCallback(() => setSheet(false), [])
  const [lastVolume, setLastVolume] = useState(volume || 0.9)
  if (!current) return null
  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  const info = (
    <>
      <Cover src={current.cover} className="size-11" rounded="sm" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{current.title}</span>
          {current.preview && <PreviewBadge />}
        </div>
        <div className="truncate text-[12px] text-muted">{current.artist}</div>
      </div>
    </>
  )

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 animate-bar-in border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:left-56">
      <MiniProgress />
      <div className="mx-auto flex h-[72px] max-w-[1400px] items-center gap-4 px-3 md:px-6">
        <button type="button" onClick={() => setSheet(true)} className="flex min-w-0 flex-1 items-center gap-3 text-left md:hidden">
          {info}
        </button>
        {current.href ? (
          <Link to={current.href} className="hidden min-w-0 items-center gap-3 md:flex md:w-72">
            {info}
          </Link>
        ) : (
          <div className="hidden min-w-0 items-center gap-3 md:flex md:w-72">{info}</div>
        )}

        <div className="hidden flex-1 flex-col items-center gap-1 md:flex">
          <div className="flex items-center gap-2">
            <ModeButtons />
            <Transport />
            <span className="w-[72px]" />
          </div>
          <div className="w-full max-w-xl">
            <Scrubber />
          </div>
        </div>

        <div className="flex items-center gap-1 md:w-72 md:justify-end">
          <button
            type="button"
            onClick={toggle}
            className="flex size-9 items-center justify-center rounded-full bg-fg text-inverse md:hidden"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="ml-0.5 size-4" fill="currentColor" />}
          </button>
          <div className="relative hidden md:block">
            <button
              type="button"
              onClick={() => setShowQueue((value) => !value)}
              className={clsx('rounded-md p-2 hover:text-fg', showQueue ? 'text-fg' : 'text-muted')}
              aria-label="Queue"
              title="Queue"
            >
              <ListMusic className="size-4" />
            </button>
            {showQueue && <QueuePopover onClose={() => setShowQueue(false)} />}
          </div>
          <button
            type="button"
            onClick={() => {
              if (volume > 0) {
                setLastVolume(volume)
                setVolume(0)
              } else setVolume(lastVolume || 0.9)
            }}
            className="hidden rounded-md p-2 text-muted hover:text-fg md:block"
            aria-label={volume === 0 ? 'Unmute' : 'Mute'}
            title="Mute (M)"
          >
            <VolumeIcon className="size-4" />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
            className="hidden h-1 w-24 cursor-pointer md:block"
            aria-label="Volume"
          />
        </div>
      </div>
      <MobileSheet open={sheet} onClose={closeSheet} />
    </div>
  )
}
