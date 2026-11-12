export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  if (response.status === 401 && path !== '/auth/login') {
    window.dispatchEvent(new Event('seeker:unauthorized'))
  }
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const data = isJson ? await response.json() : null
  if (!response.ok) {
    throw new ApiError((data as { error?: string } | null)?.error ?? `Request failed (${response.status})`, response.status)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
}
