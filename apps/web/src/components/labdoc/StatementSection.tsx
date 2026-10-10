'use client'

/**
 * ★ cwm-labdoc §12.4：/lab-docs/statements/[id]/sections/[sid] — 分段對數
 *
 * - 篩選：全部｜唔同｜系統冇｜月結單冇
 * - 明細型：按單號分組，每行「月結／系統」並排（數量、單價、金額），唔同紅色粗體
 * - 單號型：每張一行；欠款型：「本月」同「舊欠」兩組（舊欠灰）
 * - 差異行：以 invoice 為準／以月結單為準（要原因；改成本先預覽）／唔關我哋事（要原因）／補上傳
 * - 「確認呢段」：仲有未處理行就 disable；INVOICE_WINS 確認後可以撳「跟進完成」
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, type ApiError } from '@/lib/api-client'
import { fmtMoney } from './status-meta'
import { SECTION_STATUS, stated, type StmtLine, type StmtResp } from './StatementDetail'

const OK_RESULTS = new Set(['MATCHED', 'PREVIOUSLY_MATCHED', 'NOT_APPLICABLE'])
const RESULT_META: Record<string, { label: string; cls: string }> = {
  MATCHED: { label: '一致', cls: 'bg-green-100 text-green-700' },
  PREVIOUSLY_MATCHED: { label: '之前已對・未付', cls: 'bg-slate-100 text-slate-500' },
  NOT_APPLICABLE: { label: '唔使對', cls: 'bg-slate-100 text-slate-500' },
  QTY_DIFF: { label: '數量唔同', cls: 'bg-red-100 text-red-700' },
  PRICE_DIFF: { label: '單價唔同', cls: 'bg-red-100 text-red-700' },
  AMOUNT_DIFF: { label: '金額唔同', cls: 'bg-red-100 text-red-700' },
  MISSING_IN_SYSTEM: { label: '系統冇', cls: 'bg-amber-100 text-amber-700' },
  NEEDS_MANUAL: { label: '要人手對', cls: 'bg-amber-100 text-amber-700' },
}
const RES_LABEL: Record<string, string> = {
  INVOICE_WINS: '以 invoice 為準（同 Lab 跟進）',
  STATEMENT_WINS: '以月結單為準（已改系統）',
  NOT_OURS: '唔關我哋事',
  MANUAL_PAIRED: '人手配對',
}
type Filter = 'all' | 'diff' | 'missing' | 'notOn'

export default function StatementSection({ id, sid }: { id: string; sid: string }) {
  const [data, setData] = useState<StmtResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<StmtResp>(`/api/lab-docs/${id}`))
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [id])
  useEffect(() => { load() }, [load])

  if (err) return <div className="max-w-5xl mx-auto p-4 text-sm text-red-600">{err}</div>
  if (!data) return <div className="flex justify-center py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin mr-2" />載入中…</div>
  const s = data.sections.find((x) => x.id === sid)
  if (!s) return <div className="max-w-5xl mx-auto p-4 text-sm">分段唔存在</div>

  const kind = data.document.statementKind ?? 'INVOICE_LIST'
  const confirmed = s.status === 'CONFIRMED'
  const unresolved = s.lines.filter((l) => !OK_RESULTS.has(l.result) && !l.resolution)
  const virtual = ((s.resultJson as any)?.virtualLines ?? []) as Array<{ docId: string; docNo: string | null; description: string; amount: number }>
  const notOn = ((s.resultJson as any)?.notOnStatement ?? []) as Array<{ docId: string; docNo: string | null; docDate: string; total: number | null }>
  const st = SECTION_STATUS[s.status] ?? { label: s.status, cls: '' }
  const stt = stated(s)

  const shown = s.lines.filter((l) =>
    filter === 'all' ? true
      : filter === 'diff' ? /_DIFF$|NEEDS_MANUAL/.test(l.result)
      : filter === 'missing' ? l.result === 'MISSING_IN_SYSTEM'
      : false,
  )

  const reconcile = async () => {
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/sections/${sid}/reconcile`, { method: 'POST' })
      toast.success('已重新配對')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/sections/${sid}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      toast.success('已確認呢段')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 明細型按單號分組；欠款型分本月／舊欠
  const blocks: Array<{ title: string; dim?: boolean; lines: StmtLine[] }> =
    kind === 'DETAIL'
      ? [...new Map(shown.map((l) => [l.docNoRaw ?? '（冇單號）', [] as StmtLine[]])).keys()].map((k) => ({ title: k, lines: shown.filter((l) => (l.docNoRaw ?? '（冇單號）') === k) }))
      : kind === 'OUTSTANDING'
        ? [
            { title: '本月', lines: shown.filter((l) => l.agingBucket === 'CURRENT' || !l.agingBucket) },
            { title: '舊欠', dim: true, lines: shown.filter((l) => l.agingBucket && l.agingBucket !== 'CURRENT') },
          ].filter((b) => b.lines.length > 0)
        : [{ title: '', lines: shown }]

  return (
    <div className="max-w-5xl mx-auto p-4 pb-40 md:pb-6 space-y-4">
      <div className="flex items-center gap-2">
        <Link href={`/lab-docs/statements/${id}`} className="p-2 -ml-2 rounded-lg hover:bg-accent" aria-label="返回"><ArrowLeft size={18} /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{s.clinicRaw ?? '診所'} · {s.doctorRaw ?? '醫生'}</h1>
          <div className="text-xs text-muted-foreground">{data.document.labName} · {data.document.statementMonth} · 月結 {fmtMoney(stt)} · 系統 {fmtMoney(s.systemTotal)}</div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span>
      </div>

      {s.duplicate && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          呢段嘅月結單已經喺 {s.duplicate.uploadedAt} 上傳過 — 返去總覽撳「取代舊版」先可以處理。
        </div>
      )}
      {s.newInvoicesSinceRun > 0 && !confirmed && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm flex items-center gap-2">
          <span className="flex-1">有 {s.newInvoicesSinceRun} 張新 invoice 喺上次配對之後確認 — 可以重新配對</span>
          <button onClick={reconcile} disabled={busy} className="px-3 py-1 rounded-lg bg-brand text-white">重新配對</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {([['all', `全部 ${s.lines.length}`], ['diff', '唔同'], ['missing', '系統冇'], ['notOn', `月結單冇 ${virtual.length + notOn.length}`]] as Array<[Filter, string]>).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1 rounded-full text-sm border ${filter === k ? 'bg-brand text-white border-brand' : 'bg-card'}`}>{label}</button>
        ))}
        <span className="flex-1" />
        {!confirmed && <button onClick={reconcile} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-card text-sm"><RefreshCw size={14} />重新配對</button>}
      </div>

      {filter === 'notOn' ? (
        <div className="rounded-xl border bg-card divide-y text-sm">
          {virtual.map((v, i) => (
            <div key={`v${i}`} className="p-3 flex items-center gap-2">
              <span className="flex-1">{v.docNo ?? '—'} · {v.description}</span>
              <span className="tabular-nums">{fmtMoney(v.amount)}</span>
              <Link className="text-xs underline" href={`/lab-docs/invoices/${v.docId}`}>睇 invoice</Link>
            </div>
          ))}
          {notOn.map((v) => (
            <div key={v.docId} className="p-3 flex items-center gap-2">
              <span className="flex-1">{v.docNo ?? '—'} · {v.docDate}（系統有、月結單冇）</span>
              <span className="tabular-nums">{fmtMoney(v.total)}</span>
              <Link className="text-xs underline" href={`/lab-docs/invoices/${v.docId}`}>睇 invoice</Link>
            </div>
          ))}
          {virtual.length + notOn.length === 0 && <div className="p-3 text-muted-foreground">冇</div>}
        </div>
      ) : (
        blocks.map((b, bi) => (
          <div key={bi} className={`rounded-xl border bg-card ${b.dim ? 'opacity-80' : ''}`}>
            {b.title && <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground">{b.title}</div>}
            <div className="divide-y">
              {b.lines.map((l) => (
                <LineRow key={l.id} docId={id} sid={sid} kind={kind} l={l} sectionConfirmed={confirmed} blocked={!!s.duplicate} onChanged={load} />
              ))}
              {b.lines.length === 0 && <div className="p-3 text-sm text-muted-foreground">冇</div>}
            </div>
          </div>
        ))
      )}

      {/* 手機：底部導航高 4rem（AdminMobileNav）→ 企喺佢上面 */}
      {!confirmed && (
        <div className="fixed bottom-16 inset-x-0 z-30 border-t bg-background/95 backdrop-blur p-3 md:static md:border md:rounded-xl md:bg-card">
          <div className="max-w-5xl mx-auto flex items-center gap-3">
            <div className="flex-1 text-sm">
              {unresolved.length > 0 ? <span className="text-amber-700">仲有 {unresolved.length} 行未處理</span>
                : stt !== null && s.systemTotal !== null && Math.abs(stt - s.systemTotal) > 0.01
                  ? <span className="text-muted-foreground">差 {fmtMoney(Math.round((stt - s.systemTotal) * 100) / 100)}（已全部處理）</span>
                  : <span className="text-green-700">✓ 全部對好</span>}
            </div>
            <button onClick={confirm} disabled={busy || unresolved.length > 0 || !!s.duplicate} title={unresolved.length > 0 ? `仲有 ${unresolved.length} 行未處理` : undefined}
              className="px-5 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-40">確認呢段</button>
          </div>
        </div>
      )}
    </div>
  )
}

