import clsx from 'clsx'
import { ArrowDownToLine, Check, CornerDownLeft } from 'lucide-react'
import type { MatchCandidate } from '../../../shared/types.ts'
import { coverAt } from '../lib/covers.ts'
import type { JobRequest } from '../lib/downloads.ts'
import { duration, plural, recordTypeLabel } from '../lib/format.ts'
import { Cover } from './cover.tsx'
import { Badge } from './ui.tsx'

export function candidateRequest(candidate: MatchCandidate): JobRequest {
  if (candidate.kind === 'track') return { type: 'track', trackId: candidate.id }
  if (candidate.source === 'musicbrainz' && candidate.mbid) return { type: 'mbAlbum', mbid: candidate.mbid }
  return { type: 'album', albumId: candidate.id }
}

export function candidateHref(candidate: MatchCandidate): string | null {
  if (candidate.kind === 'album') return candidate.source === 'musicbrainz' ? `/album/mb/${candidate.mbid}` : `/album/${candidate.id}`
  return candidate.albumId ? `/album/${candidate.albumId}` : null
}

export function candidateMeta(candidate: MatchCandidate): string {
  const parts: string[] = [candidate.artist]
  if (candidate.kind === 'album') {
    parts.push(recordTypeLabel[candidate.recordType ?? 'album'] ?? 'Album')
    if (candidate.year) parts.push(String(candidate.year))
    if (candidate.tracks) parts.push(plural(candidate.tracks, 'song'))
  } else {
    parts.push('Song')
    if (candidate.album) parts.push(candidate.album)
    if (candidate.duration) parts.push(duration(candidate.duration))
  }
  return parts.join(' · ')
}

export function MatchRow({
  candidate,
  selected,
  onSelect,
  onDownload,
  large = false,
}: {
  candidate: MatchCandidate
  selected: boolean
  onSelect: () => void
  onDownload: () => void
  large?: boolean
}) {
  const owned = candidate.owned === 'complete'
  return (
    <div
      role="option"
      aria-selected={selected}
      onMouseEnter={onSelect}
      onClick={onDownload}
      className={clsx(
        'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 transition-colors',
        large ? 'py-2.5' : 'py-1.5',
        selected ? 'bg-hover' : 'hover:bg-hover',
      )}
    >
      <Cover src={coverAt(candidate.cover, 250)} className={large ? 'size-16' : 'size-10'} rounded="sm" />
      <div className="min-w-0 flex-1">
        <div className={clsx('flex items-center gap-2 truncate font-medium', large ? 'text-[15px]' : 'text-[13px]')}>
          <span className="truncate">{candidate.title}</span>
          {candidate.source === 'musicbrainz' && <Badge className="shrink-0">MusicBrainz</Badge>}
        </div>
        <div className="truncate text-[12.5px] text-muted">
          {candidateMeta(candidate)}
          {candidate.owned === 'partial' && <span className="text-warn"> · Partly in library</span>}
        </div>
      </div>
      {owned ? (
        <span className="flex shrink-0 items-center gap-1 text-[12px] text-ok">
          <Check className="size-3.5" /> In library
        </span>
      ) : selected ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
          <kbd className="inline-flex h-5 items-center rounded border border-line-strong px-1.5 font-sans text-[11px]">
            <CornerDownLeft className="size-3" />
          </kbd>
          {candidate.owned === 'partial' ? 'Download missing' : 'Download'}
        </span>
      ) : (
        <ArrowDownToLine className="size-4 shrink-0 text-subtle" />
      )}
    </div>
  )
}
