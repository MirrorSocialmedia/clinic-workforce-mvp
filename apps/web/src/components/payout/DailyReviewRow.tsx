'use client'

// ============================================================
// ★ cwm-dailyreview-20261006：醫生月結預覽「每日收款」行
//   逐日：呢位醫生收款／全店收款／該店該日護士核對狀態；未核對同有變排最前
//   「去每日大數核對」開新分頁（帶診所＋月份範圍）；「重新計算」= 重新預覽
// ★ cwm-pvcheck-20261007 A：就地核對
//   每行【核對】／【重新核對】→ 行內細表（共用組件 InlineDayCheck，
//   ★ cwm-dailyv3-20261010 §3 由本檔抽出，每日大數 ②③ 共用；行為照舊）；
//   同一時間只開一行；409「數字啱啱變咗」保持打開提示重新計算；
//   409「已經核對／有人核對咗」當成功 → 提示「其他人已核對」+ onRecompute()；
//   400「唔屬於呢間店」→ 重新 GET 護士名單；成功 → applyLocalCheck 局部更新（唔重算全預覽）；
//   「只顯示未核對／有變」保留啱啱核對嘅行（justChecked，變綠加「（啱啱核對）」）。
//   client 零 prisma：daily-review 只 import type；applyLocalCheck 喺 daily-review-local。
// ============================================================
import { useEffect, useRef, useState } from 'react'
import { todayHK } from '@/lib/hk-date'
import type { DailyReview } from '@/lib/payout/daily-review'
import { applyLocalCheck } from '@/lib/payout/daily-review-local'
import { InlineDayCheck } from './InlineDayCheck'

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const dayLabel = (d: string) => `${d.slice(5)}（${WEEK[new Date(`${d}T12:00:00+08:00`).getUTCDay()]}）`
const hhmm = (iso: string) => new Date(iso).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const RANK: Record<string, number> = { CHANGED: 0, UNCHECKED: 1, CHECKED: 2, NONE: 3 }

