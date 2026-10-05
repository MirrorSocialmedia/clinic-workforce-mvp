'use client'

// ============================================================
// ★ cwm-chequerec-20261005：支票紀錄（只限老闆；API RBAC = OWNER）
//   每張印過嘅票（員工／醫生／Lab，連作廢）—— 跨月份、跨戶口搵；匯出 Excel（全部／作廢／合計三個 sheet）
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api-client'
import { todayHK } from '@/lib/hk-date'

type Kind = 'PAYROLL_ITEM' | 'PAYOUT_RUN' | 'LAB_AMOUNT'
interface Rec {
  id: string; chequeNo: string; chequeDate: string; periodMonth: string; kind: Kind; payeeName: string; refLabel: string
  clinicName: string; accountLabel: string; amount: number; status: string; confirmed: boolean
  printedByName: string; printedAt: string; voidReason: string | null; voidedAt: string | null
}
interface Summary {
  byKind: Array<{ kind: Kind; label: string; count: number; amount: number }>
  printed: { count: number; amount: number }
  void: { count: number; amount: number }
}
interface Resp { rows: Rec[]; summary: Summary; truncated: boolean; maxRows: number; accounts: Array<{ id: string; label: string; accountLast4: string | null }> }

const KIND_LABEL: Record<Kind, string> = { PAYROLL_ITEM: '員工', PAYOUT_RUN: '醫生', LAB_AMOUNT: 'Lab' }
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const hkTime = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
}

function monthOptions(n = 24): string[] {
  const t = todayHK()
  let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7))
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m--; if (m === 0) { m = 12; y-- }
  }
  return out
}

