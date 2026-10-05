'use client'

// ============================================================
// ★ cwm-reconclinic-20261006：月報對數 —— 全店報表
//   ① 對應面板：報表每個 Practitioner 名 → 醫生（已記住／單號建議預填；未揀齊唔可以對數）
//   ② 結果卡：全店合計＋逐個醫生＋系統有報表冇＋略過嘅名
// ============================================================
import { useMemo, useState } from 'react'

export interface PractitionerResolution {
  name: string; nameNorm: string; count: number; total: number
  providerId: string | null; providerName: string | null
  suggestion: { providerId: string; providerName: string; matched: number; total: number } | null
}
export interface ClinicWideResult {
  clinic: string; month: string
  results: Array<{ providerId: string; providerName: string; reportNames: string[]; status: string; reportTotal: number; systemTotal: number; difference: number }>
  skippedGroups: Array<{ name: string; total: number; count: number }>
  missing: Array<{ providerId: string; providerName: string; systemTotal: number }>
  totals: { report: number; system: number; skippedReport: number }
}

export const SKIP = '__SKIP__'
const fmt = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${fmt(v)}`

export function ClinicMappingPanel({ clinic, month, practitioners, providers, busy, onSubmit, onCancel }: {
  clinic: string; month: string
  practitioners: PractitionerResolution[]
  providers: Array<{ id: string; name: string; shortName: string | null }>
  busy: boolean
  onSubmit: (mapping: Record<string, string>, remember: boolean) => void
  onCancel: () => void
}) {
  const [picks, setPicks] = useState<Record<string, string>>(() =>
    Object.fromEntries(practitioners.filter(p => !p.providerId).map(p => [p.nameNorm, p.suggestion?.providerId ?? ''])))
  const [remember, setRemember] = useState(true)
  const unknown = practitioners.filter(p => !p.providerId)
  const known = practitioners.filter(p => p.providerId)
  const ready = unknown.every(p => !!picks[p.nameNorm])
  const total = useMemo(() => practitioners.reduce((a, p) => a + p.total, 0), [practitioners])

  return (
    <div className="w-full p-4 bg-blue-50 rounded-lg border border-blue-200 flex flex-col gap-3" role="region" aria-label="全店報表醫生對應">
      <div className="text-sm">
        <b>全店報表</b> · {clinic} · {month} · {practitioners.length} 位醫生 · 實收 {fmt(total)}
      </div>
      {unknown.length > 0 && (
        <div className="text-sm text-gray-700">
          有 {unknown.length} 個名第一次見到。系統用報表單號對返 Apricot 帳單，搵到係邊個醫生嘅帳號；請確認一次，之後同一個名會自動對。
        </div>
      )}
      <div className="overflow-x-auto bg-white rounded border">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="text-left p-2">報表名（Practitioner）</th>
              <th className="text-right p-2">筆數</th>
              <th className="text-right p-2">實收</th>
              <th className="text-left p-2">對應醫生</th>
              <th className="text-left p-2"></th>
            </tr>
          </thead>
          <tbody>
            {unknown.map(p => (
              <tr key={p.nameNorm} className="border-t">
                <td className="p-2 font-medium">{p.name}</td>
                <td className="p-2 text-right tabular-nums">{p.count}</td>
                <td className="p-2 text-right tabular-nums">{fmt(p.total)}</td>
                <td className="p-2">
                  <select aria-label={`${p.name} 對應醫生`} value={picks[p.nameNorm] ?? ''} disabled={busy}
                    onChange={e => setPicks(prev => ({ ...prev, [p.nameNorm]: e.target.value }))}
                    className={`border rounded px-2 py-1 text-sm bg-white ${picks[p.nameNorm] ? 'border-green-600' : 'border-amber-500'}`}>
                    <option value="">— 請揀醫生 —</option>
                    {providers.map(pr => <option key={pr.id} value={pr.id}>{pr.name}{pr.shortName ? ` (${pr.shortName})` : ''}</option>)}
                    <option value={SKIP}>唔屬任何醫生（略過，唔對數）</option>
                  </select>
                </td>
                <td className="p-2 text-xs">
                  {p.suggestion
                    ? <span className="text-green-700">✓ {p.suggestion.matched}／{p.suggestion.total} 張單號對到 {p.suggestion.providerName}</span>
                    : <span className="text-amber-700">⚠ 單號未同步到系統，請人手揀</span>}
                </td>
              </tr>
            ))}
            {known.map(p => (
              <tr key={p.nameNorm} className="border-t text-gray-600">
                <td className="p-2">{p.name}</td>
                <td className="p-2 text-right tabular-nums">{p.count}</td>
                <td className="p-2 text-right tabular-nums">{fmt(p.total)}</td>
                <td className="p-2">{p.providerName}</td>
                <td className="p-2 text-xs text-gray-500">已記住（醫生管理可改）</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {unknown.length > 0
          ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />記住呢啲對應（存入醫生管理「Apricot 報表名」）</label>
          : <span />}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="h-9 px-3 rounded border text-sm bg-white">取消</button>
          <button type="button" onClick={() => onSubmit(picks, remember)} disabled={busy || !ready}
            className="h-9 px-4 rounded bg-blue-700 text-white text-sm font-semibold disabled:opacity-50">{busy ? '對數中…' : '確認並對數'}</button>
        </div>
      </div>
      {!ready && <div className="text-xs text-amber-800">未揀齊醫生唔可以對數（避免漏數）。</div>}
    </div>
  )
}

export function ClinicWideSummary({ r, onClose }: { r: ClinicWideResult; onClose: () => void }) {
  const diff = Math.round((r.totals.report - r.totals.system) * 100) / 100
  const bad = r.results.filter(x => x.status !== 'MATCH').length
  return (
    <div className="border rounded-lg bg-white mb-4 overflow-hidden" role="region" aria-label="全店對數結果">
      <div className="flex justify-between items-center px-4 py-3 bg-gray-50 border-b">
        <b>全店對數 · {r.clinic} · {r.month}</b>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 underline">收埋</button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
        <Stat label="Apricot 報表合計" value={fmt(r.totals.report)} />
        <Stat label="系統合計" value={fmt(r.totals.system)} />
        <Stat label="全店差異" value={signed(diff)} tone={Math.abs(diff) > 1 ? 'bad' : 'ok'}
          sub={`${r.results.length} 位醫生：${r.results.length - bad} 吻合${bad ? `、${bad} 唔夾` : ''}`} />
        <Stat label="略過（唔屬任何醫生）" value={fmt(r.totals.skippedReport)} sub={r.skippedGroups.map(g => g.name).join('、') || '—'} />
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr><th className="text-left p-2">醫生</th><th className="text-left p-2">報表名</th><th className="text-right p-2">系統</th><th className="text-right p-2">Apricot</th><th className="text-right p-2">差異</th><th className="text-left p-2">狀態</th></tr>
        </thead>
        <tbody>
          {r.results.map(x => (
            <tr key={x.providerId} className={`border-t ${x.status !== 'MATCH' ? 'bg-red-50' : ''}`}>
              <td className="p-2 font-medium">{x.providerName}</td>
              <td className="p-2 text-xs text-gray-600">{x.reportNames.join('、')}</td>
              <td className="p-2 text-right tabular-nums">{fmt(x.systemTotal)}</td>
              <td className="p-2 text-right tabular-nums">{fmt(x.reportTotal)}</td>
              <td className={`p-2 text-right tabular-nums font-semibold ${x.status !== 'MATCH' ? 'text-red-700' : 'text-green-700'}`}>{signed(x.difference)}</td>
              <td className="p-2">{x.status === 'MATCH' ? <span className="text-green-700">✓ 吻合</span> : <span className="text-red-700">✗ 唔夾</span>}</td>
            </tr>
          ))}
          {r.missing.map(m => (
            <tr key={m.providerId} className="border-t bg-amber-50">
              <td className="p-2 font-medium">{m.providerName}</td>
              <td className="p-2 text-xs text-amber-800">報表冇呢位醫生</td>
              <td className="p-2 text-right tabular-nums">{fmt(m.systemTotal)}</td>
              <td className="p-2 text-right">—</td>
              <td className="p-2 text-right">—</td>
              <td className="p-2 text-amber-800 text-xs">⚠ 系統有收入、報表冇：可能入錯醫生或者入錯店</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 py-2 text-xs text-gray-500 border-t">逐個醫生嘅結果已經存入下面列表（同單一醫生上載一樣），醫生月結頁照用；唔夾嘅可以撳「差異明細」睇逐日／逐方式。</div>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className={`rounded border p-3 ${tone === 'bad' ? 'bg-red-50 border-red-200' : ''}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${tone === 'bad' ? 'text-red-700' : tone === 'ok' ? 'text-green-700' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 truncate" title={sub}>{sub}</div>}
    </div>
  )
}
