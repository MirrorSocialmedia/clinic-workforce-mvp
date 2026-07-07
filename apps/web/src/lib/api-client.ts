/**
 * Unified API fetch with mandatory error display.
 * Prevents silent crashes from swallowed 403/500 errors.
 */

export interface ApiError extends Error {
  status?: number
}

export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const error = new Error(
      body.error || `${url} 失敗 (${res.status})`,
    ) as ApiError
    error.status = res.status
    throw error
  }

  // Handle empty body (e.g., 204 No Content)
  const text = await res.text()
  if (!text) return null as T
  return JSON.parse(text)
}
