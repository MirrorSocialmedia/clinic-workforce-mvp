'use client'

// ============================================================
// ★ cwm-costdetail-20261006：醫生月結頁「成本異常」—— 落單超過 2 個月仍未到貨（全部醫生、診所）
//   冇異常就成格唔出；可以收埋（記住喺 localStorage，try/catch）
// ============================================================
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'

interface StaleRow {
  id: string; category: string; orderedAt: string; patientCode: string; vendor: string; item: string
  amount: number | null; daysWaiting?: number; providerName: string; clinicName: string
}

const CAT: Record<string, string> = { LAB: 'Lab', INVISALIGN: 'Invisalign', IMPLANT: 'Implant' }
const KEY = 'payout.staleCosts.collapsed'

export function StaleCostsCard() {
  const [rows, setRows] = useState<StaleRow[] | null>(null)
  const [days, setDays] = useState(60)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(KEY) === '1') } catch { /* 冇 storage 都照出 */ }
    apiFetch<{ days: number; rows: StaleRow[] }>('/api/payout-runs/stale-costs')
      .then(d => { setRows(d.rows); setDays(d.days) })
      .catch(() => setRows([]))
  }, [])

  if (!rows || rows.length === 0) return null
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(KEY, next ? '1' : '0') } catch { /* 唔記都得 */ }
  }

  return (
    <div className="border border-amber-300 rounded-lg bg-white mb-4 overflow-hidden" role="region" aria-label="成本異常">
      <div className="flex items-start justify-between gap-3 px-4 py-3 bg-amber-50">
        <div className="flex gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
          <div>
            <div className="text-sm font-semibold text-amber-800">成本異常：{rows.length} 單落單超過 {Math.round(days / 30)} 個月仍未到貨</div>
            <div className="text-xs text-gray-600">未到貨嘅單唔會計入任何月結。如果其實已經到咗，請填返到貨日；如果取消咗，請作廢。</div>
          </div>
        </div>
        <button type="button" onClick={toggle} className="text-xs border border-amber-300 rounded px-2 py-1 bg-white text-amber-800 shrink-0">{collapsed ? '展開 ▾' : '收埋 ▴'}</button>
      </div>
      {!collapsed && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                {['落單日', '已等', '醫生', '診所', '類別', '工廠', '病人編號', '項目'].map(h => <th key={h} className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">{h}</th>)}
                <th className="text-right font-semibold px-3 py-1.5">金額</th>
                <th className="px-3 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const qs = new URLSearchParams({ month: r.orderedAt.slice(0, 7), dateMode: 'ordered', q: r.patientCode })
                return (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.orderedAt}</td>
                    <td className={`px-3 py-1.5 font-semibold whitespace-nowrap ${(r.daysWaiting ?? 0) >= 90 ? 'text-red-700' : 'text-amber-800'}`}>{r.daysWaiting} 日</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.providerName}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.clinicName}</td>
                    <td className="px-3 py-1.5">{CAT[r.category] ?? r.category}</td>
                    <td className="px-3 py-1.5">{r.vendor}</td>
                    <td className="px-3 py-1.5 font-mono">{r.patientCode}</td>
                    <td className="px-3 py-1.5">{r.item}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-600">{r.amount == null ? '未有價錢' : r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap"><a href={`/cost-entry?${qs}`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline text-xs">去成本錄入 ›</a></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="px-4 py-2 text-xs text-gray-500 border-t">按落單日排，最舊排最前 · 已作廢嘅唔會出 · 2 個月內嘅喺每張月結預覽入面提醒</div>
        </div>
      )}
    </div>
  )
}
