'use client'

import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import { todayHK, toHKDateStr } from '@/lib/hk-date'
import { ITEM_TYPES } from '@/lib/payout/constants'
import { applyPatientPick } from '@/lib/cost-entry/clinic-prefix'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, RefreshCw, Loader2, AlertTriangle, Search, ArrowLeft, Check, X, Trash2, Package, Percent } from 'lucide-react'

// ── Types ──────────────────────────────────────────────

interface CostCase {
  id: string
  providerId: string
  clinicId: string
  category: string
  patientCode: string
  patientName: string | null
  orderedAt: string
  itemType: string | null
  itemTypeOther: string | null
  labId: string | null
  labOther: string | null
  labOrderNo: string | null
  dsaName: string | null
  baseCost: number | null
  discountPct: number | null
  finalCost: number | null
  receivedAt: string | null
  appointmentAt: string | null
  // ★ 2026-09-02 cwm-costnote：自由備註（最多 200 字）
  note: string | null
  status: string
  periodMonth: string | null // ★ 2026-08-27：未到貨 = null（唔入月結）
  lockedByRunId: string | null
  lab?: { id: string; name: string }
  materials?: any[]
  // ★ C1/D1：server 解析好嘅醫生（唔准喺前端用 providers state 對 —— /api/providers
  //   默認 isActive:true，停用醫生會出空白格）
  provider?: { id: string; name: string; shortName: string | null } | null
  // ★ 2026-08-25：重做（拍板①）
  redoAt: string | null
  redoReason: string | null
}

interface CleanPatient {
  extId: string
  code: string
  fullName: string
}

interface BillItem {
  eleId: string
  feeItem: { id: string; code: string; des: string } | null
  qty: number
  up: number
  amt: number
  ttlAmt: number
  isSp2p: boolean
}

interface SearchBill {
  id: string
  code: string
  billTime: string
  amt: number
  ttlAmt: number
  paidAmt: number
  osAmt: number
  isVoid: boolean
  isRefunded: boolean
  practitioner: { id: string } | null
  clinic: { id: string } | null
  billDetails: BillItem[]
  existingCostCount: number
}

interface MaterialLine {
  materialName: string
  qty: number
  unitPrice: number
  masterPrice: number | null
  isPriceOverridden: boolean
  subtotal: number
  note: string // ★ 2026-08-22：揀「Other」時手動填嘅材料名
}

// ── Constants ──────────────────────────────────────────

// ★ 2026-08-28 cwm-matedit T3 §4 #28：新增 modal 類別掣只 LAB/植牙（隱形矯正併入 LAB）
const CATEGORIES = ['LAB', 'IMPLANT'] as const
// ★ T3 #32：篩選列保留三個 — 舊 INVISALIGN 資料仍要篩得到/顯示得到
const ALL_CATEGORIES = ['LAB', 'IMPLANT', 'INVISALIGN'] as const
const STATUSES = ['PENDING', 'PRICED', 'DONE', 'REDO'] as const

const CATEGORY_LABELS: Record<string, string> = {
  LAB: 'LAB', // ★ 2026-08-22：改 label（唔再係「牙醫化驗」）
  IMPLANT: '植牙',
  INVISALIGN: '隱形矯正',
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  PENDING: { label: '未有價', color: 'yellow' },
  PRICED: { label: '已定價', color: 'blue' },
  DONE: { label: '已完成', color: 'green' },
  // ★ 2026-08-25 拍板①：重做（中間狀態，可再轉 DONE）
  REDO: { label: '重做中', color: 'amber' },
  VOID: { label: '已作廢', color: 'gray' },
}

// ── Helper: suggest category from bill items ──────────
function suggestCategoryFromBill(bill: SearchBill): string {
  const desAll = bill.billDetails.map(d => (d.feeItem?.des ?? '').toUpperCase()).join(' ')
  // ★ T3 #30：INVIS 帳單 → 類別 LAB（隱形矯正併入 LAB；itemType 另建議 Invisalign）
  if (desAll.includes('INVIS') || desAll.includes('CLEAR ALIGNER') || desAll.includes('透明')) return 'LAB'
  if (desAll.includes('IMPLANT') || desAll.includes('植入')) return 'IMPLANT'
  return 'LAB'
}

function suggestItemTypeFromBill(bill: SearchBill): string {
  const desAll = bill.billDetails.map(d => (d.feeItem?.des ?? '').toUpperCase()).join(' ')
  // ★ T3 #30：INVIS 條件同 suggestCategoryFromBill 完全一致（放最前，IMPLANT 判斷之前）
  if (desAll.includes('INVIS') || desAll.includes('CLEAR ALIGNER') || desAll.includes('透明')) return 'Invisalign'
  if (desAll.includes('IMPLANT') || desAll.includes('DENTURE')) {
    if (desAll.includes('IMPLANT') && desAll.includes('DENTURE')) return 'Implant Denture'
    if (desAll.includes('IMPLANT')) return 'Implant'
    return 'Denture'
  }
  if (desAll.includes('NIGHTGUARD')) return 'Nightguard'
  if (desAll.includes('RETAINER')) return 'Retainer'
  if (desAll.includes('CROWN') || desAll.includes('BRIDGE') || desAll.includes('VENER')) return 'CR&BR&Venner'
  return 'Others'
}

// ── Main Component ─────────────────────────────────────

