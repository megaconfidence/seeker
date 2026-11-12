import { useEffect, useState } from 'react'

// Keeps something mounted for a moment after it closes, so it can animate out.
export function usePresence(open: boolean, exitMs = 160): { mounted: boolean; closing: boolean } {
  const [state, setState] = useState<'open' | 'closing' | 'closed'>(open ? 'open' : 'closed')
  useEffect(() => {
    if (open) {
      setState('open')
      return
    }
    setState((current) => (current === 'closed' ? 'closed' : 'closing'))
    const timer = setTimeout(() => setState('closed'), exitMs)
    return () => clearTimeout(timer)
  }, [open, exitMs])
  return { mounted: open || state !== 'closed', closing: !open && state !== 'closed' }
}
