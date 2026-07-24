'use client'

import { useEffect, useState } from 'react'

interface Props {
  employeeId: string
  /** Specified date; defaults to today. Payroll detail page passes month first day. */
  asOfDate?: string
  /** Compact mode (payroll detail page: show number only, no detail table). */
  compact?: boolean
}

export function ADWCard({ employeeId, asOfDate, compact }: Props) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const d = asOfDate || new Date().toISOString().slice(0, 10)
    setLoading(true)
    fetch(`/api/adw/preview?employeeId=${employeeId}&date=${d}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .finally(() => setLoading(false))
      .catch(() => { setData(null); setLoading(false) })
  }, [employeeId, asOfDate])

  if (loading) return null
  if (!data) return null

  return (
    <div className="rounded-lg border bg-card p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold">
            12個月平均工資 (ADW)
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600">
            《僱傭條例》713
          </span>
        </div>
        {!compact && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-blue-600 hover:underline cursor-pointer"
            type="button"
          >
            {expanded ? '收起明細' : '展開明細'}
          </button>
        )}
      </div>

      {/* Main number */}
      <div className="flex items-baseline gap-3 mb-1">
        <span className="text-3xl font-bold font-mono">
          ${data.adw.toFixed(2)}
        </span>
        <span className="text-sm text-muted-foreground">/ 天</span>
        {data.isShortPeriod && (
          <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
            受僱不足12個月
          </span>
        )}
      </div>

      {/* Calculation formula */}
      <div className="text-xs text-muted-foreground mb-3">
        ${data.totalWage.toLocaleString()} ÷ {data.totalDays} 天
        <span className="mx-2">·</span>
        期間 {data.periodStart} ~ {data.periodEnd}
      </div>

      {/* Holiday pay conversions */}
      <div className="grid grid-cols-2 gap-2 text-sm border-t pt-3">
        <div className="flex justify-between">
          <span className="text-muted-foreground">法定假日 / 年假</span>
          <span className="font-mono">${data.adw.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">病假 (4/5)</span>
          <span className="font-mono">${(data.adw * 0.8).toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">產假 (4/5)</span>
          <span className="font-mono">${(data.adw * 0.8).toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">侍產假 (4/5)</span>
          <span className="font-mono">${(data.adw * 0.8).toFixed(2)}</span>
        </div>
      </div>

      {/* Warnings */}
      {data.warnings?.length > 0 && (
        <div className="mt-3 space-y-1">
          {data.warnings.map((w: string, i: number) => (
            <div
              key={i}
              className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1"
            >
              ⚠️ {w}
            </div>
          ))}
        </div>
      )}

      {/* Detail table (expandable) */}
      {expanded && !compact && (
        <div className="mt-3 border-t pt-3">
          <div className="text-xs font-medium mb-2">工資記錄明細</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b">
                <th className="text-left py-1">月份</th>
                <th className="text-right">工資</th>
                <th className="text-right">剔除天</th>
                <th className="text-right">剔除額</th>
                <th className="text-right">計入天</th>
                <th className="text-left pl-2">來源</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s: any) => (
                <tr key={s.periodMonth} className="border-b last:border-0">
                  <td className="py-1">{s.periodMonth}</td>
                  <td className="text-right font-mono">
                    ${s.wage.toLocaleString()}
                  </td>
                  <td className="text-right">{s.excludedDays || '—'}</td>
                  <td className="text-right font-mono">
                    {s.excludedWage ? `$${s.excludedWage.toLocaleString()}` : '—'}
                  </td>
                  <td className="text-right">
                    {s.calendarDays - s.excludedDays}
                  </td>
                  <td className="pl-2">
                    {s.source === 'PayrollItem' ? (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                        系統
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                        補錄
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {/* Total row */}
              <tr className="font-medium">
                <td className="py-1">合計</td>
                <td className="text-right font-mono">
                  ${data.totalWage.toLocaleString()}
                </td>
                <td colSpan={2} />
                <td className="text-right">{data.totalDays}</td>
                <td />
              </tr>
            </tbody>
          </table>
          <div className="text-xs text-muted-foreground mt-2">
            「系統」＝已確認計糧自動記錄 ｜ 「補錄」＝系統啟用前人手輸入
          </div>
        </div>
      )}
    </div>
  )
}
