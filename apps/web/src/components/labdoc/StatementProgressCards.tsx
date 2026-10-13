'use client'

// ============================================================
// ★ cwm-labstmtprog-20261012：Lab 單據 · 月結單 —— 某月逐間診所「已對／對數中／未對＋未收到」
//   撳卡 = 下面列表只睇嗰間（再撳一次取消）。計法：lib/labdoc/statement-progress.ts
// ★ 2026-10-12：逐項列「Lab · 醫生」未對（撳去嗰段）／未收到（按 Lab × 醫生）
// ============================================================
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-client'
import { fmtMoney } from './status-meta'

interface Todo { kind: 'OPEN' | 'MISSING' | 'CARRY'; labName: string; providerName: string | null; docId: string | null; sectionId: string | null; diff: number | null; amount?: number | null; count?: number | null }
interface Carry { clinicName: string; labName: string; providerName: string | null; amount: number; count: number; docId: string; sectionId: string }
interface Row { clinicId: string; clinicName: string; reconciled: number; inProgress: number; open: number; missingLabs: string[]; todo?: Todo[] }
const TODO_SHOW = 5
interface Resp { month: string; clinics: Row[]; unassigned: number; fromMonth?: string; carryWaiting?: Carry[] }
const monthLabel = (m?: string) => (m ? `${Number(m.slice(5, 7))} 月` : '上月')

