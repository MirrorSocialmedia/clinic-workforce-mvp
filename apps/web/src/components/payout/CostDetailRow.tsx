'use client'

// ============================================================
// ★ cwm-costdetail-20261006：月結預覽 —— 成本類別可撳開睇明細
//   已計入（同月結數一致）＋當月未計入提醒（未有價錢／本月落單未到貨／之前 2 個月內落單未到貨）
//   病人只出編號；每行「去成本錄入 ›」帶篩選開成本錄入頁
// ============================================================
import { useState } from 'react'

export interface CostRow {
  id: string; category: string; orderedAt: string; receivedAt: string | null; patientCode: string
  vendor: string; item: string; amount: number | null; status: string; periodMonth: string | null
  crossMonth: boolean; redo: boolean; daysWaiting?: number
}
export interface CategoryDetail {
  counted: CostRow[]; countedTotal: number; unpriced: CostRow[]; notReceived: CostRow[]
  recentNotReceived: CostRow[]; voided: CostRow[]; reminders: number
}

const money = (n: number | null) => (n == null ? '未有價錢' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const md = (d: string | null) => (d ? d.slice(5) : '—')

export function costEntryHref(r: CostRow, providerId: string, clinicId: string) {
  const qs = new URLSearchParams({ providerId, clinicId, month: r.orderedAt.slice(0, 7), dateMode: 'ordered', q: r.patientCode })
  return `/cost-entry?${qs}`
}

export function CostDetailRow({ label, amount, detail, providerId, clinicId, month, receivedBased }: {
  label: string
  amount: number
  detail: CategoryDetail | undefined
  providerId: string
  clinicId: string
  month: string
  /** LAB／INVISALIGN 以到貨日計；IMPLANT 以落單日計 */
  receivedBased: boolean
}) {
  const [open, setOpen] = useState(false)
  const [showVoid, setShowVoid] = useState(false)
  const has = !!detail && (detail.counted.length + detail.reminders + detail.voided.length) > 0
  const groups = detail ? [
    { key: 'unpriced', title: '已到貨、未有價錢（而家當 $0 計）', hint: '入咗價錢先會計入呢個月', tone: 'red', rows: detail.unpriced },
    ...(receivedBased ? [
      { key: 'notReceived', title: '本月落單、未到貨', hint: '到貨嗰個月先計；如果其實已到，請填到貨日', tone: 'amber', rows: detail.notReceived },
      { key: 'recent', title: '之前 2 個月內落單、仍未到貨', hint: '可能漏咗填到貨日；超過 2 個月嘅喺月結頁「成本異常」列出', tone: 'amber', rows: detail.recentNotReceived },
    ] : []),
  ].filter(g => g.rows.length > 0) : []

  return (
    <div className={`rounded-lg border ${open ? 'border-red-200' : 'border-transparent'}`}>
      <button type="button" onClick={() => has && setOpen(o => !o)} aria-expanded={open} disabled={!has}
        className={`w-full flex justify-between items-center gap-2 px-2 py-1.5 rounded-lg text-red-600 text-left ${has ? 'hover:bg-red-50 cursor-pointer' : 'cursor-default'} ${open ? 'bg-red-50' : ''}`}>
        <span className="flex items-center gap-2 flex-wrap">
          <span aria-hidden className="w-3 text-xs">{has ? (open ? '▾' : '▸') : ''}</span>
          {label}
          {detail && detail.counted.length > 0 && <span className="text-xs text-gray-500">已計入 {detail.counted.length} 單</span>}
          {detail && detail.reminders > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300">⚠ {detail.reminders} 項當月未計入</span>
          )}
        </span>
        <span>-${amount.toFixed(2)}</span>
      </button>

      {open && detail && (
        <div className="px-3 pb-3 pt-2 flex flex-col gap-3 border-t border-red-100">
          <div className="text-xs text-gray-500">
            {receivedBased
              ? `以到貨日計：例如 8/30 落單、9/2 到貨 → 計 9 月。只計 ${month} 到貨、有價錢、未作廢嘅單。`
              : `以落單日計。只計 ${month} 落單、有價錢、未作廢嘅單。`}
          </div>

          <div>
            <div className="text-sm font-semibold text-green-800 mb-1">✓ 已計入（{detail.counted.length} 單 · ${money(detail.countedTotal)}）</div>
            {detail.counted.length > 0
              ? <RowTable rows={detail.counted} providerId={providerId} clinicId={clinicId} showTags />
              : <div className="text-xs text-gray-500">冇</div>}
          </div>

          {groups.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-sm font-semibold text-amber-800">⚠ 當月未計入 — 請檢查有冇漏</div>
              {groups.map(g => (
                <div key={g.key} className={`rounded border ${g.tone === 'red' ? 'border-red-200' : 'border-amber-200'}`}>
                  <div className={`flex justify-between gap-2 flex-wrap px-3 py-1.5 text-sm ${g.tone === 'red' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'}`}>
                    <span className="font-semibold">{g.title}（{g.rows.length}）</span>
                    <span className="text-xs text-gray-600">{g.hint}</span>
                  </div>
                  <RowTable rows={g.rows} providerId={providerId} clinicId={clinicId} link />
                </div>
              ))}
            </div>
          )}

          {detail.voided.length > 0 && (
            <div className="text-xs text-gray-500">
              另有 {detail.voided.length} 單本月作廢（唔計）·{' '}
              <button type="button" className="underline text-blue-700" onClick={() => setShowVoid(v => !v)}>{showVoid ? '收埋' : '顯示'}</button>
              {showVoid && <div className="mt-1"><RowTable rows={detail.voided} providerId={providerId} clinicId={clinicId} /></div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RowTable({ rows, providerId, clinicId, showTags, link }: { rows: CostRow[]; providerId: string; clinicId: string; showTags?: boolean; link?: boolean }) {
  return (
    <div className="overflow-x-auto rounded border border-gray-200">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="text-left font-semibold px-2 py-1">到貨日</th>
            <th className="text-left font-semibold px-2 py-1">落單日</th>
            <th className="text-left font-semibold px-2 py-1">病人編號</th>
            <th className="text-left font-semibold px-2 py-1">工廠</th>
            <th className="text-left font-semibold px-2 py-1">項目</th>
            <th className="text-right font-semibold px-2 py-1">金額</th>
            <th className="px-2 py-1"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-gray-100">
              <td className="px-2 py-1 font-mono">{md(r.receivedAt)}</td>
              <td className="px-2 py-1 font-mono text-gray-500">{md(r.orderedAt)}</td>
              <td className="px-2 py-1 font-mono">{r.patientCode}</td>
              <td className="px-2 py-1">{r.vendor}</td>
              <td className="px-2 py-1">{r.item}</td>
              <td className={`px-2 py-1 text-right font-mono ${r.amount == null ? 'text-red-700' : ''}`}>{money(r.amount)}</td>
              <td className="px-2 py-1 whitespace-nowrap">
                {showTags && r.crossMonth && <span className="text-blue-700">{Number(r.orderedAt.slice(5, 7))} 月落單</span>}
                {showTags && r.redo && <span className="text-blue-700 ml-1">重做</span>}
                {link && <a href={costEntryHref(r, providerId, clinicId)} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">去成本錄入 ›</a>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
