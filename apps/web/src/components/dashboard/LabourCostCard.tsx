'use client'

import { useEffect, useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

type Run = { runId: string; clinicName: string; status: string; headcount: number; gross: number; net: number; mpfEmployee: number }
type Totals = { gross: number; net: number; mpfEmployee: number }
type LabourCostData = {
  month: string
  current: { runs: Run[]; totals: Totals }
  notInRun: { monthlyN: number; hourlyN: number; noRuleN: number; baseSalaryEstimate: number }
  previous: { month: string; runs: Run[]; totals: Totals }
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  FINALIZED: '已確認',
  EXPORTED: '已匯出',
}

/** ★ cwm-ownerdash-20260917：OWNER-only 本月人工卡 —— 預設 ＊＊＊＊，撳 👁 先顯示，唔記住 */
export function LabourCostCard() {
  const [data, setData] = useState<LabourCostData | null>(null)
  const [failed, setFailed] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [showRuns, setShowRuns] = useState(false)

  const load = () => {
    setFailed(false)
    fetch('/api/dashboard/labour-cost', { credentials: 'include', cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d: LabourCostData) => { setData(d); setReveal(false) })
      .catch(() => setFailed(true))
  }
  useEffect(load, [])

  // ★ 載入失敗顯示「載入失敗 ⟳」—— 唔准顯示 $0
  if (failed) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">💰 本月人工</span>
            <button className="text-xs text-brand hover:underline" onClick={load}>載入失敗 ⟳</button>
          </div>
        </CardContent>
      </Card>
    )
  }
  if (!data) return null

  const fmt = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
  const mask = (x: number) => (reveal ? fmt(x) : '＊＊＊＊')
  // 上月「已確認」總人工 = 只加 FINALIZED／EXPORTED 嗰幾張單
  const prevConfirmed = data.previous.runs
    .filter(r => r.status === 'FINALIZED' || r.status === 'EXPORTED')
    .reduce((s, r) => s + r.gross, 0)
  const hasPrevConfirmed = data.previous.runs.some(r => r.status === 'FINALIZED' || r.status === 'EXPORTED')
  const deltaPct = hasPrevConfirmed && prevConfirmed > 0
    ? ((data.current.totals.gross - prevConfirmed) / prevConfirmed) * 100
    : null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between">
          <span>💰 本月人工（{data.month}）</span>
          <button className="text-xs text-brand hover:underline" onClick={() => setReveal(v => !v)}>
            {reveal ? '🙈 隱藏' : '👁 顯示金額'}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="border rounded-lg p-2">
            <div className="text-[11px] text-muted-foreground">總人工（Gross）</div>
            <div className="text-lg font-bold tabular-nums">{mask(data.current.totals.gross)}</div>
          </div>
          <div className="border rounded-lg p-2">
            <div className="text-[11px] text-muted-foreground">實發（Net）</div>
            <div className="text-lg font-bold tabular-nums">{mask(data.current.totals.net)}</div>
          </div>
          <div className="border rounded-lg p-2">
            <div className="text-[11px] text-muted-foreground">僱員 MPF</div>
            <div className="text-lg font-bold tabular-nums">{mask(data.current.totals.mpfEmployee)}</div>
          </div>
        </div>

        {data.current.runs.length > 0 && (
          <div className="mt-3">
            <button className="text-xs text-brand hover:underline" onClick={() => setShowRuns(v => !v)}>
              {showRuns ? '收起 ▾' : '按店 ▸'}
            </button>
            {showRuns && (
              <div className="mt-1 space-y-1">
                {data.current.runs.map(r => (
                  <div key={r.runId} className="flex items-center justify-between text-xs px-2 py-1 rounded border bg-muted/30">
                    <span>
                      {r.clinicName}
                      <span className="ml-1 text-muted-foreground">
                        {STATUS_LABEL[r.status] ?? r.status} · {r.headcount} 人
                      </span>
                    </span>
                    <span className="tabular-nums font-medium">{mask(r.gross)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-2 text-xs text-muted-foreground">
          未入糧單：月薪 {data.notInRun.monthlyN} 人（底薪估算 {reveal ? fmt(data.notInRun.baseSalaryEstimate) : '＊＊＊＊'}）
          · 時薪 {data.notInRun.hourlyN} 人未估 · 未設薪酬 {data.notInRun.noRuleN} 人
        </div>

        <div className="mt-1 text-xs text-muted-foreground">
          上月（{data.previous.month}）已確認總人工：{hasPrevConfirmed ? mask(prevConfirmed) : '—'}
          {deltaPct != null && (
            <span className={data.current.totals.gross - prevConfirmed > 0 ? 'text-red-600' : 'text-green-600'}>
              {' '}（較上月 {deltaPct > 0 ? '+' : ''}{deltaPct.toFixed(1)}%）
            </span>
          )}
        </div>

        <div className="mt-2 text-[11px] text-muted-foreground">
          註：總人工＝糧單 Gross（含津貼／獎金／扣款）；未含僱主 MPF
        </div>
      </CardContent>
    </Card>
  )
}
