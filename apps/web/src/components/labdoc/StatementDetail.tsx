'use client'

/**
 * ★ cwm-labdoc §12.3：/lab-docs/statements/[id] — 月結單總覽（電腦優先）
 *
 * - 頭：Lab、月份、頁數、讀法、收款人警告；「睇原檔」
 * - 統計（2026-10-11 改）：月結單（唔計備貨）vs 成本錄入（同 Lab、同月、到貨日）、差額、分段確認進度；
 *   月結單涉及嘅診所有成本、但冇呢位醫生分段 → 提示
 * - 分段表：未識別（NEEDS_ASSIGN）排第一 → 即場揀診所／醫生（可剔「記住」寫 alias）
 * - 揀錯：分段「改」／「解除指派」；Lab／月份讀唔到或者錯 → 「改 Lab／月份」（改完舊配對清走再自動重新配對）
 * - 重複分段 → 「取代舊版」（要原因；舊版已處理嘅差異會帶過嚟）
 */

import { combineSection } from './combine-action'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ChevronRight, ImageIcon, Loader2, Pencil, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api-client'
import { fmtMoney, hkDateTime, statusMeta } from './status-meta'
import LabDocViewer from './LabDocViewer'

export interface StmtSection {
  id: string
  sectionIndex: number
  pageFrom: number | null
  pageTo: number | null
  clinicRaw: string | null
  doctorRaw: string | null
  clinicId: string | null
  providerId: string | null
  statedTotal: number | null
  statedCurrent: number | null
  systemTotal: number | null
  status: string
  confirmedAt: string | null
  note: string | null
  resultJson: { mode?: string; statementTotal?: number; costTotal?: number; diff?: number; stockTotal?: number; counts?: Record<string, number> } | null
  costEvidence: { totalFinalCost: number | null; discountCosts: Array<{ id: string; itemType: string | null; discountPct: number }>; flag: boolean }
  newInvoicesSinceRun: number
  duplicate: { docId: string; sectionId?: string; uploadedAt: string } | null
  /** ★ 2026-10-12：兩份加埋一齊對 */
  combined?: {
    primarySectionId: string
    members: Array<{ sectionId: string; docId: string; uploadedAt: string; isSelf: boolean; isPrimary: boolean }>
    otherLines: Array<StmtLine & { sectionId: string; docId: string }>
  } | null
  lines: StmtLine[]
}
export interface StmtLine {
  id: string
  lineIndex: number
  lineType: string
  docNoRaw: string | null
  docNo?: string | null
  date: string | null
  patientRaw: string | null
  description: string | null
  toothRaw: string | null
  qty: number | null
  unitPrice: number | null
  amount: number
  agingBucket: string | null
  matchedDocumentId: string | null
  matchedLineId: string | null
  result: string
  resolution: string | null
  resolutionNote: string | null
  followUpClosedAt: string | null
  /** MANUAL = 人手配對；NONE = 未配對到（唔自動劃） */
  pairMode?: string | null
  pairCostCaseId?: string | null
  /** 上月結轉副本（「計入下個月」帶過嚟） */
  carriedFromLineId?: string | null
  carriedFromMonth?: string | null
  system: {
    docId: string
    docNo: string | null
    total: number | null
    line: { id: string; description: string | null; toothRaw: string | null; qty: number | null; unitPrice: number | null; amount: number } | null
    lines: Array<{ id: string; description: string | null; amount: number }>
  } | null
}
export interface StmtResp {
  document: {
    id: string
    status: string
    queuePosition?: number | null
    labId: string | null
    labName: string | null
    labNameRaw: string | null
    statementMonth: string | null
    statementKind: string | null
    payeeRaw: string | null
    payeeIsNew: boolean
    extractSource: string | null
    extractError?: string | null
    version: number
    supersededById: string | null
    voidReason?: string | null
    uploadedBy: string
    createdAt: string
  }
  pages: Array<{ id: string }>
  sections: StmtSection[]
  statementMonthFromLines: boolean
  costSummary: {
    statementTotal: number
    costTotal: number
    diff: number
    stockTotal: number
    uncovered: Array<{ clinicId: string; providerId: string; total: number; count: number }>
  } | null
}

