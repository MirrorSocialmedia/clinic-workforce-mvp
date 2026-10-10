'use client'

/**
 * ★ cwm-labdoc §12.2：/lab-docs/invoices/[id] — 確認頭部 → 逐個病人分組對成本（手機優先）
 *
 * - 未確認（NEEDS_REVIEW／EXTRACT_FAILED）：頭部＋行可改 → 「確認」（PUT /header；讀單失敗 = 人手輸入 PUT /manual）
 * - 已確認：分組卡（候選成本 radio、行剔選、改做／填入、確認到貨、新增成本）→ 「儲存」（POST groups/:g/save）
 * - 合計條：行合計 = 單總數先俾確認（§5.5）
 * - 「睇相」開 LabDocViewer；「再讀」（讀單失敗）；「作廢」
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, ImageIcon, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, type ApiError } from '@/lib/api-client'
import { ITEM_TYPES } from '@/lib/payout/constants'
import { fmtMoney, hkDate, statusMeta } from './status-meta'
import LabDocViewer from './LabDocViewer'

interface DocLine {
  id: string
  groupIndex: number
  lineIndex: number
  description: string | null
  toothRaw: string | null
  qty: number | null
  unitPrice: number | null
  listPrice: number | null
  discountRaw: string | null
  amount: number
  isZero: boolean
  status: string
  ignoreReason: string | null
  patientCodeRaw: string | null
  patientCode: string | null
  patientNameRaw: string | null
  costCaseId: string | null
  linkType: string | null
  costCase: { id: string; itemType: string | null; baseCost: number | null; status: string } | null
}
interface DocResp {
  document: {
    id: string
    kind: string
    status: string
    labId: string | null
    labName: string | null
    labNameRaw: string | null
    labBasis: string | null
    clinicId: string | null
    clinicBasis: string | null
    clinicEvidence: string | null
    providerId: string | null
    providerBasis: string | null
    providerEvidence: string | null
    docNo: string | null
    docDate: string | null
    deliveryDate: string | null
    total: string | null
    readIssues: string[]
    extractError?: string | null
    manualAmountEdit: boolean
    version: number
    duplicateOfId: string | null
    voidReason: string | null
  }
  lines: DocLine[]
  groupCount: number
}

interface EditLine {
  lineId: string | null
  description: string
  toothRaw: string
  qty: string
  unitPrice: string
  amount: string
  locked: boolean // MATCHED 行唔准刪
}
interface EditGroup {
  groupIndex: number
  patientCodeRaw: string
  patientNameRaw: string | null
  lines: EditLine[]
}

const HEADER_EDITABLE = new Set(['NEEDS_REVIEW', 'EXTRACT_FAILED', 'CONFIRMED', 'PARTIAL', 'RECONCILED'])
const RECONCILE_READY = new Set(['CONFIRMED', 'PARTIAL', 'RECONCILED'])
const BASIS_LABEL: Record<string, string> = {
  NAME: '名稱', ALIAS: '別名', ADDRESS: '地址', CUSTOMER_NO: '客戶編號', SHORT_CODE: '簡稱', CLINIC_ALIAS: '診所別名',
  PROVIDER_ALIAS: '醫生別名', MANUAL: '人手', PAYEE: '收款人',
}
const num = (s: string): number | null => (s.trim() === '' ? null : Number(s))
const r2 = (n: number) => Math.round(n * 100) / 100

export default function InvoiceDetail({ id }: { id: string }) {
  const [data, setData] = useState<DocResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [labs, setLabs] = useState<Array<{ id: string; name: string }>>([])
  const [clinics, setClinics] = useState<Array<{ id: string; name: string }>>([])
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  const [editHeader, setEditHeader] = useState(false)
  const [viewer, setViewer] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<DocResp>(`/api/lab-docs/${id}`))
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [id])

  useEffect(() => {
    load()
    apiFetch<{ labs: Array<{ id: string; name: string; isActive?: boolean }> }>('/api/labs')
      .then((d) => setLabs((d.labs || []).filter((l) => l.isActive !== false)))
      .catch(() => {})
    apiFetch<{ clinics: Array<{ id: string; name: string }> }>('/api/clinics').then((d) => setClinics(d.clinics || [])).catch(() => {})
    apiFetch<{ providers: Array<{ id: string; name: string }> }>('/api/providers').then((d) => setProviders(d.providers || [])).catch(() => {})
  }, [id, load])

  // 讀緊 → 每 3 秒刷新
  useEffect(() => {
    if (!data || !['UPLOADED', 'EXTRACTING'].includes(data.document.status)) return
    const t = setTimeout(load, 3000)
    return () => clearTimeout(t)
  }, [data, load])

  if (err) return <div className="max-w-3xl mx-auto p-4 text-sm text-red-600">{err}</div>
  if (!data) return <div className="flex justify-center py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin mr-2" />載入中…</div>

  const d = data.document
  const sm = statusMeta(d.status)
  const confirmed = RECONCILE_READY.has(d.status)
  const showHeaderEditor = (!confirmed && HEADER_EDITABLE.has(d.status)) || (confirmed && editHeader)
  const groups = [...new Set(data.lines.map((l) => l.groupIndex))].sort((a, b) => a - b)

  const retry = async () => {
    setBusy(true)
    try {
      await apiFetch(`/api/lab-docs/${id}/retry`, { method: 'POST' })
      toast.success('再讀緊')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const voidDoc = async () => {
    const reason = window.prompt('作廢原因（例：影錯相、重複）')
    if (!reason?.trim()) return
    try {
      await apiFetch(`/api/lab-docs/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) })
      toast.success('已作廢')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-4 pb-44 md:pb-6 space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/lab-docs" className="p-2 -ml-2 rounded-lg hover:bg-accent" aria-label="返回"><ArrowLeft size={18} /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{d.docNo ?? '未識別單號'} · {d.labName ?? d.labNameRaw ?? 'Lab 未識別'}</h1>
          <div className="text-xs text-muted-foreground">{hkDate(d.docDate)} · 總數 {fmtMoney(d.total)}</div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sm.cls}`}>{sm.label}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setViewer(true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-card text-sm"><ImageIcon size={14} />睇相</button>
        {d.status === 'EXTRACT_FAILED' && (
          <button onClick={retry} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-card text-sm"><RotateCcw size={14} />再讀</button>
        )}
        {confirmed && !editHeader && (
          <button onClick={() => setEditHeader(true)} className="px-3 py-1.5 rounded-lg border bg-card text-sm">改頭部／行</button>
        )}
        {d.status !== 'VOID' && (
          <button onClick={voidDoc} className="px-3 py-1.5 rounded-lg border bg-card text-sm text-red-600">作廢</button>
        )}
      </div>

      {d.status === 'VOID' && <div className="rounded-xl border bg-muted p-3 text-sm">已作廢：{d.voidReason}</div>}
      {d.status === 'DUPLICATE' && d.duplicateOfId && (
        <div className="rounded-xl border bg-muted p-3 text-sm">
          呢張係重複單 — <Link className="underline" href={`/lab-docs/invoices/${d.duplicateOfId}`}>開原本嗰張</Link>
        </div>
      )}
      {['UPLOADED', 'EXTRACTING'].includes(d.status) && (
        <div className="rounded-xl border bg-blue-50 p-3 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" />讀緊張單…</div>
      )}
      {d.status === 'EXTRACT_FAILED' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">
          讀唔到呢張單（{d.extractError ?? '讀單失敗'}）。可以撳「再讀」，或者喺下面人手輸入。
        </div>
      )}
      {d.readIssues?.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs space-y-0.5">
          {d.readIssues.filter((x) => !x.startsWith('SECTION_DUPLICATE') && x !== 'STATEMENT_MONTH_FROM_LINES').map((x, i) => <div key={i}>⚠ {x}</div>)}
        </div>
      )}

      {showHeaderEditor && (
        <HeaderEditor
          data={data}
          labs={labs}
          clinics={clinics}
          providers={providers}
          onDone={() => { setEditHeader(false); load() }}
          onCancel={confirmed ? () => setEditHeader(false) : undefined}
        />
      )}

      {confirmed && !editHeader && (
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            {clinics.find((c) => c.id === d.clinicId)?.name ?? '診所未識別'} · {providers.find((p) => p.id === d.providerId)?.name ?? '醫生未識別'}
          </div>
          {groups.map((g) => (
            <GroupCard key={`${g}-${d.version}`} docId={id} groupIndex={g} doc={d} lines={data.lines.filter((l) => l.groupIndex === g)} providers={providers} onSaved={load} />
          ))}
        </div>
      )}

      {viewer && <LabDocViewer docId={id} meta={{ uploadedByName: null }} onClose={() => setViewer(false)} />}
    </div>
  )
}

// ------------------------------------------------------------------
// 頭部確認（§7.1）
// ------------------------------------------------------------------
function HeaderEditor({ data, labs, clinics, providers, onDone, onCancel }: {
  data: DocResp
  labs: Array<{ id: string; name: string }>
  clinics: Array<{ id: string; name: string }>
  providers: Array<{ id: string; name: string }>
  onDone: () => void
  onCancel?: () => void
}) {
  const d = data.document
  const [labId, setLabId] = useState(d.labId ?? '')
  const [clinicId, setClinicId] = useState(d.clinicId ?? '')
  const [providerId, setProviderId] = useState(d.providerId ?? '')
  const [docNo, setDocNo] = useState(d.docNo ?? '')
  const [docDate, setDocDate] = useState(d.docDate ? String(d.docDate).slice(0, 10) : '')
  const [total, setTotal] = useState(d.total ?? '')
  const [groups, setGroups] = useState<EditGroup[]>(() => {
    const m = new Map<number, EditGroup>()
    for (const l of data.lines) {
      if (!m.has(l.groupIndex)) m.set(l.groupIndex, { groupIndex: l.groupIndex, patientCodeRaw: l.patientCodeRaw ?? '', patientNameRaw: l.patientNameRaw, lines: [] })
      m.get(l.groupIndex)!.lines.push({
        lineId: l.id,
        description: l.description ?? '',
        toothRaw: l.toothRaw ?? '',
        qty: l.qty == null ? '' : String(l.qty),
        unitPrice: l.unitPrice == null ? '' : String(l.unitPrice),
        amount: String(l.amount),
        locked: l.status === 'MATCHED',
      })
    }
    const arr = [...m.values()]
    return arr.length > 0 ? arr : [{ groupIndex: 0, patientCodeRaw: '', patientNameRaw: null, lines: [{ lineId: null, description: '', toothRaw: '', qty: '1', unitPrice: '', amount: '', locked: false }] }]
  })
  const [saving, setSaving] = useState(false)

  const lineSum = useMemo(() => r2(groups.reduce((a, g) => a + g.lines.reduce((b, l) => b + (Number(l.amount) || 0), 0), 0)), [groups])
  const totalNum = num(String(total))
  const diff = totalNum === null ? null : r2(lineSum - totalNum)

  const setLine = (gi: number, li: number, patch: Partial<EditLine>) =>
    setGroups((gs) => gs.map((g, i) => (i !== gi ? g : { ...g, lines: g.lines.map((l, j) => {
      if (j !== li) return l
      const n = { ...l, ...patch }
      // 數量×單價 自動計金額（未手改金額先）
      if (('qty' in patch || 'unitPrice' in patch) && n.qty !== '' && n.unitPrice !== '') n.amount = String(r2(Number(n.qty) * Number(n.unitPrice)))
      return n
    }) })))

  const basis = (b: string | null, ev?: string | null) => (b ? `依據：${BASIS_LABEL[b] ?? b}${ev ? `「${ev}」` : ''}` : '未識別 — 請揀')

  const submit = async () => {
    setSaving(true)
    try {
      const body = {
        version: d.version,
        labId: labId || null,
        clinicId: clinicId || null,
        providerId: providerId || null,
        docNo: docNo.trim() || null,
        docDate: docDate || null,
        total: totalNum,
        groups: groups.map((g) => ({
          groupIndex: g.groupIndex,
          patientCodeRaw: g.patientCodeRaw.trim() || null,
          patientNameRaw: g.patientNameRaw,
          lines: g.lines.map((l) => ({
            ...(l.lineId ? { lineId: l.lineId } : {}),
            description: l.description,
            toothRaw: l.toothRaw || null,
            qty: num(l.qty),
            unitPrice: num(l.unitPrice),
            listPrice: null,
            discountRaw: null,
            amount: Number(l.amount) || 0,
          })),
        })),
      }
      const url = d.status === 'EXTRACT_FAILED' ? `/api/lab-docs/${d.id}/manual` : `/api/lab-docs/${d.id}/header`
      await apiFetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      toast.success('已確認')
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const inp = 'w-full border rounded-lg px-2 py-1.5 text-sm bg-background'
  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-card p-3 space-y-2">
        <label className="block text-xs text-muted-foreground">Lab
          <select className={inp} value={labId} onChange={(e) => setLabId(e.target.value)}>
            <option value="">— 未揀 —</option>
            {labs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <span className="text-[11px]">{basis(d.labBasis, d.labNameRaw)}</span>
        </label>
        <label className="block text-xs text-muted-foreground">診所
          <select className={inp} value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
            <option value="">— 未揀 —</option>
            {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="text-[11px]">{basis(d.clinicBasis, d.clinicEvidence)}</span>
        </label>
        <label className="block text-xs text-muted-foreground">醫生
          <select className={inp} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">— 未揀 —</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="text-[11px]">{basis(d.providerBasis, d.providerEvidence)}</span>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs text-muted-foreground">單號<input className={inp} value={docNo} onChange={(e) => setDocNo(e.target.value)} /></label>
          <label className="text-xs text-muted-foreground">日期<input type="date" className={inp} value={docDate} onChange={(e) => setDocDate(e.target.value)} /></label>
          <label className="text-xs text-muted-foreground">單總數<input inputMode="decimal" className={inp} value={total} onChange={(e) => setTotal(e.target.value)} /></label>
        </div>
      </div>

      {groups.map((g, gi) => (
        <div key={gi} className="rounded-xl border bg-card p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">病人 {gi + 1}</span>
            <input className="border rounded-lg px-2 py-1 text-sm w-32" placeholder="病人編號" value={g.patientCodeRaw}
              onChange={(e) => setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, patientCodeRaw: e.target.value } : x)))} />
            <span className="text-xs text-muted-foreground truncate">{g.patientNameRaw ?? ''}</span>
          </div>
          {g.lines.map((l, li) => (
            <div key={li} className="grid grid-cols-12 gap-1 items-center">
              <input className="col-span-12 sm:col-span-5 border rounded px-2 py-1 text-sm" placeholder="描述" value={l.description} onChange={(e) => setLine(gi, li, { description: e.target.value })} />
              <input className="col-span-3 sm:col-span-1 border rounded px-1 py-1 text-sm" placeholder="牙位" value={l.toothRaw} onChange={(e) => setLine(gi, li, { toothRaw: e.target.value })} />
              <input className="col-span-2 sm:col-span-1 border rounded px-1 py-1 text-sm text-right" inputMode="decimal" placeholder="數量" value={l.qty} onChange={(e) => setLine(gi, li, { qty: e.target.value })} />
              <input className="col-span-3 sm:col-span-2 border rounded px-1 py-1 text-sm text-right" inputMode="decimal" placeholder="單價" value={l.unitPrice} onChange={(e) => setLine(gi, li, { unitPrice: e.target.value })} />
              <input className="col-span-3 sm:col-span-2 border rounded px-1 py-1 text-sm text-right" inputMode="decimal" placeholder="金額" value={l.amount} onChange={(e) => setLine(gi, li, { amount: e.target.value })} />
              <button className="col-span-1 p-1 text-muted-foreground disabled:opacity-30" disabled={l.locked} title={l.locked ? '已連成本 — 要先解除配對' : '刪行'}
                onClick={() => setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, lines: x.lines.filter((_, j) => j !== li) } : x)))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button className="text-xs text-brand flex items-center gap-1"
            onClick={() => setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, lines: [...x.lines, { lineId: null, description: '', toothRaw: '', qty: '1', unitPrice: '', amount: '', locked: false }] } : x)))}>
            <Plus size={12} />加行
          </button>
        </div>
      ))}
      <button className="text-sm text-brand flex items-center gap-1"
        onClick={() => setGroups((gs) => [...gs, { groupIndex: Math.max(-1, ...gs.map((x) => x.groupIndex)) + 1, patientCodeRaw: '', patientNameRaw: null, lines: [{ lineId: null, description: '', toothRaw: '', qty: '1', unitPrice: '', amount: '', locked: false }] }])}>
        <Plus size={14} />加病人
      </button>

      {/* 手機：底部導航高 4rem（AdminMobileNav）→ 企喺佢上面 */}
      <div className="fixed bottom-16 inset-x-0 z-30 border-t bg-background/95 backdrop-blur p-3 md:static md:border md:rounded-xl md:bg-card">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className={`flex-1 text-sm ${diff === 0 ? 'text-green-700' : 'text-red-600'}`}>
            {diff === 0 ? `✓ 行合計 ${fmtMoney(lineSum)} ＝ 單總數 ${fmtMoney(totalNum)}`
              : totalNum === null ? '單總數未填' : `行合計 ${fmtMoney(lineSum)}，單總數 ${fmtMoney(totalNum)}，差 ${fmtMoney(Math.abs(diff ?? 0))}`}
          </div>
          {onCancel && <button onClick={onCancel} className="px-4 py-2 rounded-lg border text-sm">取消</button>}
          <button onClick={submit} disabled={saving || diff !== 0} className="px-5 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-40">
            {saving ? '確認緊…' : '確認'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// 分組卡（§7.3–7.8）
// ------------------------------------------------------------------
interface Cand {
  caseId: string
  itemType: string | null
  itemTypeOther: string | null
  orderedAt: string | null
  providerName: string | null
  clinicName: string | null
  baseCost: number | null
  status: string
  isRedo: boolean
  receivedAt: string | null
  lockedByRunId: boolean
  mainLink: { docId: string; docNo: string | null } | null
  linkedSum: number
}
interface CandResp {
  code: string | null
  groupSum: number
  systemName: string | null
  candidates: Cand[]
  defaults: { selectedCostCaseId: string | null; lineActions: Array<{ lineId: string; action: string }>; showNewCase: boolean }
}

function GroupCard({ docId, groupIndex, doc, lines, providers, onSaved }: {
  docId: string
  groupIndex: number
  doc: DocResp['document']
  lines: DocLine[]
  providers: Array<{ id: string; name: string }>
  onSaved: () => void
}) {
  const [c, setC] = useState<CandResp | null>(null)
  const [cErr, setCErr] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [linkType, setLinkType] = useState<'MAIN' | 'SUPPLEMENT' | 'REDO'>('MAIN')
  const [updatePrice, setUpdatePrice] = useState(true)
  const [recvOn, setRecvOn] = useState(true)
  const [recvDate, setRecvDate] = useState(String(doc.deliveryDate ?? doc.docDate ?? '').slice(0, 10))
  const [newCase, setNewCase] = useState(false)
  const [itemType, setItemType] = useState('')
  const [ncProvider, setNcProvider] = useState(doc.providerId ?? '')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(true)

  const unmatched = lines.filter((l) => l.status === 'UNMATCHED')
  const matched = lines.filter((l) => l.status === 'MATCHED')
  const done = unmatched.length === 0

  useEffect(() => {
    if (done) { setOpen(false); return }
    apiFetch<CandResp>(`/api/lab-docs/${docId}/groups/${groupIndex}/candidates`)
      .then((r) => {
        setC(r)
        setSel(r.defaults.selectedCostCaseId)
        const ck: Record<string, boolean> = {}
        for (const l of unmatched) ck[l.id] = true // §7.4：$0 行跟同組
        setChecked(ck)
        setNewCase(r.candidates.length === 0)
      })
      .catch((e) => setCErr((e as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, groupIndex, done])

  const cand = c?.candidates.find((x) => x.caseId === sel) ?? null
  const selSum = r2(unmatched.filter((l) => checked[l.id]).reduce((a, l) => a + l.amount, 0))
  const newBase = cand ? r2(cand.linkedSum + selSum) : selSum
  useEffect(() => {
    if (cand?.mainLink) setLinkType('SUPPLEMENT')
    else setLinkType('MAIN')
    setRecvOn(!!cand && !cand.receivedAt)
  }, [cand?.caseId]) // eslint-disable-line react-hooks/exhaustive-deps

  const priceState = !cand ? null
    : cand.lockedByRunId ? { label: '已出月結 — 只連單唔改價', cls: 'text-slate-500', can: false }
    : cand.baseCost === null ? { label: `填入 ${fmtMoney(newBase)}`, cls: 'text-blue-700', can: true }
    : Math.abs(cand.baseCost - newBase) < 0.01 ? { label: '✓ 一致', cls: 'text-green-700', can: false }
    : { label: `改做 ${fmtMoney(newBase)}（而家 ${fmtMoney(cand.baseCost)}）`, cls: 'text-amber-700', can: true }

  const save = async (confirmLarge = false) => {
    if (!cand) return
    setSaving(true)
    try {
      const acts = unmatched.filter((l) => checked[l.id]).map((l) => ({
        lineId: l.id,
        action: 'MATCH',
        costCaseId: cand.caseId,
        linkType,
        ...(recvOn && recvDate && !cand.lockedByRunId ? { receivedAt: recvDate } : {}),
      }))
      if (acts.length === 0) { toast.error('剔最少一行'); return }
      const fresh = await apiFetch<DocResp>(`/api/lab-docs/${docId}`)
      await apiFetch(`/api/lab-docs/${docId}/groups/${groupIndex}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: fresh.document.version,
          idempotencyKey: crypto.randomUUID(),
          lines: acts,
          ...(priceState?.can && updatePrice ? { priceUpdates: [{ costCaseId: cand.caseId }] } : {}),
          ...(confirmLarge ? { confirmLargePriceChange: true } : {}),
        }),
      })
      toast.success('已儲存')
      onSaved()
    } catch (e) {
      const ae = e as ApiError
      if (ae.status === 409 && ae.body?.code === 'PRICE_CHANGE_CONFIRM') {
        if (window.confirm(`${ae.message}\n\n確定揀啱呢筆成本？`)) { setSaving(false); return save(true) }
      } else toast.error(ae.message)
    } finally {
      setSaving(false)
    }
  }

  const createCase = async () => {
    if (!itemType) { toast.error('揀項目'); return }
    if (!c?.code) { toast.error('病人編號未識別 — 先返去改頭部填病人編號'); return }
    setSaving(true)
    try {
      await apiFetch(`/api/lab-docs/${docId}/new-case`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), groupIndex, patientCodeNorm: c.code, itemType, providerId: ncProvider || null }),
      })
      toast.success('已新增成本並連好')
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const unmatchLine = async (l: DocLine) => {
    if (!l.costCaseId || !window.confirm('解除呢行同成本嘅配對？（成本金額唔會自動改返）')) return
    try {
      const fresh = await apiFetch<DocResp>(`/api/lab-docs/${docId}`)
      await apiFetch(`/api/lab-docs/${docId}/groups/${groupIndex}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: fresh.document.version, idempotencyKey: crypto.randomUUID(), lines: [{ lineId: l.id, action: 'UNMATCH', costCaseId: l.costCaseId }] }),
      })
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const ignoreLine = async (l: DocLine) => {
    const reason = window.prompt('點解唔使連成本？（例：模型費 $0、退貨）')
    if (!reason?.trim()) return
    try {
      const fresh = await apiFetch<DocResp>(`/api/lab-docs/${docId}`)
      await apiFetch(`/api/lab-docs/${docId}/groups/${groupIndex}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: fresh.document.version, idempotencyKey: crypto.randomUUID(), lines: [{ lineId: l.id, action: 'IGNORE', ignoreReason: reason.trim().slice(0, 60) }] }),
      })
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const code = lines[0]?.patientCode ?? lines[0]?.patientCodeRaw ?? '未有編號'
  return (
    <div className="rounded-xl border bg-card">
      <button className="w-full flex items-center justify-between p-3 text-left" onClick={() => setOpen((o) => !o)}>
        <div>
          <div className="font-medium">{code} <span className="text-sm text-muted-foreground">{c?.systemName ?? ''} {lines[0]?.patientNameRaw ? `（單：${lines[0].patientNameRaw}）` : ''}</span></div>
          <div className="text-xs text-muted-foreground">{lines.length} 行 · {fmtMoney(lines.reduce((a, l) => a + l.amount, 0))}</div>
        </div>
        {done ? <span className="text-xs text-green-700 flex items-center gap-1"><Check size={14} />已儲存</span> : <span className="text-xs text-amber-700">未對</span>}
      </button>
      {open && (
        <div className="border-t p-3 space-y-3">
          <div className="space-y-1">
            {lines.map((l) => (
              <div key={l.id} className={`flex items-center gap-2 text-sm ${l.isZero ? 'text-muted-foreground' : ''}`}>
                {l.status === 'UNMATCHED' ? (
                  <input type="checkbox" checked={!!checked[l.id]} onChange={(e) => setChecked((x) => ({ ...x, [l.id]: e.target.checked }))} />
                ) : <span className="w-[13px]" />}
                <span className="flex-1 truncate">{l.description}{l.toothRaw ? ` · ${l.toothRaw}` : ''}{l.qty ? ` ×${l.qty}` : ''}</span>
                <span className="tabular-nums">{fmtMoney(l.amount)}</span>
                {l.status === 'MATCHED' && (
                  <button className="text-[11px] underline text-muted-foreground" onClick={() => unmatchLine(l)}>
                    已連 {l.costCase?.itemType ?? '成本'}{l.linkType && l.linkType !== 'MAIN' ? `（${l.linkType === 'SUPPLEMENT' ? '補收費' : '重做'}）` : ''} · 解除
                  </button>
                )}
                {l.status === 'IGNORED' && <span className="text-[11px] text-muted-foreground">忽略：{l.ignoreReason}</span>}
                {l.status === 'UNMATCHED' && <button className="text-[11px] underline text-muted-foreground" onClick={() => ignoreLine(l)}>忽略</button>}
              </div>
            ))}
          </div>

          {!done && cErr && <div className="text-sm text-red-600">{cErr}</div>}
          {!done && c && (
            <>
              {c.candidates.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">揀成本（{c.code ?? '病人未識別'}）</div>
                  {c.candidates.map((x) => (
                    <label key={x.caseId} className={`flex items-start gap-2 rounded-lg border p-2 text-sm ${sel === x.caseId ? 'border-brand bg-brand/5' : ''} ${x.lockedByRunId ? 'opacity-70' : ''}`}>
                      <input type="radio" name={`g${groupIndex}`} checked={sel === x.caseId} onChange={() => setSel(x.caseId)} className="mt-1" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{x.itemType ?? '—'}{x.itemTypeOther ? `（${x.itemTypeOther}）` : ''} · {x.baseCost === null ? '未有價' : fmtMoney(x.baseCost)}</div>
                        <div className="text-xs text-muted-foreground">{x.providerName ?? '—'} · 落單 {x.orderedAt ?? '—'}{x.receivedAt ? ` · 到貨 ${x.receivedAt}` : ''}</div>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {x.baseCost !== null && Math.abs(x.baseCost - c.groupSum) < 0.01 && <span className="px-1.5 rounded bg-green-100 text-green-700 text-[11px]">金額一樣</span>}
                          {x.mainLink && <span className="px-1.5 rounded bg-slate-100 text-slate-600 text-[11px]">已連單 {x.mainLink.docNo ?? ''}</span>}
                          {x.lockedByRunId && <span className="px-1.5 rounded bg-slate-200 text-slate-600 text-[11px]">已出月結</span>}
                          {x.isRedo && <span className="px-1.5 rounded bg-amber-100 text-amber-700 text-[11px]">重做中</span>}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {cand && (
                <div className="rounded-lg bg-muted/40 p-2 space-y-2 text-sm">
                  {cand.mainLink && (
                    <label className="flex items-center gap-2">類型
                      <select className="border rounded px-2 py-1" value={linkType} onChange={(e) => setLinkType(e.target.value as 'SUPPLEMENT' | 'REDO')}>
                        <option value="SUPPLEMENT">補收費</option>
                        <option value="REDO">重做</option>
                      </select>
                    </label>
                  )}
                  {priceState && (
                    <label className={`flex items-center gap-2 ${priceState.cls}`}>
                      {priceState.can && <input type="checkbox" checked={updatePrice} onChange={(e) => setUpdatePrice(e.target.checked)} />}
                      {priceState.label}
                    </label>
                  )}
                  {!cand.lockedByRunId && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={recvOn} onChange={(e) => setRecvOn(e.target.checked)} />確認到貨
                      <input type="date" className="border rounded px-2 py-1" value={recvDate} onChange={(e) => setRecvDate(e.target.value)} disabled={!recvOn} />
                    </label>
                  )}
                  <button onClick={() => save()} disabled={saving} className="w-full py-2 rounded-lg bg-brand text-white font-medium disabled:opacity-40">
                    {saving ? '儲存緊…' : '儲存'}
                  </button>
                </div>
              )}

              {!newCase && <button className="text-xs underline text-muted-foreground" onClick={() => setNewCase(true)}>冇合適成本？新增成本</button>}
              {newCase && (
                <div className="rounded-lg border border-dashed p-2 space-y-2 text-sm">
                  <div className="text-xs text-muted-foreground">新增成本（{c.code ?? '病人未識別'}，{fmtMoney(selSum || c.groupSum)}；開完會自動連晒呢組行）</div>
                  <div className="flex gap-2">
                    <select className="flex-1 border rounded px-2 py-1" value={itemType} onChange={(e) => setItemType(e.target.value)}>
                      <option value="">— 項目 —</option>
                      {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select className="flex-1 border rounded px-2 py-1" value={ncProvider} onChange={(e) => setNcProvider(e.target.value)}>
                      <option value="">— 醫生 —</option>
                      {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <button onClick={createCase} disabled={saving || !itemType} className="w-full py-2 rounded-lg border bg-card font-medium disabled:opacity-40">新增成本並連好</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
