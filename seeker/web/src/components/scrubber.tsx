import clsx from 'clsx'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { duration as formatDuration, elapsed } from '../lib/format.ts'
import { usePlayer } from '../lib/player.tsx'

// Paints the playback position straight into the DOM on every animation frame, so the bar glides
// instead of jumping a few times a second, and dragging never waits for React.
function usePositionPainter(paint: (position: number, total: number) => void, override: { current: number | null }) {
  const { getAudio, duration } = usePlayer()
  const paintRef = useRef(paint)
  paintRef.current = paint
  useEffect(() => {
    let frame = 0
    const tick = () => {
      const audio = getAudio()
      const total = duration || (audio && Number.isFinite(audio.duration) ? audio.duration : 0)
      paintRef.current(override.current ?? audio?.currentTime ?? 0, total)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [getAudio, duration, override])
}

export function Scrubber({ large = false }: { large?: boolean }) {
  const { seek, duration } = usePlayer()
  const bar = useRef<HTMLDivElement>(null)
  const fill = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  // While dragging, and briefly after letting go until the audio catches up, show this position.
  const held = useRef<number | null>(null)
  const settle = useRef<{ target: number; until: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [second, setSecond] = useState(0)
  const [hover, setHover] = useState<{ x: number; seconds: number } | null>(null)
  const lastRatio = useRef(-1)

  usePositionPainter((position, total) => {
    let shown = position
    if (held.current === null && settle.current) {
      const done = Math.abs(position - settle.current.target) < 0.35 || performance.now() > settle.current.until
      if (done) settle.current = null
      else shown = settle.current.target
    }
    const ratio = total > 0 ? Math.min(1, Math.max(0, shown / total)) : 0
    if (Math.abs(ratio - lastRatio.current) > 0.0002) {
      lastRatio.current = ratio
      if (fill.current) fill.current.style.transform = `scaleX(${ratio})`
      if (thumb.current) thumb.current.style.left = `${ratio * 100}%`
    }
    const whole = Math.floor(shown)
    setSecond((current) => (current === whole ? current : whole))
  }, held)

  const total = duration
  const secondsAt = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * total
  }

  const commit = (seconds: number) => {
    settle.current = { target: seconds, until: performance.now() + 1500 }
    seek(seconds)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!total || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    held.current = secondsAt(event.clientX)
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!total) return
    const seconds = secondsAt(event.clientX)
    if (held.current !== null) held.current = seconds
    if (event.pointerType === 'mouse') {
      const rect = bar.current!.getBoundingClientRect()
      setHover({ x: Math.min(rect.width, Math.max(0, event.clientX - rect.left)), seconds })
    }
  }
  const onPointerUp = () => {
    if (held.current === null) return
    commit(held.current)
    held.current = null
    setDragging(false)
  }
  const onPointerCancel = () => {
    held.current = null
    setDragging(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5, PageDown: -30, PageUp: 30 }
    let target: number | null = null
    if (event.key in steps) target = second + steps[event.key]!
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = total - 1
    if (target === null || !total) return
    event.preventDefault()
    event.stopPropagation()
    commit(Math.min(total, Math.max(0, target)))
  }

  const active = dragging || hover !== null
  const thick = large ? 'h-1.5' : active ? 'h-1.5' : 'h-1'

  return (
    <div className={clsx('flex w-full items-center gap-2 text-subtle tabular', large ? 'flex-wrap text-[12px]' : 'text-[11px]')}>
      {!large && <span className="w-9 text-right">{elapsed(second)}</span>}
      <div
        ref={bar}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={second}
        aria-valuetext={`${elapsed(second)} of ${formatDuration(total)}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        className={clsx(
          'group/scrub relative flex h-4 flex-1 cursor-pointer touch-none items-center rounded-full select-none focus-visible:outline-offset-4',
          large && 'basis-full',
        )}
      >
        <div className={clsx('relative w-full overflow-hidden rounded-full bg-line-strong transition-[height] duration-150', thick)}>
          <div ref={fill} className="absolute inset-0 origin-left rounded-full bg-fg will-change-transform" style={{ transform: 'scaleX(0)' }} />
        </div>
        <div
          ref={thumb}
          className={clsx(
            'pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg shadow-sm transition-[opacity,scale] duration-150',
            large || active ? 'scale-100 opacity-100' : 'scale-50 opacity-0 group-focus-visible/scrub:scale-100 group-focus-visible/scrub:opacity-100',
            dragging && 'scale-125',
          )}
          style={{ left: '0%' }}
        />
        {hover && !dragging && !large && (
          <div
            className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-fg px-1.5 py-0.5 text-[11px] font-medium text-inverse tabular shadow-sm"
            style={{ left: hover.x }}
          >
            {elapsed(hover.seconds)}
          </div>
        )}
      </div>
      {large ? (
        <div className="flex w-full justify-between">
          <span>{elapsed(second)}</span>
          <span>{formatDuration(total)}</span>
        </div>
      ) : (
        <span className="w-9">{formatDuration(total)}</span>
      )}
    </div>
  )
}

// A hairline of progress along the top of the phone mini player.
export function MiniProgress() {
  const fill = useRef<HTMLDivElement>(null)
  const none = useRef<number | null>(null)
  usePositionPainter((position, total) => {
    if (fill.current) fill.current.style.transform = `scaleX(${total > 0 ? Math.min(1, position / total) : 0})`
  }, none)
  return (
    <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-line md:hidden">
      <div ref={fill} className="h-full origin-left bg-fg/70 will-change-transform" style={{ transform: 'scaleX(0)' }} />
    </div>
  )
}
