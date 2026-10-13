'use client'

// ★ 2026-10-13：讀單讀唔到月份嘅月結單 → 檔案庫／列表「處理中」直接揀月份
//   （之前月結單列表有月份篩選，冇月份嘅單完全搵唔到入口）
//   用返 PUT /api/lab-docs/:id/statement-header（lab_statement 權限、版本鎖、audit LAB_STATEMENT_HEADER）
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api-client'

/** 呢份單係咪「月結單、未有月份、仲可以改」 */
export function needsStatementMonth(d: { kind: string; status: string; statementMonth: string | null; supersededById?: string | null }) {
  return d.kind === 'STATEMENT' && !d.statementMonth && !d.supersededById && (d.status === 'NEEDS_REVIEW' || d.status === 'IN_PROGRESS')
}

/** 預設揀上個月（月結單通常月頭寄上個月） */
function lastMonth(): string {
  const now = new Date(Date.now() + 8 * 3600 * 1000) // 香港時間
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-based = 上個月嘅 1-based
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`
}

export default function StatementMonthPick({ docId, version, onDone }: { docId: string; version: number; onDone: () => void }) {
  const [month, setMonth] = useState(lastMonth())
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const save = async () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      toast.error('請揀月份')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/lab-docs/${docId}/statement-header`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statementMonth: month, version }),
      })
      setDone(month)
      toast.success(`已設 ${month} — 喺月結單列表揀 ${month} 就搵到`)
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (done) {
    return (
      <Link href={`/lab-docs/statements/${docId}`} onClick={(e) => e.stopPropagation()} className="text-xs underline text-[#2f6b68] whitespace-nowrap">
        {done} · 開月結單核對
      </Link>
    )
  }
  return (
    // 喺可以撳嘅行入面 — 唔好觸發開檢視器
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <span className="text-xs text-amber-700">月份未識別</span>
      <input
        aria-label="月結單月份"
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="border rounded px-1.5 py-0.5 text-xs bg-card"
      />
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="px-2 py-0.5 rounded bg-[#2f6b68] text-white text-xs disabled:opacity-50"
      >
        {saving ? '儲存中…' : '設定'}
      </button>
    </span>
  )
}
