/**
 * ★ 2026-10-13：「再讀」— 月結單有人手改／加嘅行 → API 回 409 MANUAL_LINES，問用家先再讀（會清走）。
 * 成功回 true；用家取消或者失敗回 false（失敗已 toast）。
 */
import { toast } from 'sonner'
import { apiFetch, type ApiError } from '@/lib/api-client'

export async function retryLabDoc(id: string): Promise<boolean> {
  const post = (confirmManual: boolean) =>
    apiFetch(`/api/lab-docs/${id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmManual }),
    })
  try {
    await post(false)
    return true
  } catch (e) {
    const err = e as ApiError
    if (err.body?.code !== 'MANUAL_LINES') {
      toast.error(err.message)
      return false
    }
    if (!window.confirm(`${err.message}\n\n人手改／加過嘅行會冇咗，要重新改。`)) return false
    try {
      await post(true)
      return true
    } catch (e2) {
      toast.error((e2 as Error).message)
      return false
    }
  }
}
