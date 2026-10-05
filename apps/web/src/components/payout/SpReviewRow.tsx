'use client'

// ============================================================
// ★ cwm-sppreview-20261006：醫生月結預覽「SP 補貼」行
//   有未確認 → 黃框＋「⚠ N 筆未確認 · $X（未計入）」，撳開逐筆列（帳單號／日期／標記，零病人資料）
//   成間店未掃描 → 黃框＋「⚠ 仲未掃描」
//   「去 2人SP 確認」開新分頁（帶月份／醫生／診所）；「重新計算」= 重新預覽
// ============================================================
import { useState } from 'react'

export interface SpReviewData {
  providerName: string
  clinicName: string
  pending: Array<{ id: string; billCode: string | null; billTime: string | null; amount: number; needsReview: boolean; hasMarker: boolean }>
  pendingTotal: number
  scanned: boolean
  needsAck: boolean
}

export function spPageHref(month: string, sp: SpReviewData) {
  const q = new URLSearchParams({ month, provider: sp.providerName, clinic: sp.clinicName })
  return `/payout/sp-subsidies?${q.toString()}`
}

export function SpReviewRow({ amount, sp, month, onRecompute, busy }: {
  amount: number
  sp: SpReviewData | undefined
  month: string
  onRecompute: () => void
  busy: boolean
}) {
  const [open, setOpen] = useState(true)
  if (!sp || !sp.needsAck) {
    return <div className="flex justify-between text-green-600"><span>SP 補貼</span><span>+$ {amount.toFixed(2)}</span></div>
  }
  const hasPending = sp.pending.length > 0
  return (
    <div className="border-2 border-amber-400 rounded-lg bg-amber-50/50" role="region" aria-label="2人SP 提示">
      <div className="flex justify-between items-center px-3 py-2 text-green-700">
        {hasPending ? (
          <button type="button" onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-left" aria-expanded={open}>
            <span className="text-xs text-gray-500">{open ? '▾' : '▸'}</span>
            SP 補貼
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 border border-amber-400 text-amber-900">
              ⚠ {sp.pending.length} 筆未確認 · ${sp.pendingTotal}（未計入）
            </span>
          </button>
        ) : (
          <span className="flex items-center gap-2">
            SP 補貼
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 border border-amber-400 text-amber-900">⚠ {sp.clinicName} {month} 仲未掃描</span>
          </span>
        )}
        <span>+$ {amount.toFixed(2)}</span>
      </div>
      {(open || !hasPending) && (
        <div className="px-3 pb-3 pl-7 space-y-1.5 text-sm">
          {hasPending ? (
            <>
              <div className="text-amber-900">呢位醫生喺 {sp.clinicName} {month} 有 {sp.pending.length} 筆 2人SP 仲係「待確認」，未確認唔會計入月結。</div>
              {sp.pending.map(p => (
                <div key={p.id} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto] gap-2 px-2 py-1 bg-white border border-amber-200 rounded items-center">
                  <span className="tabular-nums">帳單 {p.billCode ?? '—'}</span>
                  <span className="text-gray-500">{p.billTime ? new Date(p.billTime).toLocaleDateString('zh-HK') : '—'}</span>
                  <span className={`text-xs ${p.needsReview ? 'text-amber-800' : 'text-green-700'}`}>
                    {p.needsReview ? (p.hasMarker ? '⚠ 需覆核' : '⚠ 需覆核：冇 2P1K 備註') : '✅ 2P1K 標記'}
                  </span>
                  <span className="text-right tabular-nums">${p.amount}</span>
                </div>
              ))}
            </>
          ) : (
            <div className="text-amber-900">成間 {sp.clinicName} 今個月一筆 2人SP 紀錄都冇 —— 多數係未撳過「掃描候選」，唔係真係冇。</div>
          )}
          <div className="flex flex-wrap justify-between items-center gap-2 pt-1">
            <span className="text-xs text-gray-500">{hasPending ? '確認完返嚟撳「重新計算」，SP 會即刻計入。' : '掃描完返嚟撳「重新計算」。'}</span>
            <span className="flex gap-2">
              <a href={spPageHref(month, sp)} target="_blank" rel="noopener noreferrer"
                className="h-8 inline-flex items-center px-3 rounded border border-teal-700 text-teal-800 text-xs hover:bg-teal-50">
                {hasPending ? '去 2人SP 確認（新分頁）→' : '去 2人SP 掃描（新分頁）→'}
              </a>
              <button type="button" onClick={onRecompute} disabled={busy}
                className="h-8 px-3 rounded border bg-white text-xs disabled:opacity-50">{busy ? '計算中…' : '↻ 重新計算'}</button>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
