'use client'

/**
 * 每日大數（cwm-dailyrev-20261003）— 醫生月結 › 每日大數
 * 揀日期（可選「至」做範圍）＋ 診所／醫生：
 *   ① 揀診所、醫生揀「全部醫生」→ 行 = 醫生（範圍內合計）
 *   ② 揀醫生 → 行 = 逐日（同醫生月結 Excel「A 逐日收款」一樣）
 * 顏色跟 Excel：藍字 = 系統帶入，黑字粗體 = 合計，灰字 = 唔計，黃底 = 最終金額。
 * 數字同 Excel 匯出同一個 API（/api/payout-runs/daily），唔准前端自己計。
 */
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ArrowLeft, Download } from 'lucide-react'
import { todayHK, addDaysStr } from '@/lib/hk-date'
import type { DailyReport, DailyRow } from '@/lib/payout/daily-report'

const SECTION = '#1F4E79'
const BLUE = '#0000ff'
const GRAY = '#808080'

const money = (n: number | null | undefined): string =>
  n ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''

function weekStartOf(d: string): string {
  const dow = new Date(`${d}T12:00:00+08:00`).getUTCDay()
  return addDaysStr(d, dow === 0 ? -6 : 1 - dow)
}

export default function DailyRevenuePage() {
  const today = todayHK()
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState('')
  const [clinicId, setClinicId] = useState('')
  const [providerId, setProviderId] = useState('')
  const [clinics, setClinics] = useState<{ id: string; name: string; shortName?: string | null; apricotClinicId?: string | null }[]>([])
  const [providers, setProviders] = useState<{ id: string; name: string; isActive?: boolean }[]>([])
  const [report, setReport] = useState<DailyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([apiFetch<any>('/api/clinics'), apiFetch<any>('/api/providers')])
      .then(([c, p]) => {
        const cl = (c.clinics || []).filter((x: any) => x.apricotClinicId)
        setClinics(cl)
        setProviders((p.providers || []).filter((x: any) => x.isActive !== false))
        if (cl.length && !clinicId) setClinicId(cl[0].id)
      })
      .catch(e => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const query = useMemo(() => {
    const q = new URLSearchParams({ from })
    if (to && to !== from) q.set('to', to)
    if (clinicId) q.set('clinicId', clinicId)
    if (providerId) q.set('providerId', providerId)
    return q.toString()
  }, [from, to, clinicId, providerId])

  useEffect(() => {
    if (!from || (!clinicId && !providerId)) { setReport(null); return }
    let cancelled = false
    setLoading(true)
    setError('')
    apiFetch<DailyReport>(`/api/payout-runs/daily?${query}`)
      .then(r => { if (!cancelled) setReport(r) })
      .catch(e => { if (!cancelled) { setReport(null); setError(e.message) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, from, clinicId, providerId])

  const quick = (kind: 'today' | 'week' | 'month') => {
    if (kind === 'today') { setFrom(today); setTo(''); return }
    if (kind === 'week') { setFrom(weekStartOf(today)); setTo(today); return }
    setFrom(`${today.slice(0, 7)}-01`); setTo(today)
  }

  const th: React.CSSProperties = { border: '1px solid #d9dee4', padding: '7px 9px', background: '#f3f5f8', fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12, textTransform: 'none', letterSpacing: 'normal' }
  const td = (color: string, extra: React.CSSProperties = {}): React.CSSProperties => ({
    border: '1px solid #d9dee4', padding: '7px 9px', textAlign: 'right', whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums', color, ...extra,
  })
  const firstCol = report?.mode === 'byDoctor' ? '醫生' : '日期'
  const isEmptyRow = (r: DailyRow) => r.storeTotal === 0 && r.doctorRaw === 0 && Object.values(r.byMethod).every(v => v === 0)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
        <a href="/payout" className="flex items-center gap-1 hover:text-gray-800"><ArrowLeft size={14} /> 醫生月結</a>
        <span>›</span><span className="text-gray-900 font-semibold">每日大數</span>
      </div>
      <h1 className="text-2xl font-bold mb-4">每日大數</h1>

      <Card className="p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1 text-xs text-gray-600">日期
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-10 px-2 border rounded-md text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600">至（選填 — 揀範圍）
            <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="h-10 px-2 border rounded-md text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600">診所
            <select value={clinicId} onChange={e => setClinicId(e.target.value)} className="h-10 px-2 border rounded-md text-sm min-w-[140px]">
              <option value="">全部診所{providerId ? '' : '（要揀醫生）'}</option>
              {clinics.map(c => <option key={c.id} value={c.id}>{c.shortName || c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-600">醫生
            <select value={providerId} onChange={e => setProviderId(e.target.value)} className="h-10 px-2 border rounded-md text-sm min-w-[160px]">
              <option value="">全部醫生（逐醫生）</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => quick('today')}>今日</Button>
            <Button variant="outline" onClick={() => quick('week')}>今個星期</Button>
            <Button variant="outline" onClick={() => quick('month')}>今個月</Button>
          </div>
          <div className="flex-1" />
          <a href={report ? `/api/payout-runs/daily?${query}&format=xlsx` : undefined} aria-disabled={!report}>
            <Button variant="outline" disabled={!report}><Download size={14} className="mr-1" /> 匯出 Excel</Button>
          </a>
        </div>
        {!clinicId && !providerId && <div className="text-xs text-amber-700 mt-2">「全部診所」要揀醫生先睇到（逐日）；或者揀一間診所睇逐醫生。</div>}
      </Card>

      {error && <div className="p-3 mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md">⚠️ {error}</div>}
      {loading && <div className="p-6 text-gray-500">載入中...</div>}

      {report && !loading && (
        <Card className="overflow-hidden mb-4">
          <div className="px-4 py-3 flex items-baseline gap-3 flex-wrap">
            <div className="text-lg font-bold">{report.title}</div>
            <div className="text-xs text-gray-500">{report.mode === 'byDoctor' ? '行 = 醫生（撳醫生名睇逐日）' : '行 = 逐日'}</div>
          </div>

          <div style={{ background: SECTION, color: '#fff', fontWeight: 700, fontSize: 13, padding: '6px 16px' }}>
            {report.mode === 'byDoctor' ? 'A  逐醫生收款' : 'A  逐日收款'}
          </div>
          <div className="overflow-x-auto">
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>{firstCol}</th>
                  {report.methods.map(m => (
                    <th key={m.key} style={{ ...th, color: m.storeIncome || m.doctorIncome ? undefined : GRAY }}>{m.label}</th>
                  ))}
                  <th style={th}>TOTAL</th>
                  <th style={th}>SP 筆數</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.length === 0 && (
                  <tr><td colSpan={report.methods.length + 3} style={{ ...td(GRAY), textAlign: 'center', padding: 24 }}>呢段日子冇收款</td></tr>
                )}
                {report.rows.map(r => (
                  <tr key={r.key} style={report.mode === 'byDay' && isEmptyRow(r) ? { background: '#f3f4f6' } : undefined}>
                    <td style={td(BLUE, { textAlign: 'left' })}>
                      {report.mode === 'byDoctor' && !r.key.startsWith('ext:')
                        ? <button type="button" className="hover:underline" style={{ color: BLUE }} onClick={() => setProviderId(r.key)}>{r.label}</button>
                        : r.label}
                    </td>
                    {report.methods.map(m => (
                      <td key={m.key} style={td(m.storeIncome || m.doctorIncome ? BLUE : GRAY)}>{money(r.byMethod[m.key])}</td>
                    ))}
                    <td style={td('#000')}>{money(r.storeTotal)}</td>
                    <td style={td(BLUE, { textAlign: 'center' })}>{r.spCount || ''}</td>
                  </tr>
                ))}
                <tr>
                  <td style={td('#000', { textAlign: 'left', fontWeight: 700 })}>Total</td>
                  {report.methods.map(m => (
                    <td key={m.key} style={td(m.storeIncome || m.doctorIncome ? '#000' : GRAY, { fontWeight: 700 })}>{money(report.totals.byMethod[m.key])}</td>
                  ))}
                  <td style={td('#000', { fontWeight: 700, background: '#ffff00' })}>{money(report.totals.storeTotal) || '$0.00'}</td>
                  <td style={td('#000', { fontWeight: 700, textAlign: 'center' })}>{report.totals.spCount}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ background: SECTION, color: '#fff', fontWeight: 700, fontSize: 13, padding: '6px 16px', marginTop: 16 }}>
            B  醫生收入及分成（未扣成本）
          </div>
          <div className="overflow-x-auto">
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>{firstCol}</th>
                  <th style={th}>收款（醫生收入）</th>
                  <th style={th}>手續費</th>
                  <th style={th}>收入淨額</th>
                  <th style={th}>醫生分成{report.percent != null ? `（${report.percent}%）` : ''}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.filter(r => report.mode === 'byDoctor' || !isEmptyRow(r)).map(r => (
                  <tr key={r.key}>
                    <td style={td(BLUE, { textAlign: 'left' })}>{r.label}</td>
                    <td style={td(BLUE)}>{money(r.doctorRaw)}</td>
                    <td style={td('#000')}>{money(Math.round((r.doctorRaw - r.doctorNet) * 100) / 100)}</td>
                    <td style={td(BLUE)}>{money(r.doctorNet)}</td>
                    <td style={td(r.share == null ? GRAY : BLUE)}>{r.share == null ? '未設拆帳' : money(r.share)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={td('#000', { textAlign: 'left', fontWeight: 700 })}>Total</td>
                  <td style={td('#000', { fontWeight: 700 })}>{money(report.totals.doctorRaw)}</td>
                  <td style={td('#000', { fontWeight: 700 })}>{money(Math.round((report.totals.doctorRaw - report.totals.doctorNet) * 100) / 100)}</td>
                  <td style={td('#000', { fontWeight: 700 })}>{money(report.totals.doctorNet)}</td>
                  <td style={td('#000', { fontWeight: 700, background: '#ffff00' })}>{money(report.totals.share) || '$0.00'}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 text-xs text-gray-500 space-y-1 border-t">
            <div>TOTAL = 店舖營收（只計計入營收嘅付款方式）；灰字欄唔計。顏色同醫生月結 Excel 一樣：藍字 = 系統帶入，黑字粗體 = 合計，黃底 = 最終金額。</div>
            <div>醫生分成 = 收入淨額 × 拆帳比例；<b>未扣 Lab／植牙成本，未計 SP 補貼／轉介／調整</b> —— 實際應付以月結單為準。</div>
            {report.missingCommission.length > 0 && <div className="text-amber-700">未設拆帳（分成冇計）：{report.missingCommission.join('、')}</div>}
          </div>
        </Card>
      )}
    </div>
  )
}
