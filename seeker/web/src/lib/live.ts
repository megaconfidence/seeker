import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { AppStatus, Job, ServerEvent } from '../../../shared/types.ts'
import { ACTIVE_STATUSES } from '../../../shared/types.ts'
import { api } from './api.ts'

let libraryTimer: ReturnType<typeof setTimeout> | undefined

function refreshLibraryViews(client: QueryClient) {
  clearTimeout(libraryTimer)
  libraryTimer = setTimeout(() => {
    void client.invalidateQueries({ queryKey: ['library'] })
    void client.invalidateQueries({ queryKey: ['catalog'] })
  }, 800)
}

function applyJob(client: QueryClient, job: Job) {
  let previous: Job | undefined
  client.setQueryData<Job[]>(['jobs'], (jobs) => {
    if (!jobs) return jobs
    previous = jobs.find((item) => item.id === job.id)
    return previous ? jobs.map((item) => (item.id === job.id ? job : item)) : [job, ...jobs]
  })
  client.setQueryData(['job', job.id], (detail: object | undefined) => (detail ? { ...detail, ...job } : detail))
  if (previous?.status !== job.status) {
    void client.invalidateQueries({ queryKey: ['job', job.id] })
    if (job.status === 'completed') refreshLibraryViews(client)
  }
}

export function useServerEvents(enabled: boolean) {
  const client = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const source = new EventSource('/api/events')
    source.onopen = () => {
      void client.invalidateQueries({ queryKey: ['jobs'] })
      void client.invalidateQueries({ queryKey: ['status'] })
    }
    source.onmessage = (message) => {
      let event: ServerEvent
      try {
        event = JSON.parse(message.data) as ServerEvent
      } catch {
        return
      }
      switch (event.type) {
        case 'job':
          applyJob(client, event.job)
          break
        case 'job-removed':
          client.setQueryData<Job[]>(['jobs'], (jobs) => jobs?.filter((job) => job.id !== event.id))
          break
        case 'status':
          client.setQueryData(['status'], event.status)
          break
        case 'library':
          client.setQueryData<AppStatus>(['status'], (status) =>
            status
              ? {
                  ...status,
                  library: { albums: event.albums, tracks: event.tracks, scanning: event.scanning, problem: event.problem, progress: event.progress },
                }
              : status,
          )
          if (!event.scanning) refreshLibraryViews(client)
          break
        case 'watchlist':
          void client.invalidateQueries({ queryKey: ['watchlist'] })
          break
      }
    }
    return () => source.close()
  }, [enabled, client])
}

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: () => api.get<AppStatus>('/status'), refetchInterval: 60_000 })
}

export function useJobs() {
  return useQuery({ queryKey: ['jobs'], queryFn: () => api.get<Job[]>('/jobs'), staleTime: 30_000 })
}

export function isActive(job: Pick<Job, 'status'> | null | undefined): boolean {
  return !!job && ACTIVE_STATUSES.includes(job.status)
}

// The newest job for an album or track, kept live by server events.
export function useJobFor(target: { albumId?: number | null; trackId?: number | null }): Job | null {
  const { data: jobs } = useJobs()
  if (!jobs) return null
  return (
    jobs.find((job) =>
      target.trackId ? job.deezerTrackId === target.trackId : target.albumId ? job.deezerAlbumId === target.albumId && job.kind === 'album' : false,
    ) ?? null
  )
}
