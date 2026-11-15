import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePresence } from '../lib/presence.ts'

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  const panel = useRef<HTMLDivElement>(null)
  const { mounted, closing } = usePresence(open, 140)
  // Keep showing what was there while the dialog animates out.
  const last = useRef({ title, description, children, footer })
  if (open) last.current = { title, description, children, footer }
  const shown = last.current

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
      if (event.key === 'Tab' && panel.current) {
        const focusable = panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (focusable.length === 0) return
        const first = focusable[0]!
        const lastItem = focusable[focusable.length - 1]!
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          lastItem.focus()
        } else if (!event.shiftKey && document.activeElement === lastItem) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    const timer = setTimeout(() => {
      const root = panel.current
      const target =
        root?.querySelector<HTMLElement>('[data-autofocus]') ??
        root?.querySelector<HTMLElement>('input') ??
        root?.querySelector<HTMLElement>('button:not([data-close])')
      target?.focus()
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey, true)
      previous?.focus?.()
    }
  }, [open, onClose])

  if (!mounted) return null
  return createPortal(
    <div className={clsx('fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6', closing && 'pointer-events-none')}>
      <div
        className={clsx('absolute inset-0 bg-black/45 backdrop-blur-[2px]', closing ? 'animate-fade-out' : 'animate-fade-in')}
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        className={clsx(
          'relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-xl border border-line-strong bg-raised shadow-2xl shadow-black/30 sm:rounded-xl',
          size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg',
          closing ? 'animate-pop-out' : 'animate-pop-in',
        )}
      >
        <div className="flex items-start gap-4 px-5 pt-5 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-15 font-semibold tracking-tight">{shown.title}</h2>
            {shown.description && <div className="mt-1 text-13 text-muted">{shown.description}</div>}
          </div>
          <button
            type="button"
            data-close
            onClick={onClose}
            className="-mt-1 -mr-1 rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        {shown.children && <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-4">{shown.children}</div>}
        {shown.footer && <div className="flex justify-end gap-2 border-t border-line bg-panel/60 px-5 py-3">{shown.footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
