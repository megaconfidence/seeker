import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CatalogTrack, LibraryTrack } from '../../../shared/types.ts'
import { coverAt } from './covers.ts'

export interface PlayerTrack {
  key: string
  title: string
  artist: string
  album: string
  duration: number
  src: string
  cover: string | null
  href: string | null
  preview?: boolean
}

export type Repeat = 'off' | 'all' | 'one'

// The playback position isn't in here on purpose: it changes many times a second, and putting it in
// context would re-render every component that uses the player. Read it from getAudio() instead.
interface PlayerContextValue {
  queue: PlayerTrack[]
  index: number
  current: PlayerTrack | null
  playing: boolean
  duration: number
  volume: number
  shuffle: boolean
  repeat: Repeat
  getAudio: () => HTMLAudioElement | null
  play: (tracks: PlayerTrack[], start?: number, options?: { shuffle?: boolean }) => void
  toggle: () => void
  next: () => void
  previous: () => void
  seek: (seconds: number) => void
  setVolume: (volume: number) => void
  jump: (index: number) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
}

const PlayerContext = createContext<PlayerContextValue | null>(null)

export function usePlayer() {
  const value = useContext(PlayerContext)
  if (!value) throw new Error('usePlayer must be used inside PlayerProvider')
  return value
}

export const coverUrl = (albumId: string) => `/api/library/albums/${albumId}/cover`

// Catalog thumbnails are small; ask Deezer and the Cover Art Archive for a bigger copy.
export const largeCover = (url: string | null) => coverAt(url, 1000)

export function fromLibrary(track: LibraryTrack): PlayerTrack {
  return {
    key: `lib:${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    src: `/api/library/tracks/${track.id}/stream`,
    cover: coverUrl(track.albumId),
    href: `/library/album/${track.albumId}`,
  }
}

export function fromPreview(track: CatalogTrack): PlayerTrack {
  return {
    key: `preview:${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: 30,
    src: `/api/catalog/track/${track.id}/preview`,
    cover: track.cover,
    href: track.albumId ? `/album/${track.albumId}` : null,
    preview: true,
  }
}

const STORAGE = 'seeker:player'

interface Saved {
  queue: PlayerTrack[]
  index: number
  time: number
  shuffle: boolean
  repeat: Repeat
}

function load(): Saved | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as Saved | null
    if (saved && Array.isArray(saved.queue)) return saved
  } catch {
    // ignore a corrupt entry
  }
  return null
}