export default function CostEntryPage() {
  // ── Table state ──────────────────────────────────────
  const [cases, setCases] = useState<CostCase[]>([])
  const [loading, setLoading] = useState(true)
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<any[]>([])
  const [labs, setLabs] = useState<any[]>([])
  const [materials, setMaterials] = useState<any[]>([]) // ★ MD-K: implant materials
  const [summary, setSummary] = useState<any>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [filterProviderId, setFilterProviderId] = useState('')
  const [filterPeriodMonth, setFilterPeriodMonth] = useState(() => {
    const d = todayHK()
    return d.slice(0, 7)
  })
  const [filterCategory, setFilterCategory] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterClinicId, setFilterClinicId] = useState('')
  // ★ 2026-08-28 cwm-matedit T2 §2：兩個日期模式 — 預設按落單日（★#11）；
  //   換模式唔重設 sortKey（★#18）— 排序狀態原封不動
  const [dateMode, setDateMode] = useState<'ordered' | 'received'>('ordered')
  // ★ cwm-costentry-20260827 §2：病人搜尋（編號/姓名）
  const [searchQ, setSearchQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  // ★ cwm-costentry-20260827 §3：作廢行預設收起
  const [showVoided, setShowVoided] = useState(false)

  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const [userId, setUserId] = useState('')

  const canCreate = userRole ? hasPermission(userRole, 'cost_entry', grant, deny) : false

  // ── ★ MD-K: Unified CostCaseForm (picker/manual) state ──
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<'bill' | 'manual'>('bill') // ★ MD-K: 雙入口
  const [pickerStep, setPickerStep] = useState(0) // 0=patient, 1=bill, 2=cost (bill mode)
  
  // Step 0: patient search
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchingPatients, setSearchingPatients] = useState(false)
  const [patients, setPatients] = useState<CleanPatient[]>([])
  const [apricotBusy, setApricotBusy] = useState(false)

  // Step 1: bill search
  const [selectedPatient, setSelectedPatient] = useState<CleanPatient | null>(null)
  const [searchingBills, setSearchingBills] = useState(false)
  const [bills, setBills] = useState<SearchBill[]>([])
  const [selectedBill, setSelectedBill] = useState<SearchBill | null>(null)

  // Step 2: cost form
  const [selectedClinicInternalId, setSelectedClinicInternalId] = useState('')
  const [selectedProviderInternalId, setSelectedProviderInternalId] = useState('')
  const [dsaEmployees, setDsaEmployees] = useState<any[]>([])
  const [loadingDsa, setLoadingDsa] = useState(false)
  const [costForm, setCostForm] = useState({
    category: 'LAB' as string,
    itemType: '',
    itemTypeOther: '',
    orderedAt: '',
    dsaName: '',
    baseCost: '',
    discountPct: '',
    receivedAt: '',
    appointmentAt: '',
    note: '', // ★ 2026-09-02 cwm-costnote：備註（useState 型別 infer 源 — 漏呢度全頁 TS 報錯）
    labId: '',
    labOrderNo: '',
    labOther: '',
    // ★ MD-K: manual mode fields
    patientCode: '',
    patientName: '',
  })
  const [savingCost, setSavingCost] = useState(false)
  // ★ 2026-08-28 cwm-matedit T3 §3 #22-#26：到貨日人手動過（填/清）→ 改落單日唔再自動同步；
  //   新增 modal 開時 false；編輯模式載入現有值後 true（已有資料 = 當已人手填過，唔覆蓋）
  const [receivedAtTouched, setReceivedAtTouched] = useState(false)

  // ★ MD-K: Implant material lines
  const [materialLines, setMaterialLines] = useState<MaterialLine[]>([])

  // ★ Q2: Discount from LabMonthlyDiscount table
  const [labDiscountPct, setLabDiscountPct] = useState<number | null>(null)
  const [labDiscountPeriodMonth, setLabDiscountPeriodMonth] = useState<string>('')

  // ★ 2026-08-25：手動新增模式 — 病人搜尋（同「由帳單新增」同一條 patient-search）
  const [manualPatientQuery, setManualPatientQuery] = useState('')
  const [manualPatientSearching, setManualPatientSearching] = useState(false)
  const [manualPatients, setManualPatients] = useState<CleanPatient[]>([])

  // ★ 2026-08-25：由病人編號前綴推斷診所嘅提示（拍板⑤：建議唔強制）
  const [clinicGuess, setClinicGuess] = useState<{ prefix: string } | null>(null)

  // ★ 2026-08-25 拍板③：修改模式（重用「手動新增」modal）
  const [editingCase, setEditingCase] = useState<CostCase | null>(null)

  // ★ 2026-08-25 拍板①：重做 modal
  const [redoCase, setRedoCase] = useState<CostCase | null>(null)
  const [redoForm, setRedoForm] = useState({ redoAt: '', redoReason: '' })
  const [redoSaving, setRedoSaving] = useState(false)

  // ★ cwm-costentry-20260827 §1.4：成本錄入下拉只顯示 showInCostEntry !== false 嘅醫生
  //   （列表本身唔 filter — 已錄入個案仍顯示；當值表/時間表/月結零影響）
  const costEntryProviders = useMemo(
    () => providers.filter((p: any) => p.showInCostEntry !== false),
    [providers]
  )

  // ★ cwm-costentry-20260827 #5：編輯模式 — 個案原醫生唔喺 costEntryProviders → 加返入下拉
  //   （唔加就靜靜改咗拆帳歸屬）；新增模式 editProviders === costEntryProviders
  const editProviders = useMemo(() => {
    if (!editingCase?.providerId) return costEntryProviders
    return costEntryProviders.some((p: any) => p.id === editingCase.providerId)
      ? costEntryProviders
      : [...costEntryProviders, providers.find((p: any) => p.id === editingCase.providerId)].filter(Boolean)
  }, [costEntryProviders, providers, editingCase])

  // ★ cwm-costentry-20260827 §3：作廢行預設收起（前端 filter，MD 拍板）
  const visibleCases = useMemo(
    () => cases.filter(c => showVoided || c.status !== 'VOID'),
    [cases, showVoided]
  )
  // ★ cwm-costentry-20260827 #18：底部統計永遠排除 VOID（無論顯示與否）—
  //   API summary 含 VOID 且要通用唔改，改前端由 cases 計算
  const nonVoidCases = useMemo(() => cases.filter(c => c.status !== 'VOID'), [cases])
  const stats = useMemo(() => {
    const total = nonVoidCases.length
    const totalFinalCost = nonVoidCases.reduce((s, c) => s + (c.finalCost ?? 0), 0)
    const unpricedCount = nonVoidCases.filter(c => c.baseCost == null).length
    const labGroups: Record<string, { count: number; total: number }> = {}
    for (const c of nonVoidCases) {
      let key: string | null = null
      if (c.lab) key = c.lab.name
      else if (c.labOther) key = `other:${c.labOther}`
      if (!key) continue
      if (!labGroups[key]) labGroups[key] = { count: 0, total: 0 }
      labGroups[key].count++
      labGroups[key].total += c.finalCost ?? 0
    }
    return { total, totalFinalCost, unpricedCount, labGroups }
  }, [nonVoidCases])

  // ★ cwm-costentry-20260827 §3：作廢行紅線灰字（line-through 跨瀏覽器穩陣，唔用 absolute td overlay）
  const voidStyle = {
    color: '#9ca3af',
    textDecoration: 'line-through',
    textDecorationColor: '#dc2626',
    textDecorationThickness: '1.5px',
  }

  // ★ 2026-08-25 §2.2：醫生下拉按診所分組 — 屬呢間店嘅排前，其餘摺去「其他診所」。
  //   ★★ 唔完全隱藏：ProviderClinic 綁定可能漏（青衣就係零資料），
  //   完全隱藏 = 錄唔到成本。API 唔 filter，改前端分組（§2.1）。
  //   ★ cwm-costentry-20260827 §1.4：input 改 editProviders（已過濾 + 編輯模式加返原醫生）
  // ★ 2026-08-27 cwm-costarrival §3：全欄排序（拍板③「整行跟住走」）——
  //   排整個 object array，每行所有欄自然跟住；null/空值永遠排最後
  type SortKey = 'orderedAt' | 'patientCode' | 'patientName' | 'category'
    | 'labName' | 'dsaName' | 'finalCost' | 'receivedAt' | 'appointmentAt' | 'note' | 'status'
  const [sortKey, setSortKey] = useState<SortKey>('orderedAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function sortValue(c: CostCase, key: SortKey): any {
    switch (key) {
      case 'orderedAt': case 'receivedAt': case 'appointmentAt':
        return c[key] ? new Date(c[key]).getTime() : null
      case 'finalCost':
        return c.finalCost != null ? Number(c.finalCost) : null
      case 'labName':
        return c.lab?.name || c.labOther || null
      // ★ 2026-09-02 cwm-costnote：備註排序（空值排最後 — 由下方 null 處理兜住）
      case 'note':
        return c.note ?? null
      default:
        return c[key] ?? null
    }
  }

  const sortedCases = useMemo(() => {
    const arr = [...visibleCases]
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      const va = sortValue(a, sortKey)
      const vb = sortValue(b, sortKey)
      // ★ null/空值一律排最後（唔理升降序）——「未有價」「未到貨」唔應該搶頭
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (va < vb) return -1 * dir
      if (va > vb) return 1 * dir
      return 0
    })
    return arr
  }, [visibleCases, sortKey, sortDir])

  const SortableTh = ({ k, children, className = 'text-left p-2' }:
    { k: SortKey; children: ReactNode; className?: string }) => (
    <th onClick={() => {
          if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
          else { setSortKey(k); setSortDir('asc') }
        }}
        className={`${className} cursor-pointer select-none`}
    >
      {children}
      {sortKey === k && <span className="ml-0.5">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  )

  const groupedProviders = useMemo(() => {
    const cid = selectedClinicInternalId
    if (!cid) return { mine: editProviders as any[], others: [] as any[] }
    const mine = editProviders.filter((p: any) => (p.clinicIds ?? []).includes(cid))
    const others = editProviders.filter((p: any) => !mine.includes(p))
    return { mine, others }
  }, [editProviders, selectedClinicInternalId])

  // ★ 2026-08-25 §2.3：篩選列個醫生下拉一樣分組（跟 filterClinicId）
  //   ★ cwm-costentry-20260827 §1.4：input 改 costEntryProviders
  const filterGroupedProviders = useMemo(() => {
    const cid = filterClinicId
    if (!cid) return { mine: costEntryProviders as any[], others: [] as any[] }
    const mine = costEntryProviders.filter((p: any) => (p.clinicIds ?? []).includes(cid))
    const others = costEntryProviders.filter((p: any) => !mine.includes(p))
    return { mine, others }
  }, [costEntryProviders, filterClinicId])

  // ── Load functions ──────────────────────────────────

  const loadProviders = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/providers')
      setProviders(data.providers || [])
    } catch (e) {
      console.error('[cost-entry] load providers failed', e)
      setLoadError('載入醫生列表失敗')
    }
  }, [])

  const loadClinics = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/clinics')
      setClinics(data.clinics || [])
    } catch (e) {
      console.error('[cost-entry] load clinics failed', e)
      setLoadError('載入診所列表失敗')
    }
  }, [])

  const loadLabs = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/labs')
      setLabs(data.labs || [])
    } catch (e) {
      console.error('[cost-entry] load labs failed', e)
    }
  }, [])

  const loadMaterials = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/material-items')
      setMaterials(data.items || [])
    } catch (e) {
      console.error('[cost-entry] load materials failed', e)
    }
  }, [])

  const loadCases = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterProviderId) params.set('providerId', filterProviderId)
      if (filterPeriodMonth) params.set('periodMonth', filterPeriodMonth)
      if (filterCategory) params.set('category', filterCategory)
      if (filterStatus) params.set('status', filterStatus)
      if (filterClinicId) params.set('clinicId', filterClinicId)
      // ★ 2026-08-28 cwm-matedit T2 §2：日期模式（ordered=預設 / received=按到貨日）
      params.set('dateMode', dateMode)
      // ★ cwm-costentry-20260827 §2：病人搜尋（debouncedQ 已 300ms debounce → 靜止後只一次 request）
      if (debouncedQ) params.set('q', debouncedQ)

      const data: any = await apiFetch(`/api/cost-cases?${params}`)
      setCases(data.cases || [])
      setSummary(data.summary || null)
    } catch (e) {
      console.error('Failed to load cases:', e)
    } finally {
      setLoading(false)
    }
  }, [filterProviderId, filterPeriodMonth, filterCategory, filterStatus, filterClinicId, dateMode, debouncedQ])

  const loadAuth = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/me')
      setUserRole(data.user?.role || '')
      setUserId(data.user?.id || '')
      // ★ 2026-08-22：/api/me 已經 parse 好，直接回 user.grant / user.deny
      //   （permissionsJson 喺 route.ts:24 被剷走，讀佢永遠 undefined）
      setGrant(data.user?.grant ?? [])
      setDeny(data.user?.deny ?? [])
    } catch (e) {
      console.error('[cost-entry] load auth failed', e)
      setLoadError('載入用戶資訊失敗')
    }
  }, [])

  useEffect(() => {
    loadAuth()
    loadProviders()
    loadClinics()
    loadLabs()
    loadMaterials()
  }, [loadAuth, loadProviders, loadClinics, loadLabs, loadMaterials])

  useEffect(() => {
    loadCases()
  }, [loadCases])

  // ★ cwm-costentry-20260827 §2：300ms debounce — 連續打字只喺靜止後 update 一次
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQ.trim()), 300)
    return () => clearTimeout(t)
  }, [searchQ])

  // ★ Q2: Fetch discount from LabMonthlyDiscount
  //   ★ cwm-costentry-20260827 拍板②：自動帶入淨係帳單流程（pickerMode==='bill'）；
  //   手動新增 labDiscountPct 永遠 null（set 位核對：bill effect + openPicker/openEditModal reset）
  useEffect(() => {
    if (pickerMode !== 'bill' || pickerStep !== 2) return
    if (costForm.category === 'IMPLANT') {
      setLabDiscountPct(null)
      setLabDiscountPeriodMonth('')
      return
    }
    const effectiveLabId = costForm.labId === '__OTHERS__' || !costForm.labId ? null : costForm.labId
    if (!effectiveLabId || !costForm.orderedAt) {
      setLabDiscountPct(null)
      setLabDiscountPeriodMonth('')
      return
    }
    const pm = costForm.orderedAt.slice(0, 7)
    setLabDiscountPeriodMonth(pm)
    const fetchDiscount = async () => {
      try {
        const data: any = await apiFetch(`/api/lab-discounts?labId=${encodeURIComponent(effectiveLabId)}&periodMonth=${encodeURIComponent(pm)}`)
        const list = data.discounts || []
        setLabDiscountPct(list.length > 0 ? Number(list[0].discountPct) : null)
      } catch {
        setLabDiscountPct(null)
      }
    }
    fetchDiscount()
  }, [costForm.labId, costForm.orderedAt, pickerMode, pickerStep, costForm.category])

  const handleDelete = async (id: string) => {
    if (!confirm('確定要作廢呢筆記錄？')) return
    try {
      await apiFetch(`/api/cost-cases/${id}`, { method: 'DELETE' })
      loadCases()
    } catch (e: any) {
      alert(`作廢失敗: ${e.message}`)
    }
  }

  // ── ★ 2026-09-02 cwm-costnote：「已完成」綠剔（confirm 二次確認，拍板①）───────
  //   DONE 唔影響月結金額（payout/engine 只 filter VOID）；
  //   拍板③：已鎖定（🔒）都可以標 —— 新 PATCH /status route 特登唔加鎖定守衛。
  const handleToggleDone = async (c: CostCase) => {
    const toDone = c.status !== 'DONE'
    const msg = toDone
      ? `確定標記為「已完成」？\n\n${c.patientCode} · ${CATEGORY_LABELS[c.category]}${c.itemType ? ' · ' + c.itemType : ''}\n成本：${c.finalCost != null ? '$' + Number(c.finalCost).toFixed(2) : '未有價'}`
      : `確定取消「已完成」？\n\n會回復為${c.finalCost != null ? '「已定價」' : '「未有價」'}。`
    if (!confirm(msg)) return
    // ★ 取消時回復：有 finalCost → PRICED；冇 finalCost → PENDING（MD §4.2：唔可以一律 PENDING）
    const next = toDone ? 'DONE' : (c.finalCost != null ? 'PRICED' : 'PENDING')
    try {
      await apiFetch(`/api/cost-cases/${c.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      loadCases()
    } catch (e: any) {
      alert(`更新失敗: ${e.message || e}`)
    }
  }

  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('zh-HK') : '—'

  // ── ★ MD-K: Unified CostCaseForm Picker ──────────────

  const openPicker = (mode: 'bill' | 'manual' = 'bill') => {
    setPickerMode(mode)
    // Reset all picker state
    setPickerStep(mode === 'manual' ? 2 : 0) // manual skips to step 2
    setSearchKeyword('')
    setPatients([])
    setApricotBusy(false)
    setSelectedPatient(null)
    setBills([])
    setSelectedBill(null)
    setSelectedClinicInternalId('')
    setSelectedProviderInternalId('')
    setDsaEmployees([])
    setCostForm({
      category: 'LAB', itemType: '', itemTypeOther: '', orderedAt: todayHK(),
      dsaName: '', baseCost: '', discountPct: '',
      receivedAt: '', appointmentAt: '', labId: '', labOrderNo: '', labOther: '',
      patientCode: '', patientName: '',
      // ★ 2026-09-02 cwm-costnote：備註初始值（漏呢度 = 新增時 costForm.note undefined → 列表崩）
      note: '',
    })
    setMaterialLines([])
    setLabDiscountPct(null)
    setLabDiscountPeriodMonth('')
    // ★ T3 #22：新增 modal 開 → 到貨日未人手動過（IMPLANT 落單日自動帶到貨日）
    setReceivedAtTouched(false)
    // ★ 2026-08-25：重置新增 state
    setManualPatientQuery('')
    setManualPatients([])
    setClinicGuess(null)
    setEditingCase(null)
    setPickerOpen(true)
  }

  const closePicker = () => {
    setPickerOpen(false)
    setApricotBusy(false)
  }

  // Step 0: search patients
  const handleSearchChange = (val: string) => {
    setSearchKeyword(val)
    setApricotBusy(false)
    setPatients([])
  }

  const handleSearchSubmit = () => {
    if (searchKeyword.trim().length < 6) return
    searchPatientsApi(searchKeyword.trim())
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSearchSubmit() }
  }

  const searchPatientsApi = async (keyword: string) => {
    setSearchingPatients(true)
    setPatients([])
    setApricotBusy(false)
    try {
      const data: any = await apiFetch(`/api/cost-cases/patient-search?keyword=${encodeURIComponent(keyword)}`)
      setPatients(data.patients || [])
    } catch (e: any) {
      if (e?.status === 503) setApricotBusy(true)
    } finally {
      setSearchingPatients(false)
    }
  }

  const selectPatient = (patient: CleanPatient) => {
    setSelectedPatient(patient)
    setPickerStep(1)
    loadBills(patient.extId)
  }

  const loadBills = async (patientExtId: string) => {
    setSearchingBills(true)
    setBills([])
    setApricotBusy(false)
    try {
      const data: any = await apiFetch(`/api/cost-cases/bill-search?patientExtId=${encodeURIComponent(patientExtId)}&months=12`)
      setBills(data.bills || [])
    } catch (e: any) {
      if (e?.status === 503) setApricotBusy(true)
    } finally {
      setSearchingBills(false)
    }
  }

  // Step 1 → 2: select bill
  const selectBillForCost = (bill: SearchBill) => {
    setSelectedBill(bill)
    const clinic = clinics.find(c => c.apricotClinicId === bill.clinic?.id)
    const clinicId = clinic?.id || ''
    setSelectedClinicInternalId(clinicId)
    const provider = providers.find(p => p.apricotId === bill.practitioner?.id)
    const providerId = provider?.id || ''
    setSelectedProviderInternalId(providerId)

    const category = suggestCategoryFromBill(bill)
    const itemType = suggestItemTypeFromBill(bill)

    setCostForm({
      category, itemType, itemTypeOther: '', orderedAt: todayHK(),
      dsaName: '', baseCost: '', discountPct: '',
      receivedAt: '', appointmentAt: '', labId: '', labOrderNo: '', labOther: '',
      patientCode: '', patientName: '',
      // ★ 2026-09-02 cwm-costnote：備註初始值（帳單模式）
      note: '',
    })
    setMaterialLines([])

    // ★ 2026-08-28 cwm-costfix：DSA 載入統一由 selectedClinicInternalId effect 處理
    //   （見 loadDsaEmployees 下方 effect），呢度唔使再顯式 call
    setPickerStep(2)
  }

  const loadDsaEmployees = useCallback(async (cid: string) => {
    setLoadingDsa(true)
    try {
      // ★ 2026-08-22：改行輕量 route —— 原 /api/employees 回 payConfidential/phone/email
      //   等敏感欄，route 級 override 分唔到 query param，唔可以直接開俾 cost_entry
      const data: any = await apiFetch(`/api/employees/dsa-options?clinicId=${encodeURIComponent(cid)}`)
      setDsaEmployees(data.employees || data || [])
    } catch {
      setDsaEmployees([])
    } finally {
      setLoadingDsa(false)
    }
  }, [])

  // ★ 2026-08-28 cwm-costfix §8.4.3：DSA 下拉跟 selectedClinicInternalId ——
  //   統一覆蓋 manual 表單診所 select / 病人編號前綴推斷 / 修改模式三條路徑
  //   （原本只 bill mode 嘅 selectBillForCost 會 call，manual 揀咗診所都唔會載入
  //   → 下拉永遠「不選」）
  useEffect(() => {
    if (!pickerOpen) return
    if (selectedClinicInternalId) loadDsaEmployees(selectedClinicInternalId)
    else setDsaEmployees([])
  }, [pickerOpen, selectedClinicInternalId, loadDsaEmployees])

  // ★ MD-K: Material line helpers
  const addMaterialLine = () => {
    setMaterialLines(prev => [...prev, { materialName: '', qty: 1, unitPrice: 0, masterPrice: null, isPriceOverridden: false, subtotal: 0, note: '' }])
  }

  const removeMaterialLine = (idx: number) => {
    setMaterialLines(prev => prev.filter((_, i) => i !== idx))
  }

  const updateMaterialLine = (idx: number, field: keyof MaterialLine, value: any) => {
    setMaterialLines(prev => {
      const updated = [...prev]
      const line = { ...updated[idx] }
      if (field === 'materialName') {
        const selected = materials.find(m => m.name === value)
        const masterPrice = selected ? (selected.unitPrice != null ? Number(selected.unitPrice) : null) : null
        line.materialName = value
        line.masterPrice = masterPrice
        line.unitPrice = masterPrice ?? 0
        line.isPriceOverridden = false
        line.subtotal = Number((line.unitPrice * line.qty).toFixed(2))
      } else if (field === 'qty') {
        const newQty = Number(value)
        if (!Number.isInteger(newQty) || newQty < 1) return prev
        line.qty = newQty
        line.subtotal = Number((line.unitPrice * line.qty).toFixed(2))
      } else if (field === 'unitPrice') {
        const newPrice = Number(value)
        line.unitPrice = newPrice
        line.isPriceOverridden = line.masterPrice != null && newPrice !== line.masterPrice
        line.subtotal = Number((line.unitPrice * line.qty).toFixed(2))
      } else if (field === 'note') {
        // ★ 2026-08-22：Other 材料名（唔影響計價）
        line.note = value
      }
      updated[idx] = line
      return updated
    })
  }

  const totalMaterialCost = materialLines.reduce((sum, l) => sum + l.subtotal, 0)

  // ── ★ 2026-08-25：手動新增模式 — 病人搜尋 ────────────────────────────

  // ★ 同「由帳單新增」用同一條 /api/cost-cases/patient-search（白名單三欄：code/fullName/extId）
  const searchManualPatient = async () => {
    const kw = manualPatientQuery.trim()
    // ★ #21：API 限 keyword ≥ 6 字元 — 前端先擋，唔好等 400
    if (kw.length < 6) {
      setLoadError('關鍵字最少 6 個字元')
      return
    }
    setManualPatientSearching(true)
    setManualPatients([])
    setApricotBusy(false)
    try {
      const data: any = await apiFetch(`/api/cost-cases/patient-search?keyword=${encodeURIComponent(kw)}`)
      setManualPatients(data.patients || [])
    } catch (e: any) {
      if (e?.status === 503) setApricotBusy(true)
      else setLoadError(e?.message || '搜尋失敗')
    } finally {
      setManualPatientSearching(false)
    }
  }

  // ★ 2026-08-25 拍板④⑤：揀病人 → 填編號/姓名 + 診所前綴建議
  //   ⚠️ 诊所只喺「推到 而且 用戶未揀過」時填 —— 唔覆蓋人手選擇（#18）
  const pickManualPatient = (p: CleanPatient) => {
    const r = applyPatientPick({
      prevClinicId: selectedClinicInternalId,
      patientCode: p.code,
      patientName: p.fullName,
      clinics: clinics.map((c: any) => ({ id: c.id, shortName: c.shortName ?? null })),
    })
    setCostForm(prev => ({ ...prev, patientCode: r.patientCode, patientName: r.patientName }))
    setSelectedClinicInternalId(r.clinicId)
    setClinicGuess(r.guessed && r.prefix ? { prefix: r.prefix } : null)
    setManualPatients([])
  }

  // ── ★ 2026-08-25 拍板③：修改模式（重用 manual modal）─────────────────────

  const openEditModal = (c: CostCase) => {
    setPickerMode('manual')
    setPickerStep(2)
    setEditingCase(c)
    setSelectedProviderInternalId(c.providerId)
    setSelectedClinicInternalId(c.clinicId)
    setSelectedPatient(null)
    setBills([])
    setSelectedBill(null)
    setApricotBusy(false)
    setDsaEmployees([])
    // IMPLANT 個案嘅 lab 欄位留空（植牙唔經 lab）
    const isImplant = c.category === 'IMPLANT'
    const labId = isImplant ? '' : (c.labId === null ? (c.labOther ? '__OTHERS__' : '') : c.labId)
    setCostForm({
      category: c.category,
      itemType: c.itemType ?? '',
      itemTypeOther: c.itemTypeOther ?? '',
      orderedAt: toHKDateStr(c.orderedAt),
      dsaName: c.dsaName ?? '',
      baseCost: c.baseCost != null ? String(c.baseCost) : '',
      discountPct: '',
      receivedAt: c.receivedAt ? toHKDateStr(c.receivedAt) : '',
      appointmentAt: c.appointmentAt ? toHKDateStr(c.appointmentAt) : '',
      labId,
      labOrderNo: c.labOrderNo ?? '',
      labOther: c.labOther ?? '',
      patientCode: c.patientCode,
      patientName: c.patientName ?? '',
      // ★ 2026-09-02 cwm-costnote：備註 — 必須帶返現有值（漏呢度 = #3 編輯時備註被清空）
      note: c.note ?? '',
      // ★ 修改模式新增欄（唔會傳去新增 POST 嘅 body）
      _status: c.status,
      _redoAt: c.redoAt ? toHKDateStr(c.redoAt) : '',
      _redoReason: c.redoReason ?? '',
    } as any)
    // ★ cwm-payoutcost-20260908 C2：材料明細改為可編輯 —— 由原明細預填
    //   ⚠️ m.materialName 靠 C1（server join）；C1 未落刀就會變空白，所以 C2 一定排喺 C1 之後
    //   ⚠️ masterPrice 特登 null —— 前端唔知舊主檔價，揀返材料時 updateMaterialLine 會重新帶入；
    //      真正嘅 override 判斷喺 server（resolveMaterials），前端只係 UI 提示
    setMaterialLines(
      (c.materials ?? []).map((m: any) => ({
        materialName: m.materialName || m.note || '',
        qty: m.qty,
        unitPrice: Number(m.unitPriceUsed),
        masterPrice: null,
        isPriceOverridden: !!m.isPriceOverridden,
        subtotal: Number(m.subtotal),
        note: m.note ?? '',
      })),
    )
    setManualPatientQuery('')
    setManualPatients([])
    setClinicGuess(null)
    setLabDiscountPct(null)
    setLabDiscountPeriodMonth('')
    // ★ T3 #26：編輯模式載入現有值後 → 當已人手填過，改落單日唔覆蓋已有到貨日
    setReceivedAtTouched(true)
    setPickerOpen(true)
  }

  const submitEditCost = async () => {
    const c = editingCase
    if (!c) return
    const isImplant = costForm.category === 'IMPLANT'
    const providerId = selectedProviderInternalId
    const clinicId = selectedClinicInternalId

    if (!providerId || !clinicId) {
      alert('醫生和診所為必填')
      return
    }
    // ★ IMPLANT 材料明細唔可以喺修改 modal 改：
    //   原本係 IMPLANT（有 materials）→ 保持原明細（PUT 唔動 materials/finalCost）
    //   唔係 IMPLANT 要改去 IMPLANT → 擋（會冇材料明細，錄入先至可以）
    const hasOriginalMaterials = c.category === 'IMPLANT' && (c.materials?.length ?? 0) > 0
    if (isImplant && !hasOriginalMaterials) {
      alert('唔可以喺修改 modal 改去植牙（要材料明細）— 請用新增錄入')
      return
    }

    // ★ C2：材料驗證 —— 同新增路徑同一套（原守衛保留：唔開放「非植牙 → 植牙」轉換）
    if (isImplant) {
      if (materialLines.length === 0 || materialLines.some(l => !l.materialName)) {
        alert('植牙至少要一項材料，而且每行都要揀材料')
        return
      }
      if (materialLines.some(l => !Number.isInteger(l.qty) || l.qty < 1)) {
        alert('材料數量必須為正整數')
        return
      }
      for (const line of materialLines) {
        if (line.masterPrice == null && (!line.unitPrice || line.unitPrice <= 0)) {
          alert(`材料「${line.materialName}」主檔未有價，請手動填寫單價`)
          return
        }
      }
    }

    setSavingCost(true)
    try {
      const body: any = {
        providerId,
        clinicId,
        category: costForm.category,
        patientCode: costForm.patientCode || '',
        patientName: costForm.patientName || null,
        orderedAt: costForm.orderedAt || toHKDateStr(c.orderedAt),
        itemType: costForm.itemType === 'Others'
          ? (costForm.itemTypeOther?.trim() || 'Others')
          : (costForm.itemType || null),
        dsaName: costForm.dsaName || null,
        baseCost: costForm.baseCost ? Number(costForm.baseCost) : null,
        receivedAt: costForm.receivedAt || null,
        appointmentAt: costForm.appointmentAt || null,
        // ★ 2026-09-02 cwm-costnote：備註（undefined = 唔改 → 要明確送，空 = null 清空）
        note: costForm.note?.trim() || null,
      }
      // ★ C2：植牙送材料明細；★ 唔送 baseCost（server 由材料合計覆寫）
      if (isImplant) {
        body.materials = materialLines.map(l => ({
          materialName: l.materialName,
          qty: l.qty,
          unitPrice: l.isPriceOverridden || l.masterPrice == null ? l.unitPrice : undefined,
          note: l.note?.trim() || null,
        }))
        delete body.baseCost
      }
      // ★ itemTypeOther 只喺 Others 時傳 — 唔會誤悭其他狀態嘅值
      if (costForm.itemType === 'Others') {
        body.itemTypeOther = costForm.itemTypeOther || null
      }
      if (!isImplant) {
        body.labId = costForm.labId === '__OTHERS__' || !costForm.labId ? null : costForm.labId
        body.labOther = costForm.labId === '__OTHERS__' ? (costForm.labOther.trim() || null) : null
        body.labOrderNo = costForm.labOrderNo || null
      }
      // ★ 狀態（包括 REDO → DONE 呢類轉動）— API 端有 REDO 守衛
      const newStatus = (costForm as any)._status as string | undefined
      if (newStatus && newStatus !== c.status) {
        body.status = newStatus
        if (newStatus === 'REDO') {
          body.redoAt = (costForm as any)._redoAt || null
          body.redoReason = (costForm as any)._redoReason || null
        }
      }
      const res: any = await apiFetch(`/api/cost-cases/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // ★ C2 §7：已有月結單警告（server 出，唔擋保存）
      if (res?.warnings?.length) {
        alert(`⚠️ 已保存，但要留意：\n\n${res.warnings.join('\n')}`)
      }
      setEditingCase(null)
      closePicker()
      loadCases()
    } catch (e: any) {
      alert(`修改失敗: ${e.message || e}`)
    } finally {
      setSavingCost(false)
    }
  }

  // ── ★ 2026-08-25 拍板①：重做 modal ─────────────────────────────────

  const openRedoModal = (c: CostCase) => {
    setRedoCase(c)
    setRedoForm({ redoAt: todayHK(), redoReason: '' })
  }

  const submitRedo = async () => {
    const c = redoCase
    if (!c) return
    // 前端先擋（API 端都有守衛）
    if (!redoForm.redoAt) { alert('重做要填重做日期'); return }
    if (!redoForm.redoReason.trim()) { alert('重做要填原因'); return }
    setRedoSaving(true)
    try {
      await apiFetch(`/api/cost-cases/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'REDO',
          redoAt: redoForm.redoAt,
          redoReason: redoForm.redoReason.trim(),
        }),
      })
      setRedoCase(null)
      loadCases()
    } catch (e: any) {
      alert(`重做失敗: ${e.message || e}`)
    } finally {
      setRedoSaving(false)
    }
  }

  // Step 2: submit cost
  const submitCost = async () => {
    const isImplant = costForm.category === 'IMPLANT'
    const providerId = pickerMode === 'manual' ? (costForm as any)._providerId || selectedProviderInternalId : selectedProviderInternalId
    const clinicId = pickerMode === 'manual' ? (costForm as any)._clinicId || selectedClinicInternalId : selectedClinicInternalId

    if (!providerId || !clinicId) {
      alert(pickerMode === 'manual' ? '醫生和診所為必填' : '醫生或診所未能自動匹配，請用手動輸入')
      return
    }

    if (isImplant) {
      if (materialLines.length === 0 || materialLines.some(l => !l.materialName)) {
        alert('請至少添加一行有效材料')
        return
      }
      if (materialLines.some(l => !Number.isInteger(l.qty) || l.qty < 1)) {
        alert('材料數量必須為正整數')
        return
      }
      for (const line of materialLines) {
        if (line.masterPrice === null && !line.unitPrice && line.unitPrice !== 0) {
          alert(`材料「${line.materialName}」主檔未有價，請手動填寫單價`)
          return
        }
        // ★ 2026-08-22：Other 材料必填材料名（note）
        if (line.materialName === 'Other' && !(line.note || '').trim()) {
          alert('Other 材料要填材料名稱')
          return
        }
      }
    }

    setSavingCost(true)
    try {
      if (isImplant) {
        // ★ MD-K: IMPLANT → use /api/cost-cases/implant
        const body: any = {
          providerId,
          clinicId,
          patientCode: pickerMode === 'bill' ? (selectedPatient?.code || '') : (costForm.patientCode || ''),
          patientName: pickerMode === 'bill' ? (selectedPatient?.fullName || null) : (costForm.patientName || null),
          orderedAt: costForm.orderedAt || todayHK(),
          itemType: costForm.itemType === 'Others' ? (costForm.itemTypeOther?.trim() || 'Others') : (costForm.itemType || null),
          dsaName: costForm.dsaName || null,
          receivedAt: costForm.receivedAt || null,
          appointmentAt: costForm.appointmentAt || null,
          // ★ 2026-09-02 cwm-costnote：個案備註
          note: costForm.note?.trim() || null,
          materials: materialLines.map(l => ({
            materialName: l.materialName,
            qty: l.qty,
            unitPrice: l.isPriceOverridden || l.masterPrice === null ? l.unitPrice : undefined,
            note: l.note?.trim() || null, // ★ 2026-08-22：Other 材料名
          })),
          ...(pickerMode === 'bill' && selectedBill ? {
            billExtId: selectedBill.id,
            billCode: selectedBill.code,
            billItemEleId: selectedBill.billDetails?.[0]?.eleId || null,
          } : { source: 'MANUAL' }),
        }
        await apiFetch('/api/cost-cases/implant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        // LAB / INVISALIGN
        const body: any = {
          providerId,
          clinicId,
          category: costForm.category,
          patientCode: pickerMode === 'bill' ? (selectedPatient?.code || '') : (costForm.patientCode || ''),
          patientName: pickerMode === 'bill' ? (selectedPatient?.fullName || null) : (costForm.patientName || null),
          orderedAt: costForm.orderedAt || todayHK(),
          itemType: costForm.itemType === 'Others' ? (costForm.itemTypeOther?.trim() || 'Others') : (costForm.itemType || null),
          itemTypeOther: costForm.itemType === 'Others' ? costForm.itemTypeOther || null : null,
          labId: costForm.labId === '__OTHERS__' || !costForm.labId ? null : costForm.labId,
          labOther: costForm.labId === '__OTHERS__' ? (costForm.labOther.trim() || null) : null,
          // ★ cwm-costentry-20260827 拍板②：手動新增唔再收 Lab 單號 / 折扣 % —
          //   明確送 null（DB 欄保留、列表「LAB · 單號」欄同 Excel C 區保留；帳單流程照 costForm 值唔改）。
          //   日後再開：還原 modal 兩個 input（搜 "cwm-costentry-20260827"），呢度改返 costForm 值。
          labOrderNo: pickerMode === 'manual' ? null : (costForm.labOrderNo || null),
          discountPct: null, // ★ 拍板②：server 端 Q2 後本來就忽略 body.discountPct（跟 LabMonthlyDiscount 表）；明確 null 記錄拍板
          dsaName: costForm.dsaName || null,
          baseCost: costForm.baseCost ? Number(costForm.baseCost) : null,
          receivedAt: costForm.receivedAt || null,
          appointmentAt: costForm.appointmentAt || null,
          // ★ 2026-09-02 cwm-costnote：個案備註
          note: costForm.note?.trim() || null,
          ...(pickerMode === 'bill' && selectedBill ? {
            billExtId: selectedBill.id,
            billCode: selectedBill.code,
            billItemEleId: selectedBill.billDetails?.[0]?.eleId || null,
          } : { source: 'MANUAL' }),
        }
        await apiFetch('/api/cost-cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      closePicker()
      loadCases()
    } catch (e: any) {
      alert(`建立失敗: ${e.message || e}`)
    } finally {
      setSavingCost(false)
    }
  }

  // ── Step Labels ──────────────────────────────────────
  const stepLabels = pickerMode === 'manual'
    ? ['填成本']
    : ['揀病人', '揀帳單', '填成本']
  const stepIcons = pickerMode === 'manual'
    ? [Check]
    : [Search, Search, Check]
  const currentStepIdx = pickerMode === 'manual' ? 0 : pickerStep

  // ── Render ───────────────────────────────────────────

  return (
    <div className="p-6 space-y-4">
      {loadError && (
        <Card className="p-3 bg-red-50 text-red-700 text-sm flex items-center gap-2">
          <AlertTriangle size={14} /> {loadError}
          <button onClick={() => setLoadError(null)} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </Card>
      )}

      {/* Entry links to sub-pages */}
      <div className="flex gap-4 flex-wrap mb-0">
        <a href="/cost-entry/materials" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <Package size={14} /> 材料主檔
        </a>
        <a href="/cost-entry/lab-discounts" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <Percent size={14} /> Lab 月度折扣
        </a>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">成本錄入</h1>
        <div className="flex gap-2">
          {canCreate && (
            <>
              <button
                onClick={() => openPicker('bill')}
                className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 flex items-center gap-1"
              >
                <Plus size={14} /> 由帳單新增
              </button>
              <button
                onClick={() => openPicker('manual')}
                className="px-3 py-1.5 bg-gray-600 text-white rounded text-sm hover:bg-gray-700 flex items-center gap-1"
              >
                <Plus size={14} /> 手動新增
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4 space-y-3">
        {/* ★ cwm-costentry-20260827 §2/§3：病人搜尋（300ms debounce）+ 作廢預設收起 */}
        <div className="flex items-center gap-4 flex-wrap">
          <input
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm"
            style={{ minWidth: 150 }}
            placeholder="🔍 病人編號 / 姓名"
          />
          <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />
            顯示已作廢
          </label>
        </div>
        <div className="grid grid-cols-5 gap-3">
          <select value={filterProviderId} onChange={e => setFilterProviderId(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">全部醫生</option>
            {/* ★ 2026-08-25 §2.3：跟 filterClinicId 分組 — 屬呢間店排前，其餘摺去「其他診所」（唔隱藏） */}
            {filterGroupedProviders.mine.map(p => (<option key={p.id} value={p.id}>{p.name || p.shortName}</option>))}
            {filterGroupedProviders.others.length > 0 && (
              <optgroup label="── 其他診所 ──">
                {filterGroupedProviders.others.map(p => (<option key={p.id} value={p.id}>{p.name || p.shortName}</option>))}
              </optgroup>
            )}
          </select>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="month" value={filterPeriodMonth} disabled={filterPeriodMonth === ''}
              onChange={e => setFilterPeriodMonth(e.target.value)}
              style={{ opacity: filterPeriodMonth === '' ? 0.4 : 1 }}
              className="border rounded px-2 py-1.5 text-sm" />
            {/* ★ 2026-08-28 cwm-costfix §7.2.2：月份「全部」—— 勾選 = 全部月份（含未到貨）；
                取消勾選回到今個月（唔係空白，防卡死喺全部） */}
            <label className="flex items-center gap-1 text-sm cursor-pointer select-none whitespace-nowrap">
              <input type="checkbox" checked={filterPeriodMonth === ''}
                onChange={e => setFilterPeriodMonth(e.target.checked ? '' : todayHK().slice(0, 7))} />
              全部月份
            </label>
            {/* ★ 2026-08-28 cwm-matedit T2 §2.3：日期模式切換（inline-flex 邊框款） */}
            <div className="inline-flex rounded overflow-hidden" style={{ border: '1px solid #d1d5db' }}>
              <button type="button" onClick={() => setDateMode('ordered')}
                className="px-2 py-1.5 text-sm whitespace-nowrap"
                style={dateMode === 'ordered' ? { background: '#2563eb', color: '#fff' } : { background: '#fff', color: '#374151' }}>
                落單日
              </button>
              <button type="button" onClick={() => setDateMode('received')}
                className="px-2 py-1.5 text-sm whitespace-nowrap"
                style={{ borderLeft: '1px solid #d1d5db', ...(dateMode === 'received' ? { background: '#2563eb', color: '#fff' } : { background: '#fff', color: '#374151' }) }}>
                到貨日
              </button>
            </div>
          </div>
          <select value={filterClinicId} onChange={e => setFilterClinicId(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">全部診所</option>
            {clinics.map(c => (<option key={c.id} value={c.id}>{c.shortName || c.name}</option>))}
          </select>
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">全部類別</option>
            {/* ★ T3 #32：篩選列保留三個類別（ALL_CATEGORIES）— 舊 INVISALIGN 資料要篩得到 */}
            {ALL_CATEGORIES.map(c => (<option key={c} value={c}>{CATEGORY_LABELS[c]}</option>))}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">全部狀態</option>
            {STATUSES.map(s => (<option key={s} value={s}>{STATUS_CONFIG[s]?.label}</option>))}
          </select>
        </div>
      </Card>

      {/* Table */}
      <Card className="overflow-auto">
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={24} /></div>
        ) : (
          // ★ cwm-payoutcost-20260908 D1：13 欄合計 1188px。冇 min-w 嘅話
          // w-full 只會壓扁唔會捲（外層 Card 已有 overflow-auto）
          <table className="w-full min-w-[1200px] text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                {/* ★ 2026-08-28 cwm-matedit T2 §2.4：第一欄跟模式換（★★#19）— received 模式「到貨」升首欄 */}
                {dateMode === 'received' && <SortableTh k="receivedAt">到貨</SortableTh>}
                <SortableTh k="orderedAt">落單日</SortableTh>
                <SortableTh k="patientCode">病人編號</SortableTh>
                <SortableTh k="patientName">病人姓名</SortableTh>
                {/* ★ D1：醫生欄 —— 老細拍板唔需要排序，所以用純 th 唔用 SortableTh */}
                <th className="text-left p-2">醫生</th>
                <SortableTh k="category">項目</SortableTh>
                <SortableTh k="labName">Lab · 單號</SortableTh>
                <SortableTh k="dsaName">DSA</SortableTh>
                <SortableTh k="finalCost" className="text-right p-2">成本</SortableTh>
                {/* ordered 模式「到貨」留喺現行位置（成本之後）；received 模式已升首欄 */}
                {dateMode === 'ordered' && <SortableTh k="receivedAt">到貨</SortableTh>}
                <SortableTh k="appointmentAt">覆診</SortableTh>
                {/* ★ 2026-09-02 cwm-costnote：備註欄（覆診之後） */}
                <SortableTh k="note">備註</SortableTh>
                <SortableTh k="status">狀態</SortableTh>
                <th className="text-left p-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedCases.map(c => {
                // ★ cwm-costentry-20260827 §3：作廢行灰字紅線（「操作」欄豁免 — 掣要撳得到）
                const vStyle = c.status === 'VOID' ? voidStyle : undefined
                // ★ 2026-08-28 cwm-matedit T2 §2.4：兩個日期欄拆做獨立 cell — <td> 次序跟表頭跟模式換（★★#19）
                const orderedTd = <td className="p-2" style={vStyle}>{fmtDate(c.orderedAt)}</td>
                const receivedTd = (
                  <td className="p-2" style={vStyle}>
                    {fmtDate(c.receivedAt)}
                    {/* ★ 2026-08-27：未到貨（periodMonth null）→ 唔會入任何月結 */}
                    {/* ★ 2026-08-28 cwm-costfix §2.3：badge 加強（拍板 (b) 唔置頂，尊重現有排序） */}
                    {c.periodMonth == null && (
                      <span className="ml-1" style={{ fontSize: 10, color: '#b45309', background: '#fef3c7', borderRadius: 3, padding: '1px 5px', fontWeight: 600 }} title="未填到貨日，唔會入任何月結 —— 請補到貨日">⚠️ 未到貨</span>
                    )}
                  </td>
                )
                return (
                <tr key={c.id} className="border-b hover:bg-gray-50">
                  {dateMode === 'received' ? (<>{receivedTd}{orderedTd}</>) : orderedTd}
                  <td className="p-2 font-mono" style={vStyle}>{c.patientCode}</td>
                  {/* ★ D1：truncate 必配 max-w（同 :1200 備註欄同一課） */}
                  <td className="p-2 max-w-[128px]" style={vStyle}>
                    <span className="truncate block" title={c.patientName || ''}>
                      {c.patientName || '—'}
                    </span>
                  </td>
                  <td className="p-2 max-w-[96px]" style={vStyle}>
                    <span className="truncate block" title={c.provider?.name || ''}>
                      {c.provider?.shortName || c.provider?.name || '—'}
                    </span>
                  </td>
                  <td className="p-2" style={vStyle}>
                    <Badge variant="secondary" className="text-xs">{CATEGORY_LABELS[c.category] || c.category}</Badge>
                    {c.itemType && <span className="ml-1 text-gray-500">{c.itemType}</span>}
                  </td>
                  <td className="p-2 max-w-[128px]" style={vStyle}>
                    <span className="truncate block" title={`${c.lab?.name ?? ''}${c.labOrderNo ? ' ' + c.labOrderNo : ''}`}>
                      {c.lab?.name && <span>{c.lab.name}</span>}
                      {c.labOrderNo && <span className="ml-1 text-gray-500">{c.labOrderNo}</span>}
                    </span>
                  </td>
                  <td className="p-2" style={vStyle}>{c.dsaName || '—'}</td>
                  <td className="p-2 text-right" style={vStyle}>
                    {c.finalCost != null ? `$${c.finalCost.toFixed(2)}` : c.baseCost == null ? <span className="text-yellow-600">未有價</span> : '$—'}
                  </td>
                  {dateMode === 'ordered' && receivedTd}
                  <td className="p-2" style={vStyle}>{fmtDate(c.appointmentAt)}</td>
                  {/* ★ 2026-09-02 cwm-costnote：備註（作廢行跟 voidStyle 刪除線 — 「操作」欄豁免）
                      truncate 必配 max-w（淨 truncate 冇寬度限制唔生效） */}
                  <td className="p-2 max-w-[120px]" style={vStyle}>
                    {c.note ? (
                      <span className="text-xs text-muted-foreground truncate block" title={c.note}>
                        {c.note}
                      </span>
                    ) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="p-2" style={vStyle}>
                    {/* ★ 2026-08-25：REDO = 琥珀色（bg #fef3c7 / fg #92400e = tailwind amber-100/800） */}
                    <Badge
                      variant={STATUS_CONFIG[c.status]?.color === 'green' ? 'default' : 'secondary'}
                      className={c.status === 'REDO' ? 'bg-amber-100 text-amber-800' : ''}
                    >
                      {STATUS_CONFIG[c.status]?.label || c.status}
                    </Badge>
                  </td>
                  <td className="p-2">
                    {canCreate && (
                      <div className="flex gap-2 whitespace-nowrap items-center">
                        {/* ★ 2026-09-02 cwm-costnote：「已完成」標記（VOID 冇掣）。
                            拍板③：已鎖定都可以標 → 掣放喺 !lockedByRunId gate 之外 */}
                        {c.status !== 'VOID' && (
                          <button
                            onClick={() => handleToggleDone(c)}
                            title={c.status === 'DONE' ? '取消「已完成」' : '標記為已完成'}
                            className={c.status === 'DONE'
                              ? 'text-emerald-600 font-bold bg-emerald-50 rounded px-1.5 py-0.5'
                              : 'text-emerald-600 font-bold px-1.5 py-0.5'}>
                            ✓
                          </button>
                        )}
                        {!c.lockedByRunId && (<>
                        <button onClick={() => openEditModal(c)} className="text-blue-600 text-xs hover:underline">修改</button>
                        {c.status !== 'VOID' && c.status !== 'REDO' && (
                          <button onClick={() => openRedoModal(c)} className="text-amber-600 text-xs hover:underline">重做</button>
                        )}
                        {c.status !== 'VOID' && (
                          <button onClick={() => handleDelete(c.id)} className="text-red-500 text-xs hover:underline">作廢</button>
                        )}
                        </>)}
                      </div>
                    )}
                    {c.lockedByRunId && (
                      <span className="text-gray-400 text-xs" title="已出月結 —— 要先退回月結單先至可以改">🔒</span>
                    )}
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Summary */}
      {/* ★ cwm-costentry-20260827 #18：統計改用前端 stats（由 nonVoidCases 算）— 作廢單永遠唔計，無論顯示與否 */}
      {summary && (
        <Card className="p-3">
          <div className="flex items-center gap-4 text-sm">
            <span>{filterPeriodMonth ? `${filterPeriodMonth} ` : '全部月份 '}已入 {stats.total} 筆</span>
            <span>｜</span>
            <span>已定價 ${stats.totalFinalCost.toFixed(2)}</span>
            {/* ★ 2026-08-28 cwm-matedit T2 §2.4：底部標記跟 summary.mode 顯 —
                received 模式用「已到貨未有價」（§2.4），唔同 ordered 模式重複示警 */}
            {dateMode === 'ordered' && stats.unpricedCount > 0 && (
              <>
                <span>｜</span>
                <span className="flex items-center gap-1 text-yellow-600">
                  <AlertTriangle size={14} /> {stats.unpricedCount} 筆未有價（不會入月結）
                </span>
              </>
            )}
            {/* ★ 2026-08-27：「未到貨」係第二個唔入月結嘅原因，分開講（原「未有價」提示保留）— 只喺 ordered 模式有義 */}
            {dateMode === 'ordered' && (summary?.notReceivedCount ?? 0) > 0 && (
              <>
                <span>｜</span>
                <span className="flex items-center gap-1" style={{ color: '#b45309' }}>
                  <AlertTriangle size={14} /> {summary.notReceivedCount} 筆未到貨（補到貨日先入月結）
                </span>
              </>
            )}
            {/* ★#17 ordered 模式：落單喺該月但到貨喺其他月（「31/7 落單、6/8 到貨」）唔入本月月結 */}
            {dateMode === 'ordered' && (summary?.receivedOtherMonthCount ?? 0) > 0 && (
              <>
                <span>｜</span>
                <span className="flex items-center gap-1" style={{ color: '#b45309' }}>
                  <AlertTriangle size={14} /> {summary.receivedOtherMonthCount} 筆到貨喺其他月（唔入本月月結）
                </span>
              </>
            )}
            {/* ★ cwm-matedit T2 §2.4：received 模式 — 已到貨但 finalCost null（唔入月結） */}
            {dateMode === 'received' && (summary?.noPriceCount ?? 0) > 0 && (
              <>
                <span>｜</span>
                <span className="flex items-center gap-1" style={{ color: '#b45309' }}>
                  <AlertTriangle size={14} /> {summary.noPriceCount} 筆已到貨未有價（唔入月結）
                </span>
              </>
            )}
            {Object.keys(stats.labGroups).length > 0 && (
              <>
                <span>｜</span>
                <span>按 lab：{Object.entries(stats.labGroups)
                  .map(([name, g]) => `${name} $${g.total.toFixed(2)}`)
                  .join(' · ')}</span>
              </>
            )}
            {/* ★ 2026-08-28 cwm-costfix §7.2.4：「全部月份」時後端只回最近 500 筆（take: 500） */}
            {filterPeriodMonth === '' && (
              <span className="text-gray-400 text-xs">（列表只顯示最近 500 筆）</span>
            )}
          </div>
        </Card>
      )}

      {/* ── ★ MD-K: Unified CostCaseForm Modal ───────── */}
      {pickerOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-4xl max-h-[90vh] overflow-auto">
            {/* Step indicator (bill mode only) */}
            {pickerMode === 'bill' && (
              <div className="flex items-center justify-center gap-0 mb-6">
                {stepLabels.map((label, i) => {
                  const Icon = stepIcons[i]
                  const isActive = i === pickerStep
                  const isDone = i < pickerStep
                  return (
                    <div key={label} className="flex items-center">
                      <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm ${
                        isActive ? 'bg-blue-600 text-white' : isDone ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                      }`}>
                        <Icon size={14} />
                        <span>{label}</span>
                        {isDone && <Check size={12} />}
                      </div>
                      {i < 2 && <div className={`w-8 h-px ${isDone ? 'bg-green-300' : 'bg-gray-200'}`} />}
                    </div>
                  )
                })}
              </div>
            )}

            {pickerMode === 'manual' && (
              <h2 className="text-lg font-bold mb-4 text-center">
                {editingCase ? `修改成本 — ${editingCase.patientCode}` : '手動新增成本'}
              </h2>
            )}

            {/* ── Step 0: Search Patient (bill mode only) ── */}
            {pickerMode === 'bill' && pickerStep === 0 && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">病人編號 / 姓名</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
                      <input
                        value={searchKeyword}
                        onChange={e => handleSearchChange(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        className="w-full border rounded pl-9 pr-4 py-2 text-sm"
                        placeholder="輸入 6 字元以上，按 Enter 或搜尋按鈕…"
                        autoFocus
                      />
                    </div>
                    <button
                      onClick={handleSearchSubmit}
                      disabled={searchingPatients || searchKeyword.trim().length < 6}
                      className="px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      {searchingPatients ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                      搜尋
                    </button>
                  </div>
                </div>

                {searchingPatients && <div className="flex items-center gap-2 text-sm text-gray-500 py-4"><Loader2 size={16} className="animate-spin" /> 搜尋中…</div>}
                {apricotBusy && <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded"><AlertTriangle size={16} /> Apricot 忙碌，請稍後重試</div>}
                {!searchingPatients && !apricotBusy && patients.length === 0 && searchKeyword.length >= 6 && <div className="text-sm text-gray-400 py-4 text-center">冇搵到病人</div>}

                <div className="space-y-1 max-h-60 overflow-auto">
                  {patients.map(p => (
                    <button key={p.extId} onClick={() => selectPatient(p)}
                      className="w-full text-left px-3 py-2 rounded hover:bg-blue-50 text-sm flex items-center justify-between border border-transparent hover:border-blue-200">
                      <span><span className="font-mono font-medium">{p.code}</span><span className="ml-2 text-gray-600">{p.fullName}</span></span>
                      <span className="text-xs text-gray-400">{p.extId.slice(0, 8)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Step 1: Search Bills (bill mode only) ── */}
            {pickerMode === 'bill' && pickerStep === 1 && selectedPatient && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm">
                  <button onClick={() => setPickerStep(0)} className="text-blue-600 hover:underline flex items-center gap-1"><ArrowLeft size={14} /> 返回</button>
                  <span className="font-mono font-medium">{selectedPatient.code}</span>
                  <span className="text-gray-600">{selectedPatient.fullName}</span>
                </div>

                {searchingBills && <div className="flex items-center gap-2 text-sm text-gray-500 py-4"><Loader2 size={16} className="animate-spin" /> 載入帳單…</div>}
                {apricotBusy && <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded"><AlertTriangle size={16} /> Apricot 忙碌，請稍後重試</div>}
                {!searchingBills && !apricotBusy && bills.length === 0 && <div className="text-sm text-gray-400 py-4 text-center">近 12 個月冇帳單</div>}

                <div className="space-y-2 max-h-80 overflow-auto">
                  {bills.map(b => (
                    <button key={b.id} onClick={() => !b.isVoid && selectBillForCost(b)} disabled={b.isVoid}
                      className={`w-full text-left border rounded p-3 text-sm ${b.isVoid ? 'opacity-40 cursor-not-allowed bg-gray-50' : 'hover:bg-blue-50 hover:border-blue-200'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium">{b.code}</span>
                          <span className="text-gray-400">{new Date(b.billTime).toLocaleDateString('zh-HK')}</span>
                          {b.isVoid && <Badge variant="secondary" className="text-xs bg-gray-100">已作廢</Badge>}
                          {b.isRefunded && <Badge variant="secondary" className="text-xs bg-orange-50 text-orange-600">已退款</Badge>}
                          {b.existingCostCount > 0 && <Badge variant="secondary" className="text-xs bg-yellow-50 text-yellow-700">已錄 {b.existingCostCount} 筆</Badge>}
                        </div>
                        <div className="text-right">
                          <span className="font-medium">HK${Number(b.ttlAmt).toFixed(2)}</span>
                          {b.osAmt && Number(b.osAmt) > 0 && <span className="text-xs text-gray-400 ml-2">欠 ${Number(b.osAmt).toFixed(0)}</span>}
                        </div>
                      </div>
                      {b.billDetails.length > 0 && (
                        <div className="mt-1 pt-1 border-t text-xs text-gray-500 space-y-0.5">
                          {b.billDetails.slice(0, 3).map((item, i) => (
                            <div key={i} className="flex justify-between">
                              <span>{item.feeItem?.des || item.eleId}</span>
                              <span>x{item.qty} × ${Number(item.up).toFixed(0)}</span>
                            </div>
                          ))}
                          {b.billDetails.length > 3 && <div className="text-gray-400">… 等共 {b.billDetails.length} 項</div>}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Step 2: Fill Cost (shared by bill/manual) ── */}
            {(pickerMode === 'bill' && pickerStep === 2) || (pickerMode === 'manual') ? (
              <div className="space-y-4">
                {pickerMode === 'bill' && selectedBill && selectedPatient && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm">
                      <button onClick={() => setPickerStep(1)} className="text-blue-600 hover:underline flex items-center gap-1"><ArrowLeft size={14} /> 返回</button>
                      <span className="text-gray-500">帳單 {selectedBill.code}</span>
                    </div>

                    {/* Read-only section */}
                    <Card className="p-3 bg-gray-50">
                      <div className="text-xs font-medium text-gray-500 mb-2">
                        自動帶入（唯讀）
                        {selectedBill?.code && <span className="ml-2 font-mono">· 帳單 {selectedBill.code}</span>}
                      </div>
                      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                        <div>
                          <span className="text-xs text-gray-400">醫生 </span>
                          {selectedProviderInternalId ? (
                            <span>{providers.find(p => p.id === selectedProviderInternalId)?.name}</span>
                          ) : (
                            <span className="text-amber-700">⚠️ 醫生未對應</span>
                          )}
                        </div>
                        <div>
                          <span className="text-xs text-gray-400">診所 </span>
                          {selectedClinicInternalId ? (
                            <span>{clinics.find(c => c.id === selectedClinicInternalId)?.shortName || clinics.find(c => c.id === selectedClinicInternalId)?.name}</span>
                          ) : (
                            <span className="text-amber-700">⚠️ 診所未對應</span>
                          )}
                        </div>
                        <div>
                          <span className="text-xs text-gray-400">病人 </span>
                          <span className="font-mono">{selectedPatient.code}</span>
                          <span className="ml-1 text-gray-500">{selectedPatient.fullName}</span>
                        </div>
                      </div>
                      {(!selectedProviderInternalId || !selectedClinicInternalId) && (
                        <div className="mt-2 text-xs text-gray-400">
                          {!selectedProviderInternalId && <span>Apricot 醫生：<code>{selectedBill?.practitioner?.id ?? '—'}</code></span>}
                          {(!selectedProviderInternalId && !selectedClinicInternalId) && <span className="mx-1">|</span>}
                          {!selectedClinicInternalId && <span>Apricot 診所：<code>{selectedBill?.clinic?.id ?? '—'}</code></span>}
                        </div>
                      )}
                    </Card>
                  </div>
                )}

                {/* ★ MD-K: Manual mode → provider + clinic + patient selection */}
                {pickerMode === 'manual' && (
                  <div className="grid grid-cols-3 gap-3">
                    {/* ★ 2026-08-25 拍板③：修改時改咗醫生/診所 → 提醒拆帳歸屬會變 */}
                    {editingCase && (selectedProviderInternalId !== editingCase.providerId || selectedClinicInternalId !== editingCase.clinicId) && (
                      <div className="col-span-3 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                        ⚠️ 改醫生／診所會改變拆帳歸屬（月結歸邊間店邊個醫生），審計會記錄改前改後
                      </div>
                    )}
                    <div>
                      <label className="block text-sm mb-1">醫生 *</label>
                      <select value={selectedProviderInternalId} onChange={e => setSelectedProviderInternalId(e.target.value)}
                        className="w-full border rounded px-2 py-1.5 text-sm" autoFocus>
                        <option value="">請選擇</option>
                        {/* ★ 2026-08-25 §2.2：醫生按診所分組 — 屬呢間店排前，其餘摺去「其他診所」（★ 唔隱藏） */}
                        {groupedProviders.mine.map(p => <option key={p.id} value={p.id}>{p.name || p.shortName}</option>)}
                        {groupedProviders.others.length > 0 && (
                          <optgroup label="── 其他診所 ──">
                            {groupedProviders.others.map(p => <option key={p.id} value={p.id}>{p.name || p.shortName}</option>)}
                          </optgroup>
                        )}
                      </select>
                      {/* ★ #10：揀咗但未綁定呢間店嘅醫生（ProviderClinic 漏綁）→ 提示但唔擋 */}
                      {selectedProviderInternalId && selectedClinicInternalId &&
                        !groupedProviders.mine.some((p: any) => p.id === selectedProviderInternalId) && (
                        <div className="text-xs text-amber-600 mt-1">⚠️ 呢位醫生未綁定呢間診所（ProviderClinic 冇記錄）</div>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm mb-1">診所 *</label>
                      <select value={selectedClinicInternalId}
                        onChange={e => { setSelectedClinicInternalId(e.target.value); setClinicGuess(null) }}
                        className="w-full border rounded px-2 py-1.5 text-sm">
                        <option value="">請選擇</option>
                        {clinics.map(c => <option key={c.id} value={c.id}>{c.shortName || c.name}</option>)}
                      </select>
                      {/* ★ 2026-08-25 §3.4：由病人編號前綴推斷嘅提示（建議唔強制，可改） */}
                      {clinicGuess && selectedClinicInternalId && (
                        <div className="text-xs text-emerald-600 mt-1">✓ 由病人編號「{clinicGuess.prefix}」推斷，可自行更改</div>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm mb-1">病人編號</label>
                      <input value={costForm.patientCode || ''} onChange={e => setCostForm(prev => ({ ...prev, patientCode: e.target.value }))}
                        className="w-full border rounded px-2 py-1.5 text-sm" placeholder="無格式驗證" />
                    </div>
                    <div className="col-span-3">
                      <label className="block text-sm mb-1">病人姓名</label>
                      <input value={costForm.patientName || ''} onChange={e => setCostForm(prev => ({ ...prev, patientName: e.target.value }))}
                        className="w-full border rounded px-2 py-1.5 text-sm" placeholder="病人姓名" />
                    </div>
                    {/* ★ 2026-08-25：病人搜尋（同「由帳單新增」同一條 patient-search，白名單三欄） */}
                    <div className="col-span-3">
                      <label className="block text-sm mb-1">
                        搜尋病人（可揀）
                        <span className="text-xs text-gray-400"> — 揀咗會自動填編號/姓名，前綴會建議診所</span>
                      </label>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
                          <input
                            value={manualPatientQuery}
                            onChange={e => setManualPatientQuery(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && searchManualPatient()}
                            className="w-full border rounded pl-9 pr-4 py-1.5 text-sm"
                            placeholder="病人編號/姓名，6 字元以上，按 Enter 搜尋…"
                          />
                        </div>
                        <button type="button" onClick={searchManualPatient}
                          disabled={manualPatientSearching || manualPatientQuery.trim().length < 6}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1">
                          {manualPatientSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                          搜尋
                        </button>
                      </div>
                      {manualPatientSearching && <div className="flex items-center gap-2 text-sm text-gray-500 mt-2"><Loader2 size={14} className="animate-spin" /> 搜尋中…</div>}
                      {!manualPatientSearching && manualPatients.length > 0 && (
                        <div className="mt-2 space-y-1 max-h-40 overflow-auto border rounded">
                          {manualPatients.map(p => (
                            <button key={p.extId} type="button" onClick={() => pickManualPatient(p)}
                              className="w-full text-left px-3 py-1.5 rounded hover:bg-blue-50 text-sm flex items-center justify-between border border-transparent hover:border-blue-200">
                              <span><span className="font-mono font-medium">{p.code}</span><span className="ml-2 text-gray-600">{p.fullName}</span></span>
                              <span className="text-xs text-gray-400">{p.extId.slice(0, 8)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Editable form */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm mb-1">類別 {pickerMode === 'bill' && <span className="text-xs text-gray-400">（自動建議）</span>}</label>
                    <div className="flex gap-1">
                      {CATEGORIES.map(c => (
                        <button key={c} type="button"
                          onClick={() => setCostForm(f => ({ ...f, category: c, ...(c === 'IMPLANT' ? { itemType: '', itemTypeOther: '', // ★ T3 #27：切 IMPLANT 且到貨日空 → 回填落單日（已有值唔覆蓋）
                            receivedAt: f.receivedAt || f.orderedAt } : {}) }))}
                          className={`px-3 py-1.5 text-sm rounded border ${
                            costForm.category === c ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                          }`}>
                          {CATEGORY_LABELS[c]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* ★ 2026-08-25：修改模式 — 狀態改動（包括重做完成 REDO → DONE） */}
                  {editingCase && (
                    <div>
                      <label className="block text-sm mb-1">狀態</label>
                      <select value={(costForm as any)._status || ''}
                        onChange={e => setCostForm(f => ({ ...f, _status: e.target.value } as any))}
                        className="w-full border rounded px-2 py-1.5 text-sm">
                        {['PENDING', 'PRICED', 'DONE', 'REDO'].map(s => (
                          <option key={s} value={s}>{STATUS_CONFIG[s]?.label}</option>
                        ))}
                      </select>
                      {(costForm as any)._status === 'REDO' && (
                        <div className="mt-1 space-y-1">
                          <input type="date" value={(costForm as any)._redoAt || ''}
                            onChange={e => setCostForm(f => ({ ...f, _redoAt: e.target.value } as any))}
                            className="w-full border rounded px-2 py-1 text-xs" />
                          <input value={(costForm as any)._redoReason || ''}
                            onChange={e => setCostForm(f => ({ ...f, _redoReason: e.target.value } as any))}
                            className="w-full border rounded px-2 py-1 text-xs" placeholder="重做原因 *" />
                        </div>
                      )}
                    </div>
                  )}
                  {/* ★ 2026-08-22：植牙唔需要項目（由材料明細表達）— itemType 可以 null */}
                  {costForm.category !== 'IMPLANT' && (
                    <div>
                      <label className="block text-sm mb-1">項目</label>
                      <select value={costForm.itemType} onChange={e => setCostForm({ ...costForm, itemType: e.target.value, itemTypeOther: e.target.value === 'Others' ? costForm.itemTypeOther : '' })}
                        className="w-full border rounded px-2 py-1.5 text-sm">
                        {ITEM_TYPES.map(t => (<option key={t} value={t}>{t}</option>))}
                      </select>
                      {costForm.itemType === 'Others' && (
                        <input value={costForm.itemTypeOther} onChange={e => setCostForm({ ...costForm, itemTypeOther: e.target.value })}
                          className="w-full border rounded px-2 py-1.5 text-sm mt-1" placeholder="輸入具體項目名稱" />
                      )}
                    </div>
                  )}
                  <div>
                    <label className="block text-sm mb-1">落單日</label>
                    <input type="date" value={costForm.orderedAt} onChange={e => {
                      const v = e.target.value
                      // ★ T3 #22/#23：IMPLANT 且到貨日未人手動過 → 跟住落單日同步
                      setCostForm(f => ({ ...f, orderedAt: v, ...(f.category === 'IMPLANT' && !receivedAtTouched ? { receivedAt: v } : {}) }))
                    }}
                      className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">DSA</label>
                    {/* ★ 2026-08-28 cwm-costfix §8.4.3：未揀診所唔使撈全公司員工 */}
                    {!selectedClinicInternalId ? (
                      <div className="py-1.5 text-sm text-gray-400">請先揀診所</div>
                    ) : loadingDsa ? (
                      <div className="py-1.5 text-sm text-gray-400"><Loader2 size={14} className="animate-spin inline" /> 載入中…</div>
                    ) : (
                      <select value={costForm.dsaName} onChange={e => setCostForm({ ...costForm, dsaName: e.target.value })}
                        className="w-full border rounded px-2 py-1.5 text-sm">
                        <option value="">不選</option>
                        {dsaEmployees.map((emp: any) => (
                          <option key={emp.id} value={emp.user?.name || emp.id}>{emp.user?.name || emp.id}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* ★ MD-K: Implant materials section */}
                  {/* ★ cwm-payoutcost-20260908 C2：唯讀分支已剷 —— 材料明細可編輯（openEditModal 由原明細預填） */}
                  {costForm.category === 'IMPLANT' ? (
                    <div className="col-span-2">
                      <div className="border rounded-lg overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b">
                          <h4 className="font-semibold text-sm">材料明細 <span className="ml-2 text-xs font-normal text-gray-400">單價按落單日自動帶入</span></h4>
                          <button onClick={addMaterialLine} type="button" className="px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 flex items-center gap-1">
                            <Plus size={12} /> 加一行
                          </button>
                        </div>
                        {materialLines.length === 0 ? (
                          <p className="text-gray-400 text-xs text-center py-2">點擊「加一行」添加材料</p>
                        ) : (
                          <>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-gray-500">
                                  <th className="text-left px-3 py-1.5 font-medium">材料</th>
                                  <th className="text-right px-2 py-1.5 font-medium w-16">數量</th>
                                  <th className="text-right px-2 py-1.5 font-medium w-24">單價</th>
                                  <th className="text-right px-3 py-1.5 font-medium w-24">小計</th>
                                  <th className="w-10"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {materialLines.map((line, idx) => {
                                  const hasMasterPrice = line.masterPrice != null
                                  const showOverride = hasMasterPrice && line.isPriceOverridden
                                  const showNoPrice = !hasMasterPrice && line.materialName
                                  return (
                                    <tr key={idx} className="border-b">
                                      <td className="px-3 py-1">
                                        <select value={line.materialName} onChange={e => updateMaterialLine(idx, 'materialName', e.target.value)}
                                          className="w-full border rounded px-2 py-1 text-xs">
                                          <option value="">選擇材料</option>
                                          {materials.map(m => (
                                            <option key={m.id} value={m.name}>{m.name} — {m.unitPrice != null ? `$${Number(m.unitPrice).toFixed(2)}` : '(冇定價)'}</option>
                                          ))}
                                        </select>
                                        {line.materialName === 'Other' && (
                                          <input value={line.note ?? ''} onChange={e => updateMaterialLine(idx, 'note', e.target.value)}
                                            className="w-full border rounded px-2 py-1 text-xs mt-1" placeholder="材料名稱（必填）" />
                                        )}
                                      </td>
                                      <td className="px-2 py-1">
                                        <input type="number" min="1" step="1" value={line.qty} onChange={e => updateMaterialLine(idx, 'qty', e.target.value)}
                                          className="w-full border rounded px-1 py-1 text-xs text-right" placeholder="數量" />
                                      </td>
                                      <td className="px-2 py-1">
                                        <input type="number" step="0.01" value={line.unitPrice || ''} onChange={e => updateMaterialLine(idx, 'unitPrice', e.target.value)}
                                          className={`w-full border rounded px-1 py-1 text-xs text-right ${showNoPrice ? 'border-amber-300 bg-amber-50' : ''}`}
                                          placeholder={showNoPrice ? '必填' : ''} />
                                        <div className="text-[10px] mt-0.5">
                                          {showOverride && <span className="text-gray-400">✏️ 已覆寫（主檔 ${line.masterPrice!.toFixed(2)}）</span>}
                                          {showNoPrice && <span className="text-amber-600">⚠️ 主檔未有價，請手動填寫</span>}
                                        </div>
                                      </td>
                                      <td className="px-3 py-1 text-right font-medium">${line.subtotal.toFixed(2)}</td>
                                      <td className="py-1">
                                        <button onClick={() => removeMaterialLine(idx)} className="text-red-400 hover:text-red-600"><Trash2 size={12} /></button>
                                      </td>
                                    </tr>
                                  )
                                })}
                                <tr className="bg-gray-50 border-t-2">
                                  <td colSpan={3} className="px-3 py-2 font-medium">合計</td>
                                  <td className="px-3 py-2 text-right font-bold">${totalMaterialCost.toFixed(2)}</td>
                                  <td></td>
                                </tr>
                              </tbody>
                            </table>
                          </>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">—（植體材料唔經工場折扣）</div>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="block text-sm mb-1">成本 <span className="text-xs text-gray-400">（留空 = 未有價）</span></label>
                        <input type="number" step="0.01" value={costForm.baseCost} onChange={e => setCostForm({ ...costForm, baseCost: e.target.value })}
                          className="w-full border rounded px-2 py-1.5 text-sm" placeholder="成本金額" />
                      </div>
                      {/* ★ cwm-costentry-20260827 拍板②：手動新增唔再顯示折扣 %（disabled 展示位一齊停）— 帳單流程/編輯模式唔改 */}
                      {!(pickerMode === 'manual' && !editingCase) && (
                        <div>
                          <label className="block text-sm mb-1">折扣 % <span className="text-xs text-gray-400">（由工場折扣設定自動帶入）</span></label>
                          <div className="px-3 py-2 border rounded bg-muted text-sm">
                            {labDiscountPct != null
                              ? `${labDiscountPct}%（${labs.find(l => l.id === costForm.labId)?.name ?? '—'} · ${labDiscountPeriodMonth}）`
                              : '—（該工場今個月冇折扣設定）'}
                          </div>
                        </div>
                      )}
                      <div>
                        <label className="block text-sm mb-1">Lab</label>
                        <select value={costForm.labId} onChange={e => {
                          const val = e.target.value
                          setCostForm({ ...costForm, labId: val, labOther: val === '__OTHERS__' ? costForm.labOther : '' })
                        }} className="w-full border rounded px-2 py-1.5 text-sm">
                          <option value="">（不選）</option>
                          {labs.map((lab: any) => (<option key={lab.id} value={lab.id}>{lab.name}</option>))}
                          <option value="__OTHERS__">其他（自行輸入）</option>
                        </select>
                        {costForm.labId === '__OTHERS__' && (
                          <input value={costForm.labOther} onChange={e => setCostForm({ ...costForm, labOther: e.target.value })}
                            className="w-full border rounded px-2 py-1.5 text-sm mt-1" placeholder="工場名稱" />
                        )}
                      </div>
                      {/* ★ cwm-costentry-20260827 拍板②：手動新增唔再收 Lab 單號 — 帳單流程/編輯模式唔改 */}
                      {!(pickerMode === 'manual' && !editingCase) && (
                        <div>
                          <label className="block text-sm mb-1">Lab 單號</label>
                          <input value={costForm.labOrderNo} onChange={e => setCostForm({ ...costForm, labOrderNo: e.target.value })}
                            className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Lab 單號" />
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm mb-1">到貨日</label>
                    <input type="date" value={costForm.receivedAt} onChange={e => {
                      // ★ T3 #24：人手動過到貨日（填或清）→ 之後改落單日唔再自動同步
                      setReceivedAtTouched(true)
                      setCostForm({ ...costForm, receivedAt: e.target.value })
                    }}
                      className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">覆診日</label>
                    <input type="date" value={costForm.appointmentAt} onChange={e => setCostForm({ ...costForm, appointmentAt: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                </div>

                {/* ★ 2026-09-02 cwm-costnote：自由備註（例：補做上排、等病人 confirm 色） */}
                <div className="col-span-2">
                  <label className="block text-xs text-muted-foreground mb-1">備註</label>
                  <input
                    value={costForm.note ?? ''}
                    onChange={e => setCostForm(f => ({ ...f, note: e.target.value }))}
                    placeholder="例：補做上排、等病人 confirm 色…"
                    maxLength={200}
                    className="w-full border rounded px-2 py-1.5 text-sm" />
                </div>

                {/* Bill items reference (bill mode only) */}
                {pickerMode === 'bill' && selectedBill && (
                  <div className="text-xs text-gray-400 border-t pt-2">
                    <div className="font-medium mb-1">帳單項目參考：</div>
                    <div className="space-y-0.5">
                      {selectedBill.billDetails.slice(0, 5).map((item, i) => (
                        <div key={i} className="flex justify-between">
                          <span>{item.feeItem?.des || item.eleId}</span>
                          <span>${Number(item.ttlAmt).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {/* Footer actions */}
            <div className="flex justify-between mt-4 pt-3 border-t">
              {pickerMode === 'bill' && pickerStep === 0 ? (
                <button onClick={closePicker} className="px-4 py-1.5 border rounded text-sm">取消</button>
              ) : (
                <button onClick={() => pickerMode === 'manual' ? closePicker() : (pickerStep === 1 ? setPickerStep(0) : setPickerStep(1))}
                  className="px-4 py-1.5 border rounded text-sm flex items-center gap-1">
                  <ArrowLeft size={14} /> {pickerMode === 'manual' ? '取消' : '上一步'}
                </button>
              )}
              {(pickerMode === 'bill' && pickerStep === 2) || pickerMode === 'manual' ? (
                <button onClick={editingCase ? submitEditCost : submitCost}
                  disabled={savingCost || (!selectedProviderInternalId && pickerMode === 'bill') || (!selectedClinicInternalId && pickerMode === 'bill')}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                  {savingCost && <Loader2 size={14} className="animate-spin" />} {editingCase ? '保存修改' : '確定錄入'}
                </button>
              ) : null}
            </div>
          </Card>
        </div>
      )}

      {/* ★ 2026-08-25 拍板①：重做 modal（重做落單日 + 原因，兩項必填） */}
      {redoCase && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">標記重做 — <span className="font-mono">{redoCase.patientCode}</span></h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">重做落單日 * <span className="text-xs text-gray-400">（唔係到貨日）</span></label>
                <input type="date" value={redoForm.redoAt}
                  onChange={e => setRedoForm(f => ({ ...f, redoAt: e.target.value }))}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-sm mb-1">重做原因 * <span className="text-xs text-gray-400">（例：崩瓷 / 唔啱色）</span></label>
                <input value={redoForm.redoReason} placeholder="原因（例：崩瓷 / 唔啱色）"
                  onChange={e => setRedoForm(f => ({ ...f, redoReason: e.target.value }))}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
              <p className="text-xs text-gray-400">
                重做後狀態變「重做中」；finalCost 唔會自動變 — Lab 免費重做就唔使改成本，要再俾錢就之後用「修改」改 baseCost。
              </p>
            </div>
            <div className="flex justify-end gap-2 mt-4 pt-3 border-t">
              <button onClick={() => setRedoCase(null)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={submitRedo}
                disabled={redoSaving || !redoForm.redoAt || !redoForm.redoReason.trim()}
                className="px-4 py-1.5 bg-amber-600 text-white rounded text-sm hover:bg-amber-700 disabled:opacity-50 flex items-center gap-1">
                {redoSaving && <Loader2 size={14} className="animate-spin" />} 確認重做
              </button>
            </div>
          </Card>
        </div>
      )}

    </div>
  )
}
