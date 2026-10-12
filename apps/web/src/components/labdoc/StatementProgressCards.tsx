'use client'

// ============================================================
// ★ cwm-labstmtprog-20261012：Lab 單據 · 月結單 —— 某月逐間診所「已對／對數中／未對＋未收到」
//   撳卡 = 下面列表只睇嗰間（再撳一次取消）。計法：lib/labdoc/statement-progress.ts
// ============================================================
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

interface Row { clinicId: string; clinicName: string; reconciled: number; inProgress: number; open: number; missingLabs: string[] }
interface Resp { month: string; clinics: Row[]; unassigned: number }

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
  const card = (key: string, title: string, c: { reconciled: number; inProgress: number; open: number }, missing: string[] | number, dashed = false) => {
    const total = c.reconciled + c.inProgress + c.open
    const missN = Array.isArray(missing) ? missing.length : missing
    const left = c.inProgress + c.open + missN
    const sel = key !== '' && selected === key
    return (
      <button
        key={key || 'all'}
        type="button"
        onClick={() => key && onPick(sel ? '' : key)}
        className={`text-left rounded-xl border-2 px-3 py-2 min-w-[170px] bg-card text-xs leading-relaxed ${dashed ? 'border-dashed cursor-default' : 'hover:bg-accent'} ${sel ? 'border-[#2f6b68] ring-2 ring-[#cfe5e3]' : 'border-border'}`}
        aria-pressed={sel}
      >
        <div className="flex items-baseline justify-between gap-2">
          <b className="text-sm">{title}</b>
          {left === 0 ? <span className="text-green-700 font-semibold">✓ 全部已對</span> : <span className="text-amber-700 font-semibold">仲有 {left} 份</span>}
        </div>
        <div className="flex h-1.5 rounded-full overflow-hidden bg-muted my-1">
          <i className="block h-full bg-green-600" style={{ width: pct(c.reconciled, total) }} />
          <i className="block h-full bg-indigo-500" style={{ width: pct(c.inProgress, total) }} />
          <i className="block h-full bg-amber-500" style={{ width: pct(c.open, total) }} />
        </div>
        <div>
          已對 {c.reconciled} · <span className="text-indigo-700">對數中 {c.inProgress}</span> · <span className="text-amber-700">未對 {c.open}</span>
        </div>
        {missN > 0 && (
          <div className="text-red-700">
            未收到 {missN}{Array.isArray(missing) ? `：${missing.join('、')}` : ''}
          </div>
        )}
      </button>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2" role="group" aria-label={`${month} 月結單逐間診所`}>
        {data.clinics.map((c) => card(c.clinicId, clinicNames[c.clinicId] ?? c.clinicName, c, c.missingLabs))}
        {data.clinics.length > 1 && card('', `全部（${all.reconciled + all.inProgress + all.open} 份）`, all, all.missing, true)}
      </div>
      <div className="text-[11px] text-muted-foreground">
        已對 = 嗰間診所嘅段全部確認；對數中 = 確認咗部分；未對 = 未確認。未收到 = 嗰個月有 Lab 成本但冇嗰間 Lab 嘅月結單。
        {data.unassigned > 0 && <span className="text-amber-700">　另有 {data.unassigned} 份未知邊間診所（未分段）。</span>}
      </div>
    </div>
  )
}
