'use client'

/**
 * ★ cwm-labdoc：/lab-docs/statements/[id]/sections/[sid] — 分段對數
 *
 * 2026-10-11 改：同「成本錄入」對總數（唔使準確到病人；invoice 先逐個病人對）。
 * - 頂：月結單（唔計備貨／唔關我哋事）｜成本錄入｜差額
 * - 左：月結單行（冇印數量 → 金額 ÷ 單價）；每行可以標「備貨」／「唔關我哋事」；成段都係備貨有一鍵
 * - 右：成本錄入（同 Lab、同診所、同醫生、到貨日喺同月）
 * - 按金額劃埋（一筆成本 = 一行或者連續幾行）只係幫你搵差異，唔影響狀態
 * - 確認：一致直接確認；有差異要寫原因
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api-client'
import { fmtMoney } from './status-meta'
import { SECTION_STATUS, type StmtLine, type StmtResp } from './StatementDetail'

interface CostSnap { id: string; patientCode: string | null; itemType: string | null; finalCost: number | null; status: string; receivedAt: string | null }
interface CostResult {
  mode?: string
  statementTotal?: number
  costTotal?: number
  diff?: number
  stockTotal?: number
  notOursTotal?: number
  unpricedCount?: number
  readCheck?: { stated: number; linesSum: number; ok: boolean } | null
  pairs?: Array<{ costCaseId: string; lineIds: string[] }>
  costs?: CostSnap[]
}

const MARK_LABEL: Record<string, string> = { STOCK: '備貨', NOT_OURS: '唔關我哋事', STATEMENT_WINS: '以月結單為準（舊）' }
const COUNTED_TYPES = new Set(['INVOICE', 'CREDIT', 'CHARGE'])

/** 月結單冇印數量 → 金額 ÷ 單價（整除先用） */
function qtyOf(l: StmtLine): number | null {
  if (l.qty != null) return l.qty
  if (!l.unitPrice) return null
  const q = l.amount / l.unitPrice
  const rq = Math.round(q)
  return rq > 0 && Math.abs(q - rq) < 1e-6 ? rq : null
}

