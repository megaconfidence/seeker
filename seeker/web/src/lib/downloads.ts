import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import type { CatalogAlbum, Job } from '../../../shared/types.ts'
import { api, ApiError } from './api.ts'
import { useToast } from './toast.tsx'

export type JobRequest =
  | { type: 'album'; albumId: number; force?: boolean }
  | { type: 'mbAlbum'; mbid: string; force?: boolean }
  | { type: 'track'; trackId: number; force?: boolean }
  | { type: 'query'; query: string; kind?: 'auto' | 'album' | 'track'; force?: boolean }
  | { type: 'files'; username: string; files: { filename: string; size: number }[]; albumId?: number | null }

interface JobResponse {
  job: Job
  resolved?: { kind: 'album' | 'track'; title: string; artist: string }
}

export function jobLink(job: Pick<Job, 'deezerAlbumId' | 'mbReleaseId'>): string | null {
  if (job.deezerAlbumId) return `/album/${job.deezerAlbumId}`
  if (job.mbReleaseId) return `/album/mb/${job.mbReleaseId}`
  return null
}

export function albumHref(album: Pick<CatalogAlbum, 'id' | 'mbid' | 'source'>): string {
  return album.source === 'musicbrainz' && album.mbid ? `/album/mb/${album.mbid}` : `/album/${album.id}`
}

export function albumRequest(album: Pick<CatalogAlbum, 'id' | 'mbid' | 'source'>): JobRequest {
  return album.source === 'musicbrainz' && album.mbid ? { type: 'mbAlbum', mbid: album.mbid } : { type: 'album', albumId: album.id }
}

export function useStartDownload() {
  const client = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const mutation = useMutation({
    mutationFn: (request: JobRequest) => api.post<JobResponse>('/jobs', request),
    onSuccess: ({ job, resolved }) => {
      client.setQueryData<Job[]>(['jobs'], (jobs) => (jobs ? [job, ...jobs.filter((item) => item.id !== job.id)] : [job]))
      const what = resolved ? `${resolved.title} by ${resolved.artist}` : job.title
      if (job.status === 'completed') {
        toast(`${what} is already done`)
        return
      }
      toast(`Downloading ${what}`, {
        action: { label: 'View', onClick: () => navigate(`/downloads?job=${job.id}`) },
        secondary: {
          label: 'Undo',
          onClick: () => {
            void api.del(`/jobs/${job.id}`).finally(() => client.invalidateQueries({ queryKey: ['catalog'] }))
            client.setQueryData<Job[]>(['jobs'], (jobs) => jobs?.filter((item) => item.id !== job.id))
          },
        },
      })
    },
    onError: (error, request) => {
      if (error instanceof ApiError && error.status === 409 && request.type !== 'files') {
        toast(error.message, {
          action: { label: 'Download anyway', onClick: () => mutation.mutate({ ...request, force: true } as JobRequest) },
        })
      } else {
        toast(error.message, 'error')
      }
    },
  })
  return mutation
}

export function useJobAction() {
  const client = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'retry' | 'remove' }) =>
      action === 'remove' ? api.del(`/jobs/${id}`) : api.post(`/jobs/${id}/${action}`),
    onSuccess: (_, { id, action }) => {
      if (action === 'remove') client.setQueryData<Job[]>(['jobs'], (jobs) => jobs?.filter((job) => job.id !== id))
      void client.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (error) => toast(error.message, 'error'),
  })
}

export function jobPercent(job: Job): number {
  if (job.status === 'completed') return 100
  if (job.progress.size > 0 && job.progress.bytes > 0) return Math.min(100, (job.progress.bytes / job.progress.size) * 100)
  if (job.progress.files > 0) return (job.progress.done / job.progress.files) * 100
  return 0
}

// Seconds left at the current speed, for jobs that are actually moving.
export function jobEta(job: Job): number | null {
  if (job.status !== 'downloading' || job.progress.speed < 1024 || job.progress.size <= job.progress.bytes) return null
  return (job.progress.size - job.progress.bytes) / job.progress.speed
}
