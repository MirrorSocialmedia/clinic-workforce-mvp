/**
 * ★ 2026-10-12：「兩份加埋一齊對」— 同一位醫生、同一間 Lab、同一個月有兩份月結單（唔係 Lab 重發）
 * 另一份已確認 → 問用家（加埋之後要重新確認）再送 resetConfirmed。
 */
import { toast } from 'sonner'
import { apiFetch, type ApiError } from '@/lib/api-client'

export async function combineSection(docId: string, sectionId: string, opts: { silent?: boolean } = {}): Promise<boolean> {
  const post = (resetConfirmed: boolean) =>
    apiFetch(`/api/lab-docs/${docId}/sections/${sectionId}/combine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resetConfirmed }),
    })
  try {
    await post(false)
  } catch (e) {
    const err = e as ApiError
    if (err.body?.code !== 'GROUP_CONFIRMED') {
      toast.error(err.message)
      return false
    }
    if (!window.confirm('另一份月結單已經確認咗 — 加埋之後兩份要重新確認一次。確定加埋？')) return false
    try {
      await post(true)
    } catch (e2) {
      toast.error((e2 as Error).message)
      return false
    }
  }
  if (!opts.silent) toast.success('已加埋：兩份月結單一齊同成本錄入對')
  return true
}