export default function StatementSection({ id, sid }: { id: string; sid: string }) {
  const [data, setData] = useState<StmtResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<StmtResp>(`/api/lab-docs/${id}`))
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [id])
  useEffect(() => { load() }, [load])

  const s = data?.sections.find((x) => x.id === sid) ?? null
  const rj = (s?.resultJson ?? {}) as CostResult
  const costed = rj.mode === 'COST'
  // 行 → 劃埋嘅成本；成本 → 劃埋嘅行
  const { lineToCost, costToLines } = useMemo(() => {
    const lineToCost = new Map<string, string>()
    const costToLines = new Map<string, string[]>()
    for (const p of rj.pairs ?? []) {
      costToLines.set(p.costCaseId, p.lineIds)
      for (const lid of p.lineIds) lineToCost.set(lid, p.costCaseId)
    }
    return { lineToCost, costToLines }
  }, [rj.pairs])

  if (err) return <div className="max-w-5xl mx-auto p-4 text-sm text-red-600">{err}</div>
  if (!data) return <div className="flex justify-center py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin mr-2" />載入中…</div>
  if (!s) return <div className="max-w-5xl mx-auto p-4 text-sm">分段唔存在</div>

  const confirmed = s.status === 'CONFIRMED'
  const st = SECTION_STATUS[s.status] ?? { label: s.status, cls: '' }
  const costs = rj.costs ?? []
  const costById = new Map(costs.map((c) => [c.id, c]))
  const diff = rj.diff ?? null
  const isDiff = s.status === 'DIFF'
  const readBad = rj.readCheck?.ok === false
  const needsReason = isDiff || readBad
  const docBlocked = !!s.duplicate || !!data.document.supersededById
  const editable = !confirmed && !docBlocked

  const reconcile = async () => {
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/sections/${sid}/reconcile`, { method: 'POST' })
      toast.success('已重新對數')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    if (needsReason && !reason.trim()) { toast.error('有差異 — 要寫原因先可以確認'); return }
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/sections/${sid}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(needsReason ? { reason: reason.trim() } : {}),
      })
      toast.success('已確認呢段')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const markAll = async () => {
    const first = s.lines[0]
    if (!first) return
    if (!window.confirm('成段標做「備貨」？呢段嘅行唔會再同成本錄入比較。')) return
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/sections/${sid}/lines/${first.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'STOCK', applyToAll: true }),
      })
      toast.success('成段已標備貨')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-4 pb-48 md:pb-6 space-y-4">
      <div className="flex items-center gap-2">
        <Link href={`/lab-docs/statements/${id}`} className="p-2 -ml-2 rounded-lg hover:bg-accent" aria-label="返回"><ArrowLeft size={18} /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{s.clinicRaw ?? '診所'} · {s.doctorRaw ?? '醫生'}</h1>
          <div className="text-xs text-muted-foreground">{data.document.labName ?? 'Lab 未揀'} · {data.document.statementMonth ?? '月份未揀'} · 同成本錄入（到貨日）對</div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span>
      </div>

      {s.duplicate && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          呢段嘅月結單已經喺 {s.duplicate.uploadedAt} 上傳過 — 返去總覽撳「取代舊版」先可以處理。
        </div>
      )}
      {s.status === 'NEEDS_ASSIGN' && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          未揀診所／醫生 — 返月結單總覽揀咗先可以同成本錄入對。如果成段都係診所備貨（唔屬病人），撳下面「成段係備貨」。
        </div>
      )}
      {(!data.document.labId || !data.document.statementMonth) && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">月結單未揀 Lab／月份 — 返月結單總覽撳「改 Lab／月份」。</div>
      )}
      {s.newInvoicesSinceRun > 0 && editable && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm flex items-center gap-2">
          <span className="flex-1">成本錄入喺上次對數之後有 {s.newInvoicesSinceRun} 筆改動 — 可以重新對數</span>
          <button onClick={reconcile} disabled={busy} className="px-3 py-1 rounded-lg bg-brand text-white">重新對數</button>
        </div>
      )}

      {/* 總數 */}
      <div className="grid grid-cols-3 rounded-xl border bg-card divide-x">
        <div className="p-3">
          <div className="text-xs text-muted-foreground">月結單</div>
          <div className="text-lg font-semibold tabular-nums">{costed ? fmtMoney(rj.statementTotal) : '—'}</div>
          {((rj.stockTotal ?? 0) !== 0 || (rj.notOursTotal ?? 0) !== 0) && (
            <div className="text-[11px] text-muted-foreground">
              {(rj.stockTotal ?? 0) !== 0 && <>備貨 {fmtMoney(rj.stockTotal)} </>}
              {(rj.notOursTotal ?? 0) !== 0 && <>唔關我哋事 {fmtMoney(rj.notOursTotal)} </>}
              唔計
            </div>
          )}
        </div>
        <div className="p-3">
          <div className="text-xs text-muted-foreground">成本錄入（{costs.length} 筆）</div>
          <div className="text-lg font-semibold tabular-nums">{costed ? fmtMoney(rj.costTotal) : '—'}</div>
        </div>
        <div className="p-3">
          <div className="text-xs text-muted-foreground">差額</div>
          <div className={`text-lg font-semibold tabular-nums ${isDiff ? 'text-amber-700' : costed ? 'text-green-700' : ''}`}>
            {costed ? (diff ? `${diff > 0 ? '+' : ''}${fmtMoney(diff)}` : '$0 ✓') : '—'}
          </div>
        </div>
      </div>
      {readBad && rj.readCheck && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
          月結單印嘅總數 {fmtMoney(rj.readCheck.stated)}，但讀到嘅行加埋 {fmtMoney(rj.readCheck.linesSum)} — 可能有行讀漏，撳「睇原檔」核對。
        </div>
      )}
      {(rj.unpricedCount ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">有 {rj.unpricedCount} 筆成本仲係「未有價」— 照計佢而家個數（冇數當 $0），確認前睇清楚。</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground flex-1">按金額幫你劃埋：一筆成本 = 一行，或者 = 連續幾行加埋。只係幫你搵差異，狀態淨係睇總數。</span>
        {editable && s.lines.length > 0 && <button onClick={markAll} disabled={busy} className="px-3 py-1.5 rounded-lg border bg-card text-sm">成段係備貨</button>}
        {editable && <button onClick={reconcile} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-card text-sm"><RefreshCw size={14} />重新對數</button>}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {/* 月結單 */}
        <div className="rounded-xl border bg-card min-w-0">
          <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground">月結單（{s.lines.length} 行）</div>
          <div className="divide-y">
            {s.lines.map((l) => (
              <LineRow key={l.id} docId={id} sid={sid} l={l} cost={lineToCost.has(l.id) ? costById.get(lineToCost.get(l.id)!) ?? null : null} editable={editable} onChanged={load} />
            ))}
            {s.lines.length === 0 && <div className="p-3 text-sm text-muted-foreground">冇行</div>}
          </div>
        </div>

        {/* 成本錄入 */}
        <div className="rounded-xl border bg-card min-w-0">
          <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground flex items-center">
            <span className="flex-1">成本錄入（同 Lab、同診所、同醫生、到貨日喺 {data.document.statementMonth ?? '—'}）</span>
            <Link href="/cost-entry" className="underline">去成本錄入</Link>
          </div>
          <div className="divide-y">
            {costs.map((c) => {
              const paired = costToLines.get(c.id)
              return (
                <div key={c.id} className="p-3 text-sm flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap gap-x-3">
                      <span className="tabular-nums text-muted-foreground">{c.receivedAt ? c.receivedAt.slice(5).replace('-', '/') : '—'}</span>
                      <span className="font-medium">{c.patientCode ?? '—'}</span>
                      <span className="text-muted-foreground">{c.itemType ?? ''}</span>
                    </div>
                    <div className="text-xs mt-0.5">
                      {paired ? <span className="text-green-700">✓ 劃埋月結單 {paired.length} 行</span> : <span className="text-amber-700">月結單冇對到</span>}
                      {c.status === 'PENDING' && <span className="ml-2 px-1.5 rounded bg-amber-100 text-amber-700">未有價</span>}
                    </div>
                  </div>
                  <span className="tabular-nums">{fmtMoney(c.finalCost)}</span>
                </div>
              )
            })}
            {costs.length === 0 && <div className="p-3 text-sm text-muted-foreground">{costed ? '呢個月冇成本' : '未對數'}</div>}
          </div>
        </div>
      </div>

      {confirmed ? (
        <div className="rounded-xl border bg-card p-3 text-sm">
          ✓ 已確認{s.confirmedAt ? `（${String(s.confirmedAt).slice(0, 10)}）` : ''}{s.note ? ` — 原因：${s.note}` : ''}
        </div>
      ) : (
        /* 手機：底部導航高 4rem（AdminMobileNav）→ 企喺佢上面 */
        <div className="fixed bottom-16 inset-x-0 z-30 border-t bg-background/95 backdrop-blur p-3 md:static md:border md:rounded-xl md:bg-card">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[12rem] text-sm">
              {!costed ? <span className="text-muted-foreground">未對數</span>
                : isDiff ? <span className="text-amber-700">差 {fmtMoney(Math.abs(diff ?? 0))} — 改好成本錄入再「重新對數」，或者寫原因確認</span>
                  : readBad ? <span className="text-amber-700">總數一致，但月結單讀數唔齊 — 寫原因確認</span>
                    : <span className="text-green-700">✓ 總數一致</span>}
            </div>
            {needsReason && costed && (
              <input
                id="confirm-reason"
                className="flex-1 min-w-[12rem] border rounded-lg px-2 py-1.5 text-sm"
                placeholder="原因（例：Lab 下月先補單）"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
            <button onClick={confirm} disabled={busy || !costed || docBlocked || (needsReason && !reason.trim())}
              className="px-5 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-40">確認呢段</button>
          </div>
        </div>
      )}
    </div>
  )
}

function LineRow({ docId, sid, l, cost, editable, onChanged }: {
  docId: string
  sid: string
  l: StmtLine
  cost: CostSnap | null
  editable: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const counted = COUNTED_TYPES.has(l.lineType) && l.result !== 'NOT_APPLICABLE'
  const marked = l.resolution && MARK_LABEL[l.resolution]
  const q = qtyOf(l)

  const mark = async (resolution: 'STOCK' | 'NOT_OURS' | 'CLEAR') => {
    if (resolution === 'NOT_OURS' && !note.trim()) { toast.error('「唔關我哋事」要寫原因'); return }
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${docId}/sections/${sid}/lines/${l.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution, note: note.trim() || null }),
      })
      toast.success(resolution === 'CLEAR' ? '已取消標記' : '已標記')
      setOpen(false)
      setNote('')
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`p-3 text-sm ${!counted ? 'text-muted-foreground' : ''}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="truncate">
            {l.docNoRaw ? <span className="mr-2 text-muted-foreground">{l.docNoRaw}</span> : null}
            {l.description ?? (l.lineType === 'PAYMENT' ? '付款' : l.lineType === 'BF' ? '上月結餘' : '—')}
            {l.toothRaw ? ` · ${l.toothRaw}` : ''}
          </div>
          <div className="text-xs tabular-nums text-muted-foreground mt-0.5">
            ×{q ?? '—'}{l.qty == null && q != null ? '（推算）' : ''} @ {fmtMoney(l.unitPrice)}
            {l.agingBucket && l.agingBucket !== 'CURRENT' ? ' · 舊欠' : ''}
          </div>
        </div>
        <span className="tabular-nums">{fmtMoney(l.amount)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        {marked ? (
          <span className="px-1.5 rounded bg-slate-100">{marked}{l.resolutionNote ? `：${l.resolutionNote}` : ''}</span>
        ) : !counted ? (
          <span>唔計</span>
        ) : cost ? (
          <span className="text-green-700">✓ 劃埋 {cost.patientCode ?? ''} {cost.itemType ?? ''} {fmtMoney(cost.finalCost)}</span>
        ) : l.result === 'UNPAIRED' ? (
          <span className="text-amber-700">成本錄入冇對到呢個金額</span>
        ) : null}
        {editable && COUNTED_TYPES.has(l.lineType) && (Math.abs(l.amount) > 0.001 || !!l.resolution) && !open && l.resolution !== 'STATEMENT_WINS' && (
          l.resolution === 'STOCK' || l.resolution === 'NOT_OURS'
            ? <button className="underline" disabled={busy} onClick={() => mark('CLEAR')}>取消標記</button>
            : <button className="underline text-brand" onClick={() => setOpen(true)}>標記</button>
        )}
      </div>
      {open && (
        <div className="mt-2 rounded-lg bg-muted/40 p-2 space-y-2">
          <input className="w-full border rounded px-2 py-1" placeholder="原因（唔關我哋事要填；備貨可唔填）" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => mark('STOCK')} className="px-3 py-1 rounded-lg bg-brand text-white">備貨（唔屬病人）</button>
            <button disabled={busy} onClick={() => mark('NOT_OURS')} className="px-3 py-1 rounded-lg border bg-card">唔關我哋事</button>
            <button disabled={busy} onClick={() => setOpen(false)} className="px-3 py-1 rounded-lg border">取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

