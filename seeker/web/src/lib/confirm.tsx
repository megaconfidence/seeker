import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Dialog } from '../components/dialog.tsx'
import { Button } from '../components/ui.tsx'

interface ConfirmOptions {
  title: string
  description?: ReactNode
  confirmLabel?: string
  tone?: 'default' | 'danger'
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false)

export function useConfirm() {
  return useContext(ConfirmContext)
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback((next: ConfirmOptions) => {
    setOptions(next)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const close = (value: boolean) => {
    resolver.current?.(value)
    resolver.current = null
    setOptions(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!options}
        onClose={() => close(false)}
        title={options?.title}
        description={options?.description}
        size="sm"
        footer={
          <>
            <Button variant="ghost" data-autofocus={options?.tone === 'danger' ? true : undefined} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              data-autofocus={options?.tone === 'danger' ? undefined : true}
              variant={options?.tone === 'danger' ? 'danger' : 'primary'}
              onClick={() => close(true)}
            >
              {options?.confirmLabel ?? 'Continue'}
            </Button>
          </>
        }
      />
    </ConfirmContext.Provider>
  )
}
