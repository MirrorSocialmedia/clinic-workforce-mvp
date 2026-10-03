'use client'

import { useEffect, useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

type Run = { runId: string; clinicName: string; status: string; headcount: number; gross: number; net: number; mpfEmployee: number }
type Totals = { gross: number; net: number; mpfEmployee: number }
type Period = { month: string; runs: Run[]; totals: Totals }
type LabourCostData = {
  month: string
  latest: Period | null
  beforeLatest: Period | null
  estimate: {
    month: string; inRunN: number
    monthlyN: number; monthlyBase: number
    hourlyN: number; hourlyHours: number; hourlyAmount: number
    noRuleN: number; total: number
  }
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  FINALIZED: '已確認',
  EXPORTED: '已匯出',
}
const isConfirmed = (r: Run) => r.status === 'FINALIZED' || r.status === 'EXPORTED'

/**
 * ★ cwm-ownerdash-20260917：OWNER-only 人工卡 —— 預設 ＊＊＊＊，撳 👁 先顯示，唔記住
 * ★ cwm-labourfix-20261003：舊版淨係睇「本月」糧單（月尾先出）→ 永遠 $0。
 *   而家：① 最近一期糧單實數 ② 本月預計（未出糧單嘅人：月薪底薪＋時薪按排更）
 */
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
            <span className="text-sm text-muted-foreground">💰 人工</span>
            <button className="text-xs text-brand hover:underline" onClick={load}>載入失敗 ⟳</button>
          </div>
        </CardContent>
      </Card>
    )
  }
  if (!data) return null

  const fmt = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
  const mask = (x: number) => (reveal ? fmt(x) : '＊＊＊＊')
  const latest = data.latest
  const latestAllConfirmed = !!latest && latest.runs.length > 0 && latest.runs.every(isConfirmed)
  // 對比：再上一期「已確認」總人工
  const prevConfirmedRuns = data.beforeLatest?.runs.filter(isConfirmed) ?? []
  const prevConfirmed = prevConfirmedRuns.reduce((s, r) => s + r.gross, 0)
  const deltaPct = latest && prevConfirmedRuns.length > 0 && prevConfirmed > 0
    ? ((latest.totals.gross - prevConfirmed) / prevConfirmed) * 100
    : null
  const est = data.estimate
  const showEstimate = est.monthlyN + est.hourlyN + est.noRuleN > 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between">
          <span>💰 人工</span>
          <button className="text-xs text-brand hover:underline" onClick={() => setReveal(v => !v)}>
            {reveal ? '🙈 隱藏' : '👁 顯示金額'}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* ① 最近一期糧單 */}
        <div className="text-xs text-muted-foreground mb-1">
          {latest
            ? <>最近糧單（{latest.month}）· {latestAllConfirmed ? '已確認' : '含草稿'}</>
            : '仲未有任何糧單'}
        </div>
        {latest && (
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="border rounded-lg p-2">
              <div className="text-[11px] text-muted-foreground">總人工（Gross）</div>
              <div className="text-lg font-bold tabular-nums">{mask(latest.totals.gross)}</div>
            </div>
            <div className="border rounded-lg p-2">
              <div className="text-[11px] text-muted-foreground">實發（Net）</div>
              <div className="text-lg font-bold tabular-nums">{mask(latest.totals.net)}</div>
            </div>
            <div className="border rounded-lg p-2">
              <div className="text-[11px] text-muted-foreground">僱員 MPF</div>
              <div className="text-lg font-bold tabular-nums">{mask(latest.totals.mpfEmployee)}</div>
            </div>
          </div>
        )}

        {latest && latest.runs.length > 0 && (
          <div className="mt-2">
            <button className="text-xs text-brand hover:underline" onClick={() => setShowRuns(v => !v)}>
              {showRuns ? '收起 ▾' : '按店 ▸'}
            </button>
            {showRuns && (
              <div className="mt-1 space-y-1">
                {latest.runs.map(r => (
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

        {latest && (
          <div className="mt-1 text-xs text-muted-foreground">
            對比上一期（{data.beforeLatest?.month}）已確認：{prevConfirmedRuns.length > 0 ? mask(prevConfirmed) : '—'}
            {deltaPct != null && (
              <span className={latest.totals.gross - prevConfirmed > 0 ? 'text-red-600' : 'text-green-600'}>
                {' '}（{deltaPct > 0 ? '+' : ''}{deltaPct.toFixed(1)}%）
              </span>
            )}
          </div>
        )}

        {/* ② 本月預計 */}
        {showEstimate && (
          <div className="mt-3 border-t pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                本月預計（{est.month}{est.inRunN > 0 ? `，已出糧單 ${est.inRunN} 人以外` : '，未出糧單'}）
              </span>
              <span className="text-base font-bold tabular-nums">{mask(est.total)}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              月薪底薪 {est.monthlyN} 人 {mask(est.monthlyBase)}
              {' '}· 時薪按排更 {est.hourlyN} 人 {est.hourlyHours}h {mask(est.hourlyAmount)}
              {est.noRuleN > 0 && <> · <span className="text-amber-700">未設薪酬 {est.noRuleN} 人</span></>}
            </div>
          </div>
        )}

        <div className="mt-2 text-[11px] text-muted-foreground">
          註：總人工＝糧單 Gross（含津貼／獎金／扣款）；未含僱主 MPF。本月預計未計 OT／津貼／扣款／MPF，出糧單後以糧單為準。
        </div>
      </CardContent>
    </Card>
  )
}
