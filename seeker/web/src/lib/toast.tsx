import clsx from 'clsx'
import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

type Tone = 'default' | 'error'

interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastOptions {
  tone?: Tone
  action?: ToastAction
  secondary?: ToastAction
  duration?: number
}

interface Toast {
  id: number
  message: string
  tone: Tone
  action?: ToastAction
  secondary?: ToastAction
  leaving?: boolean
}

type Push = (message: string, options?: Tone | ToastOptions) => void

const ToastContext = createContext<Push>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  // Fade out first, then remove.
  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)))
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), 160)
  }, [])
  const push = useCallback<Push>(
    (message, options) => {
      const opts: ToastOptions = typeof options === 'string' ? { tone: options } : (options ?? {})
      const id = Date.now() + Math.random()
      const tone = opts.tone ?? 'default'
      setToasts((list) => [...list.slice(-3), { id, message, tone, action: opts.action, secondary: opts.secondary }])
      setTimeout(() => dismiss(id), opts.duration ?? (tone === 'error' ? 7000 : opts.action ? 6500 : 4000))
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-28"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              'pointer-events-auto flex max-w-md items-center gap-2.5 rounded-lg border border-line-strong bg-raised py-2 pr-1.5 pl-3.5 text-[13px] shadow-lg shadow-black/20',
              toast.leaving ? 'pointer-events-none animate-toast-out' : 'animate-toast-in',
            )}
          >
            {toast.tone === 'error' ? (
              <CircleAlert className="size-4 shrink-0 text-bad" />
            ) : (
              <CircleCheck className="size-4 shrink-0 text-ok" />
            )}
            <span className="min-w-0 flex-1 py-0.5">{toast.message}</span>
            {[toast.secondary, toast.action].filter(Boolean).map((action) => (
              <button
                key={action!.label}
                type="button"
                onClick={() => {
                  action!.onClick()
                  dismiss(toast.id)
                }}
                className="shrink-0 rounded-md px-2 py-1 text-[12.5px] font-medium text-fg hover:bg-hover"
              >
                {action!.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="rounded p-1 text-subtle hover:bg-hover hover:text-fg"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