export function DailyReviewRow({ review, clinicId, clinicLabel, month, onRecompute, busy, onChecked, providerId, providerLabel }: {
  review: DailyReview | undefined
  clinicId: string
  clinicLabel: string
  month: string
  onRecompute: () => void
  busy: boolean
  /** ★ pvcheck A4：核對成功後傳新 DailyReview 上層局部更新（頂部 pills + 底部 N 日提示即時變） */
  onChecked?: (next: DailyReview) => void
  /** ★ pvcheck B：「去每日大數核對」帶醫生 — href 加 providerId，掣文字加細字「→ 醫生 · 診所 · M 月」 */
  providerId?: string
  providerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [onlyOpen, setOnlyOpen] = useState(true)
  // ★ pvcheck A：行內核對 —— 同一時間只開一行（checkDate = 邊日開緊）
  //   細表邏輯（護士名單逐日 GET／重試／409/400 處理／送出 disabled）搬入共用組件 InlineDayCheck
  const [checkDate, setCheckDate] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  // ★ pvcheck A5：啱啱核對嘅行留喺「只顯示未核對／有變」篩選（變綠＋（啱啱核對））
  const [justChecked, setJustChecked] = useState<Set<string>>(new Set())

  // ★ A5：收起再開 → 清空 justChecked
  const prevOpen = useRef(open)
  useEffect(() => {
    if (open && !prevOpen.current) setJustChecked(new Set())
    prevOpen.current = open
  }, [open])
  // ★ A5 + hotfix1 F1：busy falling edge（true→false = 重新計算完成、data 已變）先清 justChecked/notice。
  //   舊版 busy=true 即清 → 同 409「其他人已核對」分支 setNotice+onRecompute() 同一 React batch，
  //   notice 同幀被清（用戶睇唔到提示）；而家 recompute 期間保留，完成（data 已變）先清，啱 MD A5「review data 變先清」口徑。
  //   初值路徑：useRef(busy) = 首 render 值 → 首 effect run prev===busy 無 edge，首載 busy=true 起始都唔會誤清。
  const prevBusy = useRef(busy)
  useEffect(() => {
    if (prevBusy.current && !busy) { setJustChecked(new Set()); setNotice('') }
    prevBusy.current = busy
  }, [busy])

  if (!review) return null
  const { counts } = review
  const today = todayHK()
  const sorted = [...review.days].sort((a, b) => RANK[a.status] - RANK[b.status] || a.date.localeCompare(b.date))
  const shown = onlyOpen
    ? sorted.filter(d => d.status === 'CHANGED' || d.status === 'UNCHECKED' || justChecked.has(d.date))
    : sorted
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
  // ★ pvcheck B：帶醫生 deep link（doctor + clinic + month 一次過）
  const linkParams = new URLSearchParams({ clinicId, from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` })
  if (providerId) linkParams.set('providerId', providerId)
  const href = `/payout/daily?${linkParams}`


  // ── 狀態文字 + 掣（A1）───────────────────────────────────────
  const statusCell = (d: (typeof review.days)[number]) => {
    const future = d.date > today // 未到嘅日子唔出掣（client 端 HK 日期字串比較）
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className={`text-xs ${d.status === 'CHECKED' ? 'text-green-700' : d.status === 'CHANGED' ? 'text-red-700' : d.status === 'UNCHECKED' ? 'text-amber-800' : 'text-gray-500'}`}>
          {d.status === 'CHECKED' && `✓ ${d.nurseName} · ${d.checkedAt ? hhmm(d.checkedAt) : ''}${justChecked.has(d.date) ? '（啱啱核對）' : ''}`}
          {d.status === 'CHANGED' && `⚠ 有變（核對時 ${money(d.checkedAmount ?? 0)}）`}
          {d.status === 'UNCHECKED' && '未核對'}
          {d.status === 'NONE' && '全店冇營收，唔使核對'}
        </span>
        {d.status === 'UNCHECKED' && !future && (
          <button type="button" onClick={() => setCheckDate(d.date)} disabled={checkDate != null && checkDate !== d.date}
            className="h-7 px-2.5 rounded border border-green-600 text-green-700 text-xs bg-white hover:bg-green-50 disabled:opacity-50">核對</button>
        )}
        {d.status === 'CHANGED' && !future && (
          <button type="button" onClick={() => setCheckDate(d.date)} disabled={checkDate != null && checkDate !== d.date}
            className="h-7 px-2.5 rounded border border-red-600 text-red-700 text-xs bg-white hover:bg-red-50 disabled:opacity-50">重新核對</button>
        )}
      </div>
    )
  }

    // ── 行內細表（A2）—— 共用組件 InlineDayCheck（cwm-dailyv3-20261010 §3）────────
  const checkTable = (d: (typeof review.days)[number]) => {
    if (checkDate !== d.date) return null
    return (
      <div className="col-span-4 mt-1">
        <InlineDayCheck
          clinicId={clinicId}
          clinicLabel={clinicLabel}
          date={d.date}
          storeTotal={d.storeTotal}
          status={d.status === 'CHANGED' ? 'CHANGED' : 'UNCHECKED'}
          onSuccess={(nurseName) => {
            // ★ A4：本地即時更新（唔使成個預覽重新計）；checkedAt 用而家時間（顯示用，鎖定時 server 會重計）
            onChecked?.(applyLocalCheck(review, d.date, nurseName, new Date().toISOString()))
            setJustChecked(s => new Set(s).add(d.date))
          }}
          onAlreadyChecked={() => { setNotice('其他人已核對'); onRecompute() }}
          onClose={() => setCheckDate(null)}
        />
      </div>
    )
  }

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
          {notice && <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">{notice}</div>}
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)] gap-2 px-2 text-xs font-semibold text-gray-600">
            <span>日期</span><span className="text-right">呢位醫生收款</span><span className="text-right">全店收款</span><span>護士核對（每店每日）</span>
          </div>
          {shown.length === 0 && <div className="px-2 text-gray-500 text-xs">{onlyOpen ? '全部已核對 ✓' : '呢個月冇收款'}</div>}
          {shown.map(d => (
            <div key={d.date} className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)] gap-2 px-2 py-1 rounded border items-center ${d.status === 'CHANGED' ? 'bg-red-50 border-red-200' : d.status === 'UNCHECKED' ? 'bg-amber-50 border-amber-200' : justChecked.has(d.date) ? 'bg-green-50 border-green-300' : 'bg-white'}`}>
              <span>{dayLabel(d.date)}</span>
              <span className="text-right tabular-nums">{money(d.doctorRaw)}</span>
              <span className="text-right tabular-nums text-gray-500">{money(d.storeTotal)}</span>
              {statusCell(d)}
              {checkTable(d)}
            </div>
          ))}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <a href={href} target="_blank" rel="noopener noreferrer" className="h-8 inline-flex items-center px-3 rounded border border-teal-700 text-teal-800 text-xs hover:bg-teal-50">去每日大數核對{providerLabel && <small className="ml-1 font-normal">→ {providerLabel} · {clinicLabel} · {Number(month.slice(5, 7))} 月</small>}（新分頁）→</a>
            <button type="button" onClick={onRecompute} disabled={busy} className="h-8 px-3 rounded border bg-white text-xs disabled:opacity-50">{busy ? '計算中…' : '↻ 重新計算'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
