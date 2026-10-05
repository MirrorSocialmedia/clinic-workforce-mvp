/**
 * ★ cwm-labdoc P1（CHUNK 6）：單據狀態 / 類型 → 前端顯示（§3.4 狀態機、§12.1、§4.3）
 *
 * 灰色（dimmed）= 存底保留但唔再處理：VOID / DUPLICATE / SUPERSEDED（§4.3 檔案庫
 * 「已作廢、DUPLICATE、SUPERSEDED 都顯示（灰色＋原因）」）。
 */

export const DOC_STATUS_META: Record<string, { label: string; cls: string; dimmed?: boolean }> = {
  // INVOICE（§3.4）
  UPLOADED: { label: '已上傳', cls: 'bg-slate-100 text-slate-600' },
  EXTRACTING: { label: '讀取中', cls: 'bg-blue-100 text-blue-700' },
  NEEDS_REVIEW: { label: '待確認', cls: 'bg-amber-100 text-amber-700' },
  EXTRACT_FAILED: { label: '讀取失敗', cls: 'bg-red-100 text-red-700' },
  DUPLICATE: { label: '重複', cls: 'bg-gray-200 text-gray-500', dimmed: true },
  CONFIRMED: { label: '已確認', cls: 'bg-emerald-100 text-emerald-700' },
  PARTIAL: { label: '部分對咗', cls: 'bg-amber-100 text-amber-700' },
  RECONCILED: { label: '已對', cls: 'bg-green-100 text-green-700' },
  VOID: { label: '已作廢', cls: 'bg-gray-200 text-gray-500', dimmed: true },
  // STATEMENT（§3.4）
  IN_PROGRESS: { label: '對數中', cls: 'bg-blue-100 text-blue-700' },
  SUPERSEDED: { label: '已被取代', cls: 'bg-gray-200 text-gray-500', dimmed: true },
}

export function statusMeta(status: string | null | undefined) {
  return (
    status && DOC_STATUS_META[status]
      ? DOC_STATUS_META[status]
      : { label: status || '未知', cls: 'bg-gray-100 text-gray-500' }
  )
}

export const KIND_LABEL: Record<string, string> = {
  INVOICE: '到貨單',
  STATEMENT: '月結單',
}

export function kindLabel(kind: string | null | undefined) {
  return (kind && KIND_LABEL[kind]) || kind || '—'
}

/** HK wall-clock YYYY-MM-DD（同 app 慣例；toISOString 係 UTC，凌晨會錯日期） */
export function hkDate(d: Date | string | null | undefined): string {
  if (!d) return ''
  const dt = typeof d === 'string' ? new Date(d) : d
  if (isNaN(dt.getTime())) return ''
  return new Date(dt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** HK wall-clock YYYY-MM-DD HH:mm */
export function hkDateTime(d: Date | string | null | undefined): string {
  if (!d) return ''
  const dt = typeof d === 'string' ? new Date(d) : d
  if (isNaN(dt.getTime())) return ''
  return new Date(dt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

export function fmtMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (isNaN(n)) return '—'
  return `$${n.toLocaleString('en-HK', { maximumFractionDigits: 2 })}`
}
