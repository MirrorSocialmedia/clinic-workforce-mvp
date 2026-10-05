'use client'

// ============================================================
// ★ cwm-costdetail-20261006：醫生月結頁「成本異常」（全部醫生、診所）
//   ① 已鎖月結之後先入嘅成本（cwm-costguard-20261006）：月份月結已鎖，但呢筆冇計入 → 錢漏咗
//   ② 已到貨超過一個月仍未有價錢（cwm-lastmonth-20261006）
//   ③ 落單超過 2 個月仍未到貨
//   冇異常就成格唔出；可以收埋（記住喺 localStorage，try/catch）
// ============================================================
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'

interface Row {
  id: string; category: string; orderedAt: string; receivedAt: string | null; periodMonth: string | null
  patientCode: string; vendor: string; item: string; amount: number | null; daysWaiting?: number
  providerName: string; clinicName: string; periodLocked?: boolean
}

const CAT: Record<string, string> = { LAB: 'Lab', INVISALIGN: 'Invisalign（舊）', IMPLANT: '植牙' }
const KEY = 'payout.staleCosts.collapsed'
const money = (n: number | null) => (n == null ? '未有價錢' : n.toLocaleString('en-US', { minimumFractionDigits: 2 }))
const linkOf = (r: Row) => `/cost-entry?${new URLSearchParams({ month: r.orderedAt.slice(0, 7), dateMode: 'ordered', q: r.patientCode })}`

export function StaleCostsCard() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [orphans, setOrphans] = useState<Row[]>([])
  const [unpriced, setUnpriced] = useState<Row[]>([])
  const [days, setDays] = useState(60)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(KEY) === '1') } catch { /* 冇 storage 都照出 */ }
    apiFetch<{ days: number; rows: Row[]; orphans?: Row[]; unpriced?: Row[] }>('/api/payout-runs/stale-costs')
      .then(d => { setRows(d.rows); setOrphans(d.orphans ?? []); setUnpriced(d.unpriced ?? []); setDays(d.days) })
      .catch(() => setRows([]))
  }, [])

  if (!rows || (rows.length === 0 && orphans.length === 0 && unpriced.length === 0)) return null
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(KEY, next ? '1' : '0') } catch { /* 唔記都得 */ }
  }
  const months = Math.round(days / 30)
  const summary = [
    orphans.length > 0 ? `${orphans.length} 單成本冇計入已鎖月結` : null,
    unpriced.length > 0 ? `${unpriced.length} 單已到貨超過一個月仍未有價錢` : null,
    rows.length > 0 ? `${rows.length} 單落單超過 ${months} 個月仍未到貨` : null,
  ].filter(Boolean).join('；')

  return (
    <div className={`border rounded-lg bg-white mb-4 overflow-hidden ${(orphans.length || unpriced.length) ? 'border-red-300' : 'border-amber-300'}`} role="region" aria-label="成本異常">
      <div className={`flex items-start justify-between gap-3 px-4 py-3 ${(orphans.length || unpriced.length) ? 'bg-red-50' : 'bg-amber-50'}`}>
        <div className="flex gap-2">
          <AlertTriangle className={`h-4 w-4 shrink-0 mt-0.5 ${(orphans.length || unpriced.length) ? 'text-red-700' : 'text-amber-700'}`} />
          <div className={`text-sm font-semibold ${(orphans.length || unpriced.length) ? 'text-red-800' : 'text-amber-800'}`}>成本異常：{summary}</div>
        </div>
        <button type="button" onClick={toggle} className="text-xs border border-amber-300 rounded px-2 py-1 bg-white text-amber-800 shrink-0">{collapsed ? '展開 ▾' : '收埋 ▴'}</button>
      </div>
      {!collapsed && (
        <div className="flex flex-col">
          {orphans.length > 0 && (
            <Section tone="red" title={`已鎖月結之後先入嘅成本（${orphans.length}）`}
              hint="呢啲單所屬月份嘅月結已經鎖定，但單係之後先入（或者取消作廢），所以冇計入任何月結。請用「手動調整」喺下期補返，或者解鎖該月月結重新生成；入錯就作廢。">
              <Table rows={orphans} first={['計入月份', r => r.periodMonth ?? '—']} />
            </Section>
          )}
          {unpriced.length > 0 && (
            <Section tone="red" title={`已到貨超過一個月、仍未有價錢（${unpriced.length}）`}
              hint="到貨嗰個月嘅月結當咗 $0。月結未鎖：補價後重新生成嗰個月；已鎖：補價唔會自動計，要用「手動調整」喺下期補。上月嘅喺月結預覽「上月落單、仍未完成」提醒。">
              <Table rows={unpriced} first={['到貨月份', r => `${r.periodMonth ?? '—'}${r.periodLocked ? '（已鎖）' : ''}`]} />
            </Section>
          )}
          {rows.length > 0 && (
            <Section tone="amber" title={`落單超過 ${months} 個月仍未到貨（${rows.length}）`}
              hint="未到貨嘅單唔會計入任何月結。如果其實已經到咗，請填返到貨日；如果取消咗，請作廢。按落單日排，最舊排最前；2 個月內嘅喺每張月結預覽入面提醒。">
              <Table rows={rows} first={['已等', r => `${r.daysWaiting} 日`]} warnDays />
            </Section>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ tone, title, hint, children }: { tone: 'red' | 'amber'; title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="border-t">
      <div className={`px-4 py-2 ${tone === 'red' ? 'text-red-800' : 'text-amber-800'}`}>
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-gray-600">{hint}</div>
      </div>
      {children}
    </div>
  )
}

function Table({ rows, first, warnDays }: { rows: Row[]; first: [string, (r: Row) => string]; warnDays?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            {['落單日', first[0], '醫生', '診所', '類別', '工廠', '病人編號', '項目'].map(h => <th key={h} className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">{h}</th>)}
            <th className="text-right font-semibold px-3 py-1.5">金額</th>
            <th className="px-3 py-1.5"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-gray-100">
              <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.orderedAt}</td>
              <td className={`px-3 py-1.5 font-semibold whitespace-nowrap ${warnDays ? ((r.daysWaiting ?? 0) >= 90 ? 'text-red-700' : 'text-amber-800') : 'text-red-700'}`}>{first[1](r)}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">{r.providerName}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">{r.clinicName}</td>
              <td className="px-3 py-1.5">{CAT[r.category] ?? r.category}</td>
              <td className="px-3 py-1.5">{r.vendor}</td>
              <td className="px-3 py-1.5 font-mono">{r.patientCode}</td>
              <td className="px-3 py-1.5">{r.item}</td>
              <td className="px-3 py-1.5 text-right font-mono text-gray-600">{money(r.amount)}</td>
              <td className="px-3 py-1.5 whitespace-nowrap"><a href={linkOf(r)} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline text-xs">去成本錄入 ›</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
