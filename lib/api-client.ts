type ApiError = Error & { status?: number; data?: any }

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const error = new Error(
      typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
    ) as ApiError
    error.status = res.status
    error.data = body
    throw error
  }

  return res.json() as Promise<T>
}