function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  if (!audio.current && typeof Audio !== 'undefined') audio.current = new Audio()
  const saved = useRef(load())
  const [queue, setQueue] = useState<PlayerTrack[]>(saved.current?.queue.filter((track) => !track.preview) ?? [])
  const [index, setIndex] = useState(saved.current?.queue[saved.current.index]?.preview ? 0 : (saved.current?.index ?? 0))
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(() => Number(localStorage.getItem('seeker:volume') ?? '0.9'))
  const [shuffle, setShuffle] = useState(saved.current?.shuffle ?? false)
  const [repeat, setRepeat] = useState<Repeat>(saved.current?.repeat ?? 'off')
  const order = useRef<number[]>([])
  const current = queue[index] ?? null

  const getAudio = useCallback(() => audio.current, [])

  // On startup only, load the last session's track, paused, where it was left. (Doing this when a
  // track first becomes current would also catch the first Play press and cut it off.)
  const initial = useRef(current)
  useEffect(() => {
    const element = audio.current
    const track = initial.current
    if (!element || !track) return
    element.src = track.src
    element.preload = 'metadata'
    const position = saved.current?.time ?? 0
    if (position > 0) element.addEventListener('loadedmetadata', () => (element.currentTime = position), { once: true })
    setDuration(track.duration)
  }, [])

  useEffect(() => {
    const persist = () => {
      const position = audio.current?.currentTime ?? 0
      localStorage.setItem(STORAGE, JSON.stringify({ queue: queue.slice(0, 500), index, time: position, shuffle, repeat }))
    }
    persist()
    const timer = setInterval(persist, 5000)
    window.addEventListener('beforeunload', persist)
    return () => {
      clearInterval(timer)
      window.removeEventListener('beforeunload', persist)
    }
  }, [queue, index, shuffle, repeat])

  const loadTrack = useCallback((track: PlayerTrack | undefined, autoplay = true) => {
    const element = audio.current
    if (!element || !track) return
    element.src = track.src
    setDuration(track.duration || 0)
    if (autoplay) void element.play().catch(() => setPlaying(false))
  }, [])

  const reshuffle = useCallback((length: number, start: number) => {
    const rest = Array.from({ length }, (_, i) => i).filter((i) => i !== start)
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
    }
    order.current = [start, ...rest]
  }, [])

  const play = useCallback(
    (tracks: PlayerTrack[], start = 0, options: { shuffle?: boolean } = {}) => {
      const first = options.shuffle ? Math.floor(Math.random() * tracks.length) : start
      if (options.shuffle) setShuffle(true)
      setQueue(tracks)
      setIndex(first)
      reshuffle(tracks.length, first)
      loadTrack(tracks[first])
    },
    [loadTrack, reshuffle],
  )

  const jump = useCallback(
    (target: number) => {
      if (target < 0 || target >= queue.length) return
      setIndex(target)
      loadTrack(queue[target])
    },
    [queue, loadTrack],
  )

  const step = useCallback(
    (direction: 1 | -1, auto = false): number | null => {
      if (queue.length === 0) return null
      if (auto && repeat === 'one') return index
      if (shuffle) {
        if (order.current.length !== queue.length) reshuffle(queue.length, index)
        const position = order.current.indexOf(index)
        const nextPosition = position + direction
        if (nextPosition >= 0 && nextPosition < order.current.length) return order.current[nextPosition]!
        if (repeat === 'all') return order.current[(nextPosition + order.current.length) % order.current.length]!
        return null
      }
      const target = index + direction
      if (target >= 0 && target < queue.length) return target
      if (repeat === 'all') return (target + queue.length) % queue.length
      return null
    },
    [queue.length, index, shuffle, repeat, reshuffle],
  )

  const next = useCallback(
    (auto = false) => {
      const target = step(1, auto)
      if (target === null) {
        audio.current?.pause()
        setPlaying(false)
        return
      }
      if (target === index) {
        const element = audio.current
        if (element) {
          element.currentTime = 0
          void element.play().catch(() => {})
        }
        return
      }
      jump(target)
    },
    [step, index, jump],
  )

  const previous = useCallback(() => {
    const element = audio.current
    if (element && element.currentTime > 3) {
      element.currentTime = 0
      return
    }
    const target = step(-1)
    if (target !== null) jump(target)
  }, [step, jump])

  const toggle = useCallback(() => {
    const element = audio.current
    if (!element || !current) return
    if (element.paused) void element.play().catch(() => {})
    else element.pause()
  }, [current])

  const seek = useCallback((seconds: number) => {
    const element = audio.current
    if (!element || !Number.isFinite(seconds)) return
    const end = Number.isFinite(element.duration) ? element.duration : Infinity
    element.currentTime = Math.min(Math.max(0, seconds), Math.max(0, end - 0.25))
  }, [])

  const setVolume = useCallback((value: number) => {
    const clamped = Math.min(1, Math.max(0, value))
    setVolumeState(clamped)
    localStorage.setItem('seeker:volume', String(clamped))
  }, [])

  const toggleShuffle = useCallback(() => {
    setShuffle((value) => {
      if (!value) reshuffle(queue.length, index)
      return !value
    })
  }, [queue.length, index, reshuffle])

  const cycleRepeat = useCallback(() => setRepeat((value) => (value === 'off' ? 'all' : value === 'all' ? 'one' : 'off')), [])

  useEffect(() => {
    if (audio.current) audio.current.volume = volume
  }, [volume])

  const nextRef = useRef(next)
  nextRef.current = next

  useEffect(() => {
    const element = audio.current
    if (!element) return
    // Lock screens and headphones show a scrubber too; keep it in step.
    const syncSession = () => {
      if (!('mediaSession' in navigator) || !Number.isFinite(element.duration) || element.duration <= 0) return
      try {
        navigator.mediaSession.setPositionState({
          duration: element.duration,
          playbackRate: element.playbackRate || 1,
          position: Math.min(element.currentTime, element.duration),
        })
      } catch {
        // some browsers reject position state while loading
      }
    }
    const onMeta = () => {
      if (Number.isFinite(element.duration)) setDuration(element.duration)
      syncSession()
    }
    const onPlay = () => {
      setPlaying(true)
      syncSession()
    }
    const onPause = () => {
      setPlaying(false)
      syncSession()
    }
    const onEnded = () => nextRef.current(true)
    element.addEventListener('loadedmetadata', onMeta)
    element.addEventListener('play', onPlay)
    element.addEventListener('pause', onPause)
    element.addEventListener('seeked', syncSession)
    element.addEventListener('ended', onEnded)
    return () => {
      element.removeEventListener('loadedmetadata', onMeta)
      element.removeEventListener('play', onPlay)
      element.removeEventListener('pause', onPause)
      element.removeEventListener('seeked', syncSession)
      element.removeEventListener('ended', onEnded)
    }
  }, [])

  // Keyboard: space play/pause, ←/→ seek, shift+←/→ previous/next, M mute.
  const lastVolume = useRef(volume || 0.9)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!current || typing(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const element = audio.current
      if (event.key === ' ' || event.code === 'Space') {
        if ((event.target as HTMLElement | null)?.tagName === 'BUTTON') return
        event.preventDefault()
        toggle()
      } else if (event.key === 'ArrowRight' && element) {
        event.preventDefault()
        if (event.shiftKey) next()
        else seek(element.currentTime + 5)
      } else if (event.key === 'ArrowLeft' && element) {
        event.preventDefault()
        if (event.shiftKey) previous()
        else seek(element.currentTime - 5)
      } else if (event.key.toLowerCase() === 'm') {
        if (volume > 0) {
          lastVolume.current = volume
          setVolume(0)
        } else setVolume(lastVolume.current || 0.9)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, toggle, next, previous, seek, volume, setVolume])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album,
      artwork: current.cover ? [{ src: largeCover(current.cover)!, sizes: '1000x1000' }] : [],
    })
    navigator.mediaSession.setActionHandler('play', toggle)
    navigator.mediaSession.setActionHandler('pause', toggle)
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
    navigator.mediaSession.setActionHandler('previoustrack', previous)
    navigator.mediaSession.setActionHandler('seekto', (details) => details.seekTime !== undefined && seek(details.seekTime))
  }, [current, toggle, next, previous, seek])

  const value = useMemo(
    () => ({
      queue,
      index,
      current,
      playing,
      duration,
      volume,
      shuffle,
      repeat,
      getAudio,
      play,
      toggle,
      next: () => next(),
      previous,
      seek,
      setVolume,
      jump,
      toggleShuffle,
      cycleRepeat,
    }),
    [queue, index, current, playing, duration, volume, shuffle, repeat, getAudio, play, toggle, next, previous, seek, setVolume, jump, toggleShuffle, cycleRepeat],
  )

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}