export default function ChequeRecordsPage() {
  const months = useMemo(() => monthOptions(), [])
  const [from, setFrom] = useState(months[1])
  const [to, setTo] = useState(months[0])
  const [accountId, setAccountId] = useState('')
  const [kind, setKind] = useState<Kind | ''>('')
  const [status, setStatus] = useState<'' | 'PRINTED' | 'VOID'>('')
  const [q, setQ] = useState('')
  const [qApplied, setQApplied] = useState('')
  const [data, setData] = useState<Resp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const query = useMemo(() => {
    const sp = new URLSearchParams({ from, to })
    if (accountId) sp.set('accountId', accountId)
    if (kind) sp.set('kind', kind)
    if (status) sp.set('status', status)
    if (qApplied) sp.set('q', qApplied)
    return sp.toString()
  }, [from, to, accountId, kind, status, qApplied])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      setData(await apiFetch<Resp>(`/api/cheques/records?${query}`))
    } catch (e: any) {
      setData(null); setErr(e?.message || '載入失敗')
    } finally { setLoading(false) }
  }, [query])
  useEffect(() => { load() }, [load])

  const exportXlsx = () => window.open(`/api/cheques/records/export?${query}`, '_blank')

  const kinds: Array<[Kind | '', string]> = [['', '全部'], ['PAYROLL_ITEM', '員工'], ['PAYOUT_RUN', '醫生'], ['LAB_AMOUNT', 'Lab']]
  const statuses: Array<['' | 'PRINTED' | 'VOID', string]> = [['', '全部'], ['PRINTED', '已出票'], ['VOID', '已作廢']]

  return (
    <div className="p-6" style={{ maxWidth: 1400 }}>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">支票紀錄</h1>
          <div className="text-sm text-muted-foreground">只限老闆 · <Link href="/cheques" className="underline">支票打印中心</Link> · <Link href="/cheques/settings" className="underline">支票設定</Link></div>
        </div>
        <button type="button" onClick={exportXlsx} disabled={!data || data.rows.length === 0 || data.truncated}
          className="h-10 px-5 rounded-md bg-brand text-white font-semibold disabled:opacity-50">
          匯出 Excel
        </button>
      </div>

      <div className="flex flex-wrap gap-4 items-end mb-4">
        <label className="flex flex-col gap-1 text-xs text-slate-600">由（月份）
          <select id="rec-from" value={from} onChange={e => setFrom(e.target.value)} className="border rounded px-2 py-2 bg-white text-sm w-32">
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">至
          <select id="rec-to" value={to} onChange={e => setTo(e.target.value)} className="border rounded px-2 py-2 bg-white text-sm w-32">
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">出票戶口
          <select id="rec-account" value={accountId} onChange={e => setAccountId(e.target.value)} className="border rounded px-2 py-2 bg-white text-sm w-64">
            <option value="">全部戶口</option>
            {(data?.accounts ?? []).map(a => <option key={a.id} value={a.id}>{a.label}{a.accountLast4 ? ` · ****${a.accountLast4}` : ''}</option>)}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-xs text-slate-600">類別
          <div className="flex border rounded-md overflow-hidden bg-white" role="tablist" aria-label="類別">
            {kinds.map(([k, label]) => (
              <button key={k || 'all'} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                className={`px-3 py-2 text-sm border-l first:border-l-0 ${kind === k ? 'bg-brand text-white' : ''}`}>{label}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-xs text-slate-600">狀態
          <div className="flex border rounded-md overflow-hidden bg-white" role="tablist" aria-label="狀態">
            {statuses.map(([k, label]) => (
              <button key={k || 'all'} type="button" role="tab" aria-selected={status === k} onClick={() => setStatus(k)}
                className={`px-3 py-2 text-sm border-l first:border-l-0 ${status === k ? 'bg-brand text-white' : ''}`}>{label}</button>
            ))}
          </div>
        </div>
        <form className="flex flex-col gap-1 text-xs text-slate-600" onSubmit={e => { e.preventDefault(); setQApplied(q.trim()) }}>
          <label htmlFor="rec-q">搜尋（收款人／支票號）</label>
          <div className="flex gap-2">
            <input id="rec-q" value={q} onChange={e => setQ(e.target.value)} placeholder="例：CHAN 或 463831" className="border rounded px-2 py-1.5 bg-white text-sm w-56" />
            <button type="submit" className="px-3 rounded border bg-white text-sm">搜尋</button>
          </div>
        </form>
      </div>

      {err && <div className="text-sm text-red-600 mb-3" role="alert">{err}</div>}
      {data?.truncated && (
        <div className="border rounded-lg bg-amber-50 border-amber-300 p-3 text-sm mb-4">超過 {data.maxRows} 張，只顯示頭 {data.maxRows} 張，匯出暫停。請收窄月份或者揀戶口。</div>
      )}

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          {data.summary.byKind.map(k => (
            <div key={k.kind} className="border rounded-lg bg-white px-4 py-3">
              <div className="text-xs text-slate-500">{k.label}（已出票）</div>
              <div className="font-mono text-lg font-semibold">HK${money(k.amount)}</div>
              <div className="text-xs text-slate-500">{k.count} 張</div>
            </div>
          ))}
          <div className="border rounded-lg bg-white px-4 py-3">
            <div className="text-xs text-slate-500">合計（唔計作廢）</div>
            <div className="font-mono text-lg font-semibold">HK${money(data.summary.printed.amount)}</div>
            <div className="text-xs text-slate-500">{data.summary.printed.count} 張</div>
          </div>
          <div className="border rounded-lg bg-white px-4 py-3">
            <div className="text-xs text-slate-500">已作廢</div>
            <div className="font-mono text-lg font-semibold text-slate-500">HK${money(data.summary.void.amount)}</div>
            <div className="text-xs text-slate-500">{data.summary.void.count} 張</div>
          </div>
        </div>
      )}

      <div className="border rounded-lg bg-white overflow-x-auto">
        <table className="w-full text-sm min-w-[1100px]">
          <thead>
            <tr className="bg-slate-50 text-xs font-semibold text-slate-600 text-left">
              <th className="px-3 py-2">支票號</th><th className="px-3 py-2">支票日期</th><th className="px-3 py-2">類別</th>
              <th className="px-3 py-2">收款人（抬頭）</th><th className="px-3 py-2">對應</th><th className="px-3 py-2">診所</th>
              <th className="px-3 py-2">月份</th><th className="px-3 py-2">戶口</th><th className="px-3 py-2 text-right">金額</th>
              <th className="px-3 py-2">狀態</th><th className="px-3 py-2">打印</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && <tr><td colSpan={11} className="px-3 py-6 text-muted-foreground">載入中…</td></tr>}
            {data && data.rows.length === 0 && <tr><td colSpan={11} className="px-3 py-6 text-muted-foreground">呢個範圍冇支票紀錄</td></tr>}
            {data?.rows.map(r => (
              <tr key={r.id} className={`border-t ${r.status === 'VOID' ? 'text-slate-400' : ''}`}>
                <td className="px-3 py-2 font-mono">#{r.chequeNo}</td>
                <td className="px-3 py-2 font-mono">{r.chequeDate}</td>
                <td className="px-3 py-2">{KIND_LABEL[r.kind] ?? r.kind}</td>
                <td className={`px-3 py-2 ${r.status === 'VOID' ? 'line-through' : 'font-medium'}`}>{r.payeeName}</td>
                <td className="px-3 py-2">{r.refLabel}</td>
                <td className="px-3 py-2">{r.clinicName}</td>
                <td className="px-3 py-2 font-mono">{r.periodMonth}</td>
                <td className="px-3 py-2">{r.accountLabel}</td>
                <td className="px-3 py-2 text-right font-mono">{money(r.amount)}</td>
                <td className="px-3 py-2 text-xs">
                  {r.status === 'VOID'
                    ? <span>已作廢{r.voidReason ? `：${r.voidReason}` : ''}<br />{hkTime(r.voidedAt)}</span>
                    : r.confirmed ? <span className="text-green-700">✓ 已確認</span> : <span className="text-amber-700">未確認印得好唔好</span>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.printedByName}<br />{hkTime(r.printedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
