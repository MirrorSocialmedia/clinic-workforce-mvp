'use client'

// ============================================================
// ★ cwm-dailyreview-20261006：醫生月結預覽「每日收款」行
//   逐日：呢位醫生收款／全店收款／該店該日護士核對狀態；未核對同有變排最前
//   「去每日大數核對」開新分頁（帶診所＋月份範圍）；「重新計算」= 重新預覽
// ============================================================
import { useState } from 'react'
import type { DailyReview } from '@/lib/payout/daily-review'

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const dayLabel = (d: string) => `${d.slice(5)}（${WEEK[new Date(`${d}T12:00:00+08:00`).getUTCDay()]}）`
const hhmm = (iso: string) => new Date(iso).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const RANK: Record<string, number> = { CHANGED: 0, UNCHECKED: 1, CHECKED: 2, NONE: 3 }

export function DailyReviewRow({ review, clinicId, clinicLabel, month, onRecompute, busy }: {
  review: DailyReview | undefined
  clinicId: string
  clinicLabel: string
  month: string
  onRecompute: () => void
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [onlyOpen, setOnlyOpen] = useState(true)
  if (!review) return null
  const { counts } = review
  const sorted = [...review.days].sort((a, b) => RANK[a.status] - RANK[b.status] || a.date.localeCompare(b.date))
  const shown = onlyOpen ? sorted.filter(d => d.status === 'CHANGED' || d.status === 'UNCHECKED') : sorted
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
  const href = `/payout/daily?${new URLSearchParams({ clinicId, from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` })}`

  return (
    <div className={`rounded-lg border-2 ${review.needsAck ? 'border-amber-400 bg-amber-50/50' : 'border-gray-200'}`} role="region" aria-label="每日收款">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex justify-between items-center gap-2 px-3 py-2 text-left">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">{open ? '▾' : '▸'}</span>
          每日收款（{clinicLabel} · {month} · {review.days.length} 日）
          {counts.checked > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 border border-green-600 text-green-800">✓ {counts.checked} 日已核對</span>}
          {counts.changed > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 border border-red-600 text-red-800">⚠ {counts.changed} 日有變</span>}
          {counts.unchecked > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 border border-amber-500 text-amber-900">{counts.unchecked} 日未核對</span>}
        </span>
        <span className="tabular-nums">{money(review.doctorTotal)}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-7 space-y-1.5 text-sm">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} />只顯示未核對／有變
          </label>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)] gap-2 px-2 text-xs font-semibold text-gray-600">
            <span>日期</span><span className="text-right">呢位醫生收款</span><span className="text-right">全店收款</span><span>護士核對（每店每日）</span>
          </div>
          {shown.length === 0 && <div className="px-2 text-gray-500 text-xs">{onlyOpen ? '全部已核對 ✓' : '呢個月冇收款'}</div>}
          {shown.map(d => (
            <div key={d.date} className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)] gap-2 px-2 py-1 rounded border items-center ${d.status === 'CHANGED' ? 'bg-red-50 border-red-200' : d.status === 'UNCHECKED' ? 'bg-amber-50 border-amber-200' : 'bg-white'}`}>
              <span>{dayLabel(d.date)}</span>
              <span className="text-right tabular-nums">{money(d.doctorRaw)}</span>
              <span className="text-right tabular-nums text-gray-500">{money(d.storeTotal)}</span>
              <span className={`text-xs ${d.status === 'CHECKED' ? 'text-green-700' : d.status === 'CHANGED' ? 'text-red-700' : d.status === 'UNCHECKED' ? 'text-amber-800' : 'text-gray-500'}`}>
                {d.status === 'CHECKED' && `✓ ${d.nurseName} · ${d.checkedAt ? hhmm(d.checkedAt) : ''}`}
                {d.status === 'CHANGED' && `⚠ 核對後有變（核對時 ${money(d.checkedAmount ?? 0)}）`}
                {d.status === 'UNCHECKED' && '未核對'}
                {d.status === 'NONE' && '全店冇營收，唔使核對'}
              </span>
            </div>
          ))}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <a href={href} target="_blank" rel="noopener noreferrer" className="h-8 inline-flex items-center px-3 rounded border border-teal-700 text-teal-800 text-xs hover:bg-teal-50">去每日大數核對（新分頁）→</a>
            <button type="button" onClick={onRecompute} disabled={busy} className="h-8 px-3 rounded border bg-white text-xs disabled:opacity-50">{busy ? '計算中…' : '↻ 重新計算'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
