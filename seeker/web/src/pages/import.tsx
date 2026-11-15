import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Folder, FolderInput, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { ImportCandidate, ImportChoice, ImportFolder, Job } from '../../../shared/types.ts'
import { MatchAlbumDialog } from '../components/match-album-dialog.tsx'
import { Skeleton } from '../components/skeleton.tsx'
import { Badge, Button, Empty, PageHeader, Tabs } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { bytes, plural } from '../lib/format.ts'
import { useToast } from '../lib/toast.tsx'

interface ImportList {
  dir: string
  exists: boolean
  folders: ImportFolder[]
}

export function ImportPage() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const [mode, setMode] = useState<'copy' | 'move'>('copy')
  const [open, setOpen] = useState<ImportFolder | null>(null)
  const [started, setStarted] = useState<Set<string>>(new Set())
  const list = useQuery({ queryKey: ['import'], queryFn: () => api.get<ImportList>('/import') })

  const onChoose = async (folder: ImportFolder, choice: ImportChoice) => {
    const { job } = await api.post<{ job: Job }>(`/import/${folder.id}`, { choice, mode })
    setStarted((current) => new Set(current).add(folder.id))
    toast(`${mode === 'copy' ? 'Copying' : 'Moving'} ${folder.album ?? folder.name} into your library`, {
      action: { label: 'View', onClick: () => navigate(`/downloads?job=${job.id}`) },
    })
    if (mode === 'move') setTimeout(() => void client.invalidateQueries({ queryKey: ['import'] }), 4000)
  }

  return (
    <div>
      <PageHeader
        title="Import music"
        subtitle={
          list.data ? (
            <>
              Albums in <span className="font-mono text-12">{list.data.dir}</span>. Seeker matches each folder to an album, tags the files and
              files them in your library.
            </>
          ) : (
            'Add music you already have to your library.'
          )
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className={list.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />}
            onClick={() => void list.refetch()}
          >
            Refresh
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Tabs
          value={mode}
          onChange={setMode}
          options={[
            { value: 'copy', label: 'Copy files' },
            { value: 'move', label: 'Move files' },
          ]}
        />
        <span className="text-12.5 text-muted">
          {mode === 'copy' ? 'The originals stay where they are.' : 'Files are moved out of the import folder.'}
        </span>
      </div>

      {list.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 rounded-lg border border-line px-4 py-3">
              <Skeleton className="size-10" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="mt-1.5 h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : list.isError ? (
        <p className="text-13 text-bad">{(list.error as Error).message}</p>
      ) : !list.data.exists ? (
        <Empty icon={<FolderInput className="size-6" />} title="No import folder">
          Seeker looks for music to import in <span className="font-mono text-12">{list.data.dir}</span>. Mount a folder there and
          restart Seeker.
        </Empty>
      ) : list.data.folders.length === 0 ? (
        <Empty icon={<FolderInput className="size-6" />} title="Nothing to import">
          Put album folders in <span className="font-mono text-12">{list.data.dir}</span>, then refresh.
        </Empty>
      ) : (
        <div className="flex animate-content-in flex-col gap-2">
          {list.data.folders.map((folder) => {
            const name = folder.album ?? folder.name
            const meta = [folder.artist, folder.year, plural(folder.files, 'file'), bytes(folder.size), folder.formats.join(', ')].filter(Boolean)
            return (
              <div key={folder.id} className="flex flex-col gap-3 rounded-lg border border-line px-4 py-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3.5">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-hover text-subtle">
                    <Folder className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-13.5 font-medium">{name}</span>
                      {started.has(folder.id) && <Badge tone="ok">Import started</Badge>}
                    </div>
                    <div className="truncate text-12.5 text-muted">{meta.join(' · ')}</div>
                    {folder.album && folder.name !== folder.album && (
                      <div className="truncate font-mono text-11.5 text-subtle">{folder.path}</div>
                    )}
                  </div>
                </div>
                <Button size="sm" variant={started.has(folder.id) ? 'ghost' : 'secondary'} onClick={() => setOpen(folder)}>
                  {started.has(folder.id) ? 'Import again' : 'Import…'}
                </Button>
              </div>
            )
          })}
        </div>
      )}

      <MatchAlbumDialog
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? `Import ${open.album ?? open.name}` : 'Import'}
        description="Pick the album these files belong to. Seeker tags them from the catalog and files them in your library."
        candidatesKey={['import', 'candidates', open?.id]}
        loadCandidates={() => api.post<ImportCandidate[]>(`/import/${open!.id}/identify`)}
        onChoose={(choice) => onChoose(open!, choice)}
        asIsLabel="Import with the files’ own tags"
        chooseLabel="Import"
        initialQuery={open ? [open.artist, open.album ?? open.name].filter(Boolean).join(' ') : ''}
      />
    </div>
  )
}