function LineRow({ docId, sid, kind, l, sectionConfirmed, blocked, onChanged }: {
  docId: string
  sid: string
  kind: string
  l: StmtLine
  sectionConfirmed: boolean
  blocked: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [pickLine, setPickLine] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const rm = RESULT_META[l.result] ?? { label: l.result, cls: 'bg-slate-100' }
  const sys = l.system?.line
  const needs = !OK_RESULTS.has(l.result) && !l.resolution
  const changeable = !sectionConfirmed && (l.resolution === 'INVOICE_WINS' || l.resolution === 'NOT_OURS')
  const red = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && Math.abs(a - b) > 0.001 ? 'text-red-600 font-bold' : '')

  const resolve = async (resolution: string, extra: Record<string, unknown> = {}) => {
    if ((resolution === 'STATEMENT_WINS' || resolution === 'NOT_OURS') && !note.trim()) { toast.error('要寫原因'); return }
    setBusy(true)
    const body = { resolution, note: note.trim() || null, ...(pickLine ? { systemLineId: pickLine } : {}), ...extra }
    try {
      const r = await apiFetch<{ ok: boolean; needsCostConfirm?: boolean; costPreview?: { itemType: string | null; baseCost: number | null; newLinkedSum: number; locked: boolean } }>(
        `/api/lab-docs/${docId}/sections/${sid}/lines/${l.id}/resolve`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      )
      if (r.needsCostConfirm && r.costPreview) {
        const p = r.costPreview
        if (window.confirm(`成本「${p.itemType ?? ''}」會由 ${fmtMoney(p.baseCost)} 改做 ${fmtMoney(p.newLinkedSum)}，確定？`)) {
          setBusy(false)
          return resolve(resolution, { costAdjustConfirmed: true })
        }
        return
      }
      if (r.costPreview?.locked) toast.info('成本已出月結 — 差額入「下期調整」')
      toast.success('已處理')
      setOpen(false)
      onChanged()
    } catch (e) {
      const ae = e as ApiError
      if (ae.body?.code === 'PICK_SYSTEM_LINE') toast.error('呢張 invoice 有幾行 — 喺下面揀要改邊行')
      else toast.error(ae.message)
    } finally {
      setBusy(false)
    }
  }
  const closeFollowup = async () => {
    try {
      await apiFetch(`/api/lab-docs/${docId}/sections/${sid}/lines/${l.id}/close-followup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      toast.success('跟進完成')
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className={`p-3 text-sm ${l.result === 'PREVIOUSLY_MATCHED' || l.result === 'NOT_APPLICABLE' ? 'text-muted-foreground' : ''}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {kind === 'DETAIL' ? (
            <>
              <div className="truncate">{l.description ?? '—'}{l.toothRaw ? ` · ${l.toothRaw}` : ''}</div>
              <div className="grid grid-cols-4 gap-1 text-xs tabular-nums mt-0.5">
                <span className="text-muted-foreground">月結</span>
                <span>×{l.qty ?? '—'}</span><span>@{fmtMoney(l.unitPrice)}</span><span>{fmtMoney(l.amount)}</span>
                <span className="text-muted-foreground">系統</span>
                {sys ? (<>
                  <span className={red(l.qty, sys.qty)}>×{sys.qty ?? '—'}</span>
                  <span className={red(l.unitPrice, sys.unitPrice)}>@{fmtMoney(sys.unitPrice)}</span>
                  <span className={red(l.amount, sys.amount)}>{fmtMoney(sys.amount)}</span>
                </>) : <span className="col-span-3 text-muted-foreground">—</span>}
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-x-3">
              <span className="font-medium">{l.docNoRaw ?? '—'}</span>
              <span className="text-muted-foreground">{l.date ? String(l.date).slice(0, 10) : ''}</span>
              <span className="text-muted-foreground truncate">{l.patientRaw ?? ''}</span>
              <span className="tabular-nums">月結 {fmtMoney(l.amount)}</span>
              <span className={`tabular-nums ${red(l.amount, l.system?.total)}`}>系統 {l.system ? fmtMoney(l.system.total) : '—'}</span>
            </div>
          )}
        </div>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium flex-shrink-0 ${rm.cls}`}>{rm.label}</span>
      </div>

      {l.resolution && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span className="px-1.5 rounded bg-slate-100">{RES_LABEL[l.resolution] ?? l.resolution}{l.resolutionNote ? `：${l.resolutionNote}` : ''}</span>
          {l.resolution === 'INVOICE_WINS' && (l.followUpClosedAt ? <span className="text-green-700">✓ 跟進完成</span>
            : <button className="underline" onClick={closeFollowup}>跟進完成</button>)}
          {changeable && <button className="underline" onClick={() => setOpen((o) => !o)}>改</button>}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-2 text-xs">
        {l.system && <Link className="underline text-muted-foreground" href={`/lab-docs/invoices/${l.system.docId}`}>睇 invoice {l.system.docNo ?? ''}</Link>}
        {needs && !blocked && !open && <button className="underline text-brand" onClick={() => setOpen(true)}>處理</button>}
      </div>

      {open && !blocked && (
        <div className="mt-2 rounded-lg bg-muted/40 p-2 space-y-2">
          <input className="w-full border rounded px-2 py-1" placeholder="原因（以月結單為準／唔關我哋事要填）" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          {l.system && !l.matchedLineId && l.system.lines.length > 1 && (
            <select className="w-full border rounded px-2 py-1" value={pickLine} onChange={(e) => setPickLine(e.target.value)}>
              <option value="">以月結單為準：揀要改 invoice 邊一行</option>
              {l.system.lines.map((x) => <option key={x.id} value={x.id}>{x.description ?? '—'} · {fmtMoney(x.amount)}</option>)}
            </select>
          )}
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => resolve('INVOICE_WINS')} className="px-3 py-1 rounded-lg bg-brand text-white">以 invoice 為準</button>
            {l.matchedDocumentId && l.resolution !== 'NOT_OURS' && (
              <button disabled={busy} onClick={() => resolve('STATEMENT_WINS')} className="px-3 py-1 rounded-lg border bg-card">以月結單為準</button>
            )}
            <button disabled={busy} onClick={() => resolve('NOT_OURS')} className="px-3 py-1 rounded-lg border bg-card">唔關我哋事</button>
            {l.result === 'MISSING_IN_SYSTEM' && (
              <Link href="/lab-docs?tab=invoices" className="px-3 py-1 rounded-lg border bg-card">補上傳 invoice</Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
