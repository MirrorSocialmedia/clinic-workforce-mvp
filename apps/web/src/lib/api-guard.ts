import { NextResponse } from 'next/server'

/**
 * Unified API error guard.
 * Wraps route handlers — catches errors, returns JSON error response.
 * User input errors (prefixed with CODE: or containing 必填/未對應) → 422
 * All others → 500
 *
 * ★ Does NOT log full error object (may contain patient data).
 *   Only logs e.message + stack for server errors.
 */
export async function handleRoute<T>(
  tag: string,
  fn: () => Promise<T>,
): Promise<T | NextResponse> {
  try {
    return await fn()
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    // User input error → 422; server error → 500
    const isUser = /^[A-Z_]+:/.test(msg) || msg.includes('必填') || msg.includes('未對應')
    if (!isUser) {
     console.error(`[${tag}] 失敗`, {
      message: msg.slice(0, 300),
      stack: String(e?.stack ?? '').split('\n').slice(0, 5).join('\n'),
     })
    }
    return NextResponse.json(
      { error: msg.slice(0, 300) },
      { status: isUser ? 422 : 500 },
    )
  }
}
