import { useState } from 'react'
import { Button, Input } from '../components/ui.tsx'
import { api } from '../lib/api.ts'

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/login', { password })
      onLoggedIn()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6">
      <form onSubmit={submit} className="w-full max-w-80">
        <div className="mb-8 flex flex-col items-center gap-3">
          <svg viewBox="0 0 64 64" className="size-10" aria-hidden>
            <rect width="64" height="64" rx="14" className="fill-fg" />
            <circle cx="29" cy="29" r="14" fill="none" strokeWidth="5" className="stroke-inverse" />
            <circle cx="29" cy="29" r="3.5" className="fill-inverse" />
            <path d="M39.5 39.5l9 9" strokeWidth="5" strokeLinecap="round" className="stroke-inverse" />
          </svg>
          <h1 className="text-lg font-semibold tracking-tight">Sign in to Seeker</h1>
        </div>
        <label className="mb-1.5 block text-12.5 font-medium text-muted" htmlFor="password">
          Password
        </label>
        <Input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <p className="mt-2 text-12.5 text-bad">{error}</p>}
        <Button type="submit" variant="primary" className="mt-4 w-full" loading={busy} disabled={!password}>
          Sign in
        </Button>
      </form>
    </div>
  )
}