export const SECTION_STATUS: Record<string, { label: string; cls: string }> = {
  NEEDS_ASSIGN: { label: '未識別', cls: 'bg-red-100 text-red-700' },
  PENDING: { label: '未對', cls: 'bg-slate-100 text-slate-600' },
  OK: { label: '一致', cls: 'bg-green-100 text-green-700' },
  DIFF: { label: '有差異', cls: 'bg-amber-100 text-amber-700' },
  CONFIRMED: { label: '已確認', cls: 'bg-emerald-100 text-emerald-700' },
}
const KIND_LABEL: Record<string, string> = { DETAIL: '明細型', INVOICE_LIST: '單號型', OUTSTANDING: '欠款型' }
// 呢兩個狀態先可以改 Lab／月份、改／解除分段指派（後端同一套規則）
const HEADER_EDITABLE = new Set(['NEEDS_REVIEW', 'IN_PROGRESS'])


export default function StatementDetail({ id }: { id: string }) {
  const [data, setData] = useState<StmtResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [clinics, setClinics] = useState<Array<{ id: string; name: string }>>([])
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  const [viewer, setViewer] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [labs, setLabs] = useState<Array<{ id: string; name: string }>>([])
  const [editHeader, setEditHeader] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<StmtResp>(`/api/lab-docs/${id}`))
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [id])
  useEffect(() => {
    load()
    apiFetch<{ clinics: Array<{ id: string; name: string }> }>('/api/clinics').then((d) => setClinics(d.clinics || [])).catch(() => {})
    apiFetch<{ providers: Array<{ id: string; name: string }> }>('/api/providers').then((d) => setProviders(d.providers || [])).catch(() => {})
    apiFetch<{ labs: Array<{ id: string; name: string }> }>('/api/labs').then((d) => setLabs(d.labs || [])).catch(() => {})
  }, [load])
  useEffect(() => {
    if (!data || !['UPLOADED', 'EXTRACTING'].includes(data.document.status)) return
    const t = setTimeout(load, 3000)
    return () => clearTimeout(t)
  }, [data, load])

  if (err) return <div className="max-w-5xl mx-auto p-4 text-sm text-red-600">{err}</div>
  if (!data) return <div className="flex justify-center py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin mr-2" />載入中…</div>

  const d = data.document
  const sm = statusMeta(d.status)
  const secs = [...data.sections].sort((a, b) => (a.status === 'NEEDS_ASSIGN' ? -1 : 0) - (b.status === 'NEEDS_ASSIGN' ? -1 : 0) || a.sectionIndex - b.sectionIndex)
  const cs = data.costSummary
  const confirmedN = data.sections.filter((s) => s.status === 'CONFIRMED').length
  const cName = (cid: string | null) => (cid ? clinics.find((c) => c.id === cid)?.name ?? '—' : null)
  const pName = (pid: string | null) => (pid ? providers.find((p) => p.id === pid)?.name ?? '—' : null)

  // 讀單失敗 → 原頁再讀（之前要返去「待處理」先撳到）
  const retry = async () => {
    setRetrying(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/retry`, { method: 'POST' })
      toast.success('再讀緊…')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRetrying(false)
    }
  }

  // ★ 2026-10-11：月結單頁都可以作廢（例：讀單失敗、影錯、上傳重複）— 同 invoice 用同一個 DELETE（要原因）
  const voidDoc = async () => {
    const inGroup = data.sections.some((s) => s.combined)
    const reason = window.prompt(
      '作廢呢份月結單？請寫原因（例：影錯相、重複上傳、會重新上傳）'
        + (inGroup ? '\n\n⚠ 呢份同另一份月結單「加埋一齊對」緊 — 作廢之後另一份要重新對數、重新確認。' : ''),
    )
    if (!reason?.trim()) return
    try {
      const r = await apiFetch<{ unconfirmedSectionIds?: string[] }>(`/api/lab-docs/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }) })
      toast.success(r?.unconfirmedSectionIds?.length ? `已作廢 — 加埋嗰份已打返未確認（${r.unconfirmedSectionIds.length} 段），要重新確認` : '已作廢')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // ★ 2026-10-11：月結單頁都可以「記住收款人」（之前只喺待處理清單有）
  const rememberPayee = async () => {
    if (!window.confirm(`記住「${d.payeeRaw}」係呢間 Lab 嘅收款人？之後同一個收款人唔會再提示。`)) return
    try {
      await apiFetch(`/api/lab-docs/${id}/payee`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: d.version }) })
      toast.success('已記住收款人'); load()
    } catch (e) { toast.error((e as Error).message) }
  }

  // ★ 2026-10-12：同一位醫生、同 Lab、同月嘅另一份單（唔係重發）→ 加埋一齊對（每段撞咗嘅都加）
  const combineWith = async (oldId: string) => {
    const secs = data.sections.filter((s) => s.duplicate?.docId === oldId)
    if (secs.length === 0) return
    let ok = 0
    for (const s of secs) if (await combineSection(id, s.id, { silent: true })) ok++
    if (ok > 0) { toast.success(`已加埋 ${ok} 段：兩份月結單一齊同成本錄入對`); load() }
  }

  const supersede = async (oldId: string) => {
    const reason = window.prompt('取代舊版原因（例：Lab 重發、舊版影漏頁）')
    if (!reason?.trim()) return
    try {
      const r = await apiFetch<{ carriedResolutions?: number }>(`/api/lab-docs/${id}/supersede`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldDocumentId: oldId, reason, version: d.version }),
      })
      toast.success(`已取代舊版${r?.carriedResolutions ? `（帶過 ${r.carriedResolutions} 個已處理差異）` : ''}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const headerEditable = HEADER_EDITABLE.has(d.status) && !d.supersededById && !data.sections.some((s) => s.status === 'CONFIRMED')
  const headerMissing = !d.labId || !d.statementMonth
  const dups = [...new Map(data.sections.filter((s) => s.duplicate).map((s) => [s.duplicate!.docId, s.duplicate!])).values()]

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/lab-docs?tab=statements" className="p-2 -ml-2 rounded-lg hover:bg-accent" aria-label="返回"><ArrowLeft size={18} /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{d.labName ?? d.labNameRaw ?? 'Lab 未識別'} · {d.statementMonth ?? '月份未識別'} 月結單</h1>
          <div className="text-xs text-muted-foreground">
            {KIND_LABEL[d.statementKind ?? ''] ?? '類型未設'} · {data.pages.length} 頁 · {d.extractSource === 'TEXT' ? '讀文字' : d.extractSource === 'VISION' ? '睇相' : '—'} · 上傳 {hkDateTime(d.createdAt)}
          </div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sm.cls}`}>{sm.label}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setViewer(true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-card text-sm"><ImageIcon size={14} />睇原檔</button>
        {d.status === 'EXTRACT_FAILED' && (
          <button onClick={retry} disabled={retrying} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {retrying ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}再讀
          </button>
        )}
        {headerEditable && !headerMissing && !editHeader && (
          <button onClick={() => setEditHeader(true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-card text-sm"><Pencil size={14} />改 Lab／月份</button>
        )}
        {d.status !== 'VOID' && d.status !== 'SUPERSEDED' && !['UPLOADED', 'EXTRACTING'].includes(d.status) && (
          <button onClick={voidDoc} className="px-3 py-1.5 rounded-lg border bg-card text-sm text-red-600">作廢</button>
        )}
      </div>
      {d.status === 'VOID' && <div className="rounded-xl border bg-muted p-3 text-sm">已作廢{d.voidReason ? `：${d.voidReason}` : ''}</div>}

      {headerEditable && (headerMissing || editHeader) && (
        <HeaderEditor
          docId={id}
          version={d.version}
          labId={d.labId}
          month={d.statementMonth}
          labs={labs}
          missing={headerMissing}
          onCancel={headerMissing ? null : () => setEditHeader(false)}
          onSaved={() => { setEditHeader(false); load() }}
        />
      )}

      {d.supersededById && (
        <div className="rounded-xl border bg-muted p-3 text-sm">已被取代 — <Link className="underline" href={`/lab-docs/statements/${d.supersededById}`}>開新版</Link></div>
      )}
      {['UPLOADED', 'EXTRACTING'].includes(d.status) && (
        <div className="rounded-xl border bg-blue-50 p-3 text-sm flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          {d.status === 'UPLOADED' && d.queuePosition ? `排隊中 · 第 ${d.queuePosition} 位（讀單機一次讀一張，會自動輪到）` : '讀緊月結單…'}
        </div>
      )}
      {d.status === 'EXTRACT_FAILED' && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">讀唔到（{d.extractError ?? '讀單失敗'}）— 撳上面「再讀」，或者影清楚啲再上傳。</div>}
      {d.payeeIsNew && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm flex flex-wrap items-center gap-2">
          <span className="flex-1 min-w-[12rem]">⚠ 收款人「{d.payeeRaw}」未記住係 {d.labName ?? '呢間 Lab'} 嘅收款人 — 如果啱，撳「記住」；唔啱（例如銀行戶口名唔同咗）付款前同 Lab 確認</span>
          {d.labId && <button onClick={rememberPayee} className="px-3 py-1 rounded-lg border bg-card">記住收款人</button>}
        </div>
      )}
      {data.statementMonthFromLines && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">月份係由行嘅日期推斷 — 請核對</div>}
      {dups.map((dup) => (
        <div key={dup.docId} className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm flex flex-wrap items-center gap-2">
          <span className="flex-1">同一個月、同 Lab／診所／醫生已經有一份月結單（{dup.uploadedAt} 上傳）。呢份係：</span>
          <Link className="underline" href={`/lab-docs/statements/${dup.docId}`}>睇另一份</Link>
          <button className="px-3 py-1 rounded-lg border bg-card" onClick={() => supersede(dup.docId)}>Lab 重發 → 取代舊版</button>
          <button className="px-3 py-1 rounded-lg bg-brand text-white" onClick={() => combineWith(dup.docId)}>另一份單 → 兩份加埋一齊對</button>
        </div>
      ))}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          ['月結單', cs ? fmtMoney(cs.statementTotal) : '—', cs && cs.stockTotal ? `備貨 ${fmtMoney(cs.stockTotal)} 唔計` : null],
          ['成本錄入（到貨日）', cs ? fmtMoney(cs.costTotal) : '—', null],
          ['差額', cs ? (cs.diff ? fmtMoney(cs.diff) : '$0 ✓') : '—', null],
          ['分段確認', `${confirmedN} / ${data.sections.length}`, null],
        ].map(([k, v, sub]) => (
          <div key={k} className="rounded-xl border bg-card p-3">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className={`text-lg font-semibold tabular-nums ${k === '差額' && cs ? (cs.diff ? 'text-amber-700' : 'text-green-700') : ''}`}>{v}</div>
            {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
          </div>
        ))}
      </div>
      {cs && cs.uncovered.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm space-y-1">
          <div>以下醫生喺成本錄入有呢間 Lab 呢個月嘅成本，但月結單冇佢嘅分段（Lab 漏咗？醫生揀錯？）：</div>
          {cs.uncovered.map((u) => (
            <div key={`${u.clinicId}|${u.providerId}`} className="tabular-nums">· {cName(u.clinicId) ?? '—'} · {pName(u.providerId) ?? '—'}：{fmtMoney(u.total)}（{u.count} 筆）</div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {secs.map((s) => (
          <SectionRow key={s.id} docId={id} version={d.version} editable={HEADER_EDITABLE.has(d.status) && !d.supersededById} s={s} clinics={clinics} providers={providers} cName={cName} pName={pName} onChanged={load} />
        ))}
        {secs.length === 0 && !['UPLOADED', 'EXTRACTING'].includes(d.status) && <div className="text-sm text-muted-foreground">冇分段</div>}
      </div>

      {viewer && <LabDocViewer docId={id} meta={{ uploadedByName: null }} onClose={() => setViewer(false)} />}
    </div>
  )
}

function HeaderEditor({ docId, version, labId, month, labs, missing, onCancel, onSaved }: {
  docId: string
  version: number
  labId: string | null
  month: string | null
  labs: Array<{ id: string; name: string }>
  missing: boolean
  onCancel: (() => void) | null
  onSaved: () => void
}) {
  const [lab, setLab] = useState(labId ?? '')
  const [m, setM] = useState(month ?? '')
  const [busy, setBusy] = useState(false)
  const changed = (lab && lab !== labId) || (m && m !== month)

  const save = async () => {
    // 之前已經有 Lab＋月份 → 可能已經對過數；改咗要清走舊配對（後端做），先問一句
    if (labId && month && !window.confirm('改 Lab／月份會清走呢張月結單所有分段嘅配對同差異處理，再自動重新配對。確定？')) return
    setBusy(true)
    try {
      const r = await apiFetch<{ reconciled?: number }>(`/api/lab-docs/${docId}/statement-header`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(lab && lab !== labId ? { labId: lab } : {}),
          ...(m && m !== month ? { statementMonth: m } : {}),
          version,
        }),
      })
      toast.success(r?.reconciled ? `已更新，重新配對咗 ${r.reconciled} 段` : '已更新')
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`rounded-xl border p-3 text-sm space-y-2 ${missing ? 'border-amber-300 bg-amber-50' : 'bg-card'}`}>
      {missing && <div>讀單讀唔到{!labId ? ' Lab' : ''}{!labId && !month ? '同' : ''}{!month ? '月份' : ''} — 揀返先可以對數。</div>}
      <div className="flex flex-wrap items-center gap-2">
        <select className="border rounded px-2 py-1 bg-background" value={lab} onChange={(e) => setLab(e.target.value)}>
          <option value="">— Lab —</option>
          {labs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input type="month" className="border rounded px-2 py-1 bg-background" value={m} onChange={(e) => setM(e.target.value)} />
        <button onClick={save} disabled={busy || !changed} className="px-3 py-1 rounded-lg bg-brand text-white disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : '儲存'}
        </button>
        {onCancel && <button onClick={onCancel} className="px-3 py-1 rounded-lg border">取消</button>}
      </div>
    </div>
  )
}

function SectionRow({ docId, version, editable, s, clinics, providers, cName, pName, onChanged }: {
  docId: string
  version: number
  editable: boolean
  s: StmtSection
  clinics: Array<{ id: string; name: string }>
  providers: Array<{ id: string; name: string }>
  cName: (id: string | null) => string | null
  pName: (id: string | null) => string | null
  onChanged: () => void
}) {
  const [clinicId, setClinicId] = useState(s.clinicId ?? '')
  const [providerId, setProviderId] = useState(s.providerId ?? '')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const st = SECTION_STATUS[s.status] ?? { label: s.status, cls: 'bg-slate-100' }
  const rj = s.resultJson?.mode === 'COST' ? s.resultJson : null
  const diff = rj?.diff ?? null
  const needsAssign = s.status === 'NEEDS_ASSIGN'

  const assigned = !!s.clinicId || !!s.providerId
  const changing = (!!s.clinicId && !!clinicId && clinicId !== s.clinicId) || (!!s.providerId && !!providerId && providerId !== s.providerId)

  const assign = async () => {
    if (changing && !window.confirm('改診所／醫生會清走呢段嘅配對同差異處理，再自動重新配對。確定？')) return
    setBusy(true)
    const send = (opts: { remember: boolean; overwrite: boolean }) =>
      apiFetch(`/api/lab-docs/${docId}/sections/${s.id}/assign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clinicId: clinicId || null,
          providerId: providerId || null,
          rememberClinic: opts.remember && !!clinicId && clinicId !== s.clinicId,
          rememberProvider: opts.remember && !!providerId && providerId !== s.providerId,
          overwrite: opts.overwrite,
          version,
        }),
      })
    try {
      try {
        await send({ remember, overwrite: false })
      } catch (e) {
        // 之前「記住」咗另一個（例如上次揀錯）→ 問要唔要用新嘅蓋過；唔蓋就淨係改呢段、唔記住
        const err = e as Error & { status?: number; body?: { error?: string; message?: string } }
        if (err.status !== 409 || err.body?.error !== 'ALIAS_CONFLICT') throw e
        const overwrite = window.confirm(`${err.body.message ?? '之前記住咗另一個'}\n\n確定 = 以後都用新揀嘅；取消 = 淨係改呢段，唔記住`)
        await send({ remember: overwrite, overwrite })
      }
      toast.success('已指派，自動對緊數')
      setEditing(false)
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unassign = async () => {
    if (!window.confirm('解除呢段嘅診所／醫生？呢段嘅配對同差異處理會清走，要重新指派。')) return
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${docId}/sections/${s.id}/assign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unassign: true, version }),
      })
      toast.success('已解除指派')
      setEditing(false)
      setClinicId('')
      setProviderId('')
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const cancelEdit = () => {
    setEditing(false)
    setClinicId(s.clinicId ?? '')
    setProviderId(s.providerId ?? '')
  }
  const canEdit = editable && s.status !== 'CONFIRMED'
  const showPicker = canEdit && (needsAssign || !s.clinicId || !s.providerId || editing)

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{cName(s.clinicId) ?? s.clinicRaw ?? '診所未識別'} · {pName(s.providerId) ?? s.doctorRaw ?? '醫生未識別'}</div>
          <div className="text-xs text-muted-foreground truncate">
            單上：{s.clinicRaw ?? '—'} / {s.doctorRaw ?? '—'}{s.pageFrom ? ` · 第 ${s.pageFrom}${s.pageTo && s.pageTo !== s.pageFrom ? `–${s.pageTo}` : ''} 頁` : ''} · {s.lines.length} 行
          </div>
        </div>
        <div className="text-right text-sm tabular-nums hidden sm:block">
          <div>月結 {rj ? fmtMoney(rj.statementTotal) : '—'}</div>
          <div className="text-muted-foreground">成本 {rj ? fmtMoney(rj.costTotal) : '—'}{diff ? ` · 差 ${fmtMoney(diff)}` : ''}</div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span>
        {canEdit && assigned && !editing && (
          <button onClick={() => setEditing(true)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" title="改診所／醫生"><Pencil size={13} />改</button>
        )}
        <Link href={`/lab-docs/statements/${docId}/sections/${s.id}`} className="flex items-center text-sm text-brand">{needsAssign ? '睇／標備貨' : '對數'}<ChevronRight size={14} /></Link>
      </div>
      {s.costEvidence?.flag && (
        <div className="mt-2 text-xs text-red-600">有成本仲套緊月度折扣：{s.costEvidence.discountCosts.map((c) => `${c.itemType ?? '—'} ${c.discountPct}%`).join('、')}</div>
      )}
      {showPicker && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <select className="border rounded px-2 py-1" value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
            <option value="">— 診所 —</option>
            {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="border rounded px-2 py-1" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">— 醫生 —</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />記住（下次自動認）</label>
          <button onClick={assign} disabled={busy || (!clinicId && !providerId) || (clinicId === (s.clinicId ?? '') && providerId === (s.providerId ?? ''))} className="px-3 py-1 rounded-lg bg-brand text-white disabled:opacity-40">指派</button>
          {assigned && <button onClick={unassign} disabled={busy} className="px-3 py-1 rounded-lg border text-red-600 disabled:opacity-40">解除指派</button>}
          {editing && <button onClick={cancelEdit} disabled={busy} className="px-3 py-1 rounded-lg border">取消</button>}
        </div>
      )}
    </div>
  )
}
