import clsx from 'clsx'
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
  hint?: string
}

export function Menu({ items, label = 'More actions', align = 'right' }: { items: MenuItem[]; label?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
        className={clsx(
          'inline-flex size-8.5 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg',
          open && 'bg-hover text-fg',
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className={clsx(
            'absolute top-10 z-30 min-w-52 animate-menu-in rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/20',
            align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left',
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              onClick={(event) => {
                event.stopPropagation()
                setOpen(false)
                item.onSelect()
              }}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent',
                item.tone === 'danger' ? 'text-bad' : 'text-fg',
              )}
            >
              <span className="text-muted [&>svg]:size-4">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
