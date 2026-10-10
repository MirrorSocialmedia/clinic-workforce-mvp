'use client'

/**
 * ★ cwm-labdoc §12.3：/lab-docs/statements/[id] — 月結單總覽（電腦優先）
 *
 * - 頭：Lab、月份、頁數、讀法、收款人警告；「睇原檔」
 * - 統計：月結單總數、系統已對、差額、分段確認進度
 * - 分段表：未識別（NEEDS_ASSIGN）排第一 → 即場揀診所／醫生（可剔「記住」寫 alias）
 * - 重複分段 → 「取代舊版」（要原因；舊版已處理嘅差異會帶過嚟）
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ChevronRight, ImageIcon, Loader2 } from 'lucide-react'
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
  resultJson: { counts?: Record<string, number>; statedTotal?: number | null } | null
  costEvidence: { totalFinalCost: number | null; discountCosts: Array<{ id: string; itemType: string | null; discountPct: number }>; flag: boolean }
  newInvoicesSinceRun: number
  duplicate: { docId: string; uploadedAt: string } | null
  lines: StmtLine[]
}
export interface StmtLine {
  id: string
  lineIndex: number
  lineType: string
  docNoRaw: string | null
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
    uploadedBy: string
    createdAt: string
  }
  pages: Array<{ id: string }>
  sections: StmtSection[]
  statementMonthFromLines: boolean
}

export const SECTION_STATUS: Record<string, { label: string; cls: string }> = {
  NEEDS_ASSIGN: { label: '未識別', cls: 'bg-red-100 text-red-700' },
  PENDING: { label: '未對', cls: 'bg-slate-100 text-slate-600' },
  OK: { label: '一致', cls: 'bg-green-100 text-green-700' },
  DIFF: { label: '有差異', cls: 'bg-amber-100 text-amber-700' },
  CONFIRMED: { label: '已確認', cls: 'bg-emerald-100 text-emerald-700' },
}
const KIND_LABEL: Record<string, string> = { DETAIL: '明細型', INVOICE_LIST: '單號型', OUTSTANDING: '欠款型' }

export const stated = (s: StmtSection) => (s.statedCurrent ?? s.statedTotal)

export default function StatementDetail({ id }: { id: string }) {
  const [data, setData] = useState<StmtResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [clinics, setClinics] = useState<Array<{ id: string; name: string }>>([])
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  const [viewer, setViewer] = useState(false)

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
  const statedSum = data.sections.reduce((a, s) => a + (stated(s) ?? 0), 0)
  const sysSum = data.sections.reduce((a, s) => a + (s.systemTotal ?? 0), 0)
  const confirmedN = data.sections.filter((s) => s.status === 'CONFIRMED').length
  const cName = (cid: string | null) => (cid ? clinics.find((c) => c.id === cid)?.name ?? '—' : null)
  const pName = (pid: string | null) => (pid ? providers.find((p) => p.id === pid)?.name ?? '—' : null)

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
      </div>

      {d.supersededById && (
        <div className="rounded-xl border bg-muted p-3 text-sm">已被取代 — <Link className="underline" href={`/lab-docs/statements/${d.supersededById}`}>開新版</Link></div>
      )}
      {['UPLOADED', 'EXTRACTING'].includes(d.status) && <div className="rounded-xl border bg-blue-50 p-3 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" />讀緊月結單…</div>}
      {d.status === 'EXTRACT_FAILED' && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">讀唔到（{d.extractError ?? '讀單失敗'}）— 去「待處理」撳再讀，或者影清楚啲再上傳。</div>}
      {d.payeeIsNew && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">⚠ 收款人「{d.payeeRaw}」唔喺已知名單 — 付款前同 Lab 確認</div>}
      {data.statementMonthFromLines && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">月份係由行嘅日期推斷 — 請核對</div>}
      {dups.map((dup) => (
        <div key={dup.docId} className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm flex flex-wrap items-center gap-2">
          <span className="flex-1">同一個月、同 Lab／診所／醫生嘅月結單已經喺 {dup.uploadedAt} 上傳過 — 要先取代舊版先可以處理。</span>
          <Link className="underline" href={`/lab-docs/statements/${dup.docId}`}>睇舊版</Link>
          <button className="px-3 py-1 rounded-lg bg-brand text-white" onClick={() => supersede(dup.docId)}>取代舊版</button>
        </div>
      ))}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          ['月結單總數', fmtMoney(statedSum)],
          ['系統已對', fmtMoney(sysSum)],
          ['差額', fmtMoney(Math.round((statedSum - sysSum) * 100) / 100)],
          ['分段確認', `${confirmedN} / ${data.sections.length}`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border bg-card p-3">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className="text-lg font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        {secs.map((s) => (
          <SectionRow key={s.id} docId={id} version={d.version} s={s} clinics={clinics} providers={providers} cName={cName} pName={pName} onChanged={load} />
        ))}
        {secs.length === 0 && !['UPLOADED', 'EXTRACTING'].includes(d.status) && <div className="text-sm text-muted-foreground">冇分段</div>}
      </div>

      {viewer && <LabDocViewer docId={id} meta={{ uploadedByName: null }} onClose={() => setViewer(false)} />}
    </div>
  )
}

function SectionRow({ docId, version, s, clinics, providers, cName, pName, onChanged }: {
  docId: string
  version: number
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
  const st = SECTION_STATUS[s.status] ?? { label: s.status, cls: 'bg-slate-100' }
  const stt = stated(s)
  const diff = stt !== null && s.systemTotal !== null ? Math.round((stt - s.systemTotal) * 100) / 100 : null
  const needsAssign = s.status === 'NEEDS_ASSIGN'

  const assign = async () => {
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${docId}/sections/${s.id}/assign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clinicId: clinicId || null,
          providerId: providerId || null,
          rememberClinic: remember && !!clinicId && clinicId !== s.clinicId,
          rememberProvider: remember && !!providerId && providerId !== s.providerId,
          version,
        }),
      })
      toast.success('已指派，自動對緊數')
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

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
          <div>月結 {fmtMoney(stt)}</div>
          <div className="text-muted-foreground">系統 {fmtMoney(s.systemTotal)}{diff ? ` · 差 ${fmtMoney(diff)}` : ''}</div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span>
        {!needsAssign && (
          <Link href={`/lab-docs/statements/${docId}/sections/${s.id}`} className="flex items-center text-sm text-brand">對數<ChevronRight size={14} /></Link>
        )}
      </div>
      {s.costEvidence?.flag && (
        <div className="mt-2 text-xs text-red-600">有成本仲套緊月度折扣：{s.costEvidence.discountCosts.map((c) => `${c.itemType ?? '—'} ${c.discountPct}%`).join('、')}</div>
      )}
      {(needsAssign || (!s.clinicId || !s.providerId)) && s.status !== 'CONFIRMED' && (
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
          <button onClick={assign} disabled={busy || (!clinicId && !providerId)} className="px-3 py-1 rounded-lg bg-brand text-white disabled:opacity-40">指派</button>
        </div>
      )}
    </div>
  )
}