export default function StatementProgressCards({ month, clinicNames, selected, onPick, reloadKey }: {
  month: string
  clinicNames: Record<string, string>
  selected: string
  onPick: (clinicId: string) => void
  reloadKey: number
}) {
  const [data, setData] = useState<Resp | null>(null)
  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) { setData(null); return }
    let cancelled = false
    apiFetch<Resp>(`/api/lab-docs/statement-progress?month=${month}`)
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [month, reloadKey])

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return <div className="text-xs text-muted-foreground">揀月份先見到逐間診所已對／未對</div>
  }
  if (!data) return null
  if (data.clinics.length === 0) {
    return <div className="text-xs text-muted-foreground">{month}：未有月結單，亦冇 Lab 成本</div>
  }

  const pct = (n: number, t: number) => (t > 0 ? `${Math.round((n / t) * 100)}%` : '0%')
  const sum = (k: 'reconciled' | 'inProgress' | 'open') => data.clinics.reduce((s, c) => s + c[k], 0)
  const all = { reconciled: sum('reconciled'), inProgress: sum('inProgress'), open: sum('open'), missing: data.clinics.reduce((s, c) => s + c.missingLabs.length, 0) }
  const card = (key: string, title: string, c: { reconciled: number; inProgress: number; open: number }, missing: string[] | number, dashed = false, todo?: Todo[]) => {
    const total = c.reconciled + c.inProgress + c.open
    const missN = Array.isArray(missing) ? missing.length : missing
    // 有逐項就按項數（Lab × 醫生）；「全部」卡按份數
    const left = todo ? todo.length : c.inProgress + c.open + missN
    const sel = key !== '' && selected === key
    return (
      <div
        key={key || 'all'}
        className={`rounded-xl border-2 px-3 py-2 min-w-[170px] max-w-[320px] bg-card text-xs leading-relaxed ${dashed ? 'border-dashed' : ''} ${sel ? 'border-[#2f6b68] ring-2 ring-[#cfe5e3]' : 'border-border'}`}
      >
      <button
        type="button"
        onClick={() => key && onPick(sel ? '' : key)}
        className={`w-full text-left ${dashed ? 'cursor-default' : 'hover:opacity-80'}`}
        aria-pressed={sel}
      >
        <div className="flex items-baseline justify-between gap-2">
          <b className="text-sm">{title}</b>
          {left === 0 ? <span className="text-green-700 font-semibold">✓ 全部已對</span> : <span className="text-amber-700 font-semibold">仲有 {left} {todo ? '項' : '份'}</span>}
        </div>
        <div className="flex h-1.5 rounded-full overflow-hidden bg-muted my-1">
          <i className="block h-full bg-green-600" style={{ width: pct(c.reconciled, total) }} />
          <i className="block h-full bg-indigo-500" style={{ width: pct(c.inProgress, total) }} />
          <i className="block h-full bg-amber-500" style={{ width: pct(c.open, total) }} />
        </div>
        <div>
          已對 {c.reconciled} · <span className="text-indigo-700">對數中 {c.inProgress}</span> · <span className="text-amber-700">未對 {c.open}</span>
        </div>
        {!todo && missN > 0 && (
          <div className="text-red-700">
            未收到 {missN}{Array.isArray(missing) ? `：${missing.join('、')}` : ''}
          </div>
        )}
      </button>
        {todo && todo.length > 0 && (
          <div className="mt-1 pt-1 border-t border-dashed space-y-0.5">
            {todo.slice(0, TODO_SHOW).map((t, i) => {
              const label = `${t.labName} · ${t.providerName ?? (t.kind === 'OPEN' ? '未揀醫生' : '—')}`
              const tag = t.kind === 'OPEN'
                ? <span className="px-1.5 rounded bg-amber-50 text-amber-700 whitespace-nowrap">未對</span>
                : t.kind === 'CARRY'
                  ? <span className="px-1.5 rounded bg-violet-50 text-violet-700 whitespace-nowrap" title={`${monthLabel(data.fromMonth)}標咗「計入下個月」— 本月有同 Lab＋醫生嘅月結單先會自動帶入`}>結轉等單</span>
                  : <span className="px-1.5 rounded bg-red-50 text-red-700 whitespace-nowrap">未收到</span>
              const extra = t.kind === 'OPEN' && t.diff
                ? ` · 差 ${fmtMoney(Math.abs(t.diff))}`
                : t.kind === 'CARRY' && t.amount != null ? ` · ${fmtMoney(t.amount)}（${monthLabel(data.fromMonth)}）` : ''
              const href = t.docId ? (t.sectionId ? `/lab-docs/statements/${t.docId}/sections/${t.sectionId}` : `/lab-docs/statements/${t.docId}`) : null
              return (
                <div key={i} className="flex items-baseline gap-1.5">
                  {tag}
                  {href ? <Link href={href} className="underline truncate">{label}{extra}</Link> : <span className="truncate">{label}</span>}
                </div>
              )
            })}
            {todo.length > TODO_SHOW && <div className="text-muted-foreground">仲有 {todo.length - TODO_SHOW} 項</div>}
          </div>
        )}
      </div>
    )
  }

  const carry = data.carryWaiting ?? []
  return (
    <div className="space-y-1">
      {/* ★ 2026-10-13：上月標「計入下個月」、本月未有月結單帶入 — 之前呢度完全睇唔到 */}
      {carry.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden mb-2">
          <div className="px-3 py-2 text-xs font-medium text-violet-700 bg-violet-50">
            {monthLabel(data.fromMonth)}結轉過嚟、等緊{monthLabel(month)}月結單（{carry.length}）— 同 Lab＋醫生嘅{monthLabel(month)}月結單一上傳就自動計入
          </div>
          {carry.map((c, i) => (
            <Link key={i} href={`/lab-docs/statements/${c.docId}/sections/${c.sectionId}`} className="flex items-center justify-between gap-2 px-3 py-2 border-t text-sm hover:bg-accent/50">
              <span className="min-w-0 truncate">{c.clinicName} · {c.labName} · {c.providerName ?? '—'}</span>
              <span className="whitespace-nowrap tabular-nums">{fmtMoney(c.amount)}<span className="text-xs text-muted-foreground ml-1">（{c.count} 行）</span></span>
            </Link>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label={`${month} 月結單逐間診所`}>
        {data.clinics.map((c) => card(c.clinicId, clinicNames[c.clinicId] ?? c.clinicName, c, c.missingLabs, false, c.todo))}
        {data.clinics.length > 1 && card('', `全部（${all.reconciled + all.inProgress + all.open} 份）`, all, all.missing, true)}
      </div>
      <div className="text-[11px] text-muted-foreground">
        已對 = 嗰間診所嘅段全部確認；對數中 = 確認咗部分；未對 = 未確認（撳項目直接開嗰段）。未收到 = 嗰個月成本錄入有呢位醫生用呢間 Lab，但冇佢嘅月結單。結轉等單 = 上月標咗「計入下個月」，等緊本月同 Lab＋醫生嘅月結單。
        {data.unassigned > 0 && <span className="text-amber-700">　另有 {data.unassigned} 份未知邊間診所（未分段）。</span>}
      </div>
    </div>
  )
}
