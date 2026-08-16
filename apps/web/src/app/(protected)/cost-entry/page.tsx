'use client'

import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import { todayHK } from '@/lib/hk-date'
import { ITEM_TYPES } from '@/lib/payout/constants'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, RefreshCw, Loader2, AlertTriangle, Search, ArrowLeft, Check, X } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────

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
  status: string
  periodMonth: string
  lockedByRunId: string | null
  lab?: { id: string; name: string }
  materials?: any[]
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

// ── Constants ──────────────────────────────────────────────────

const CATEGORIES = ['LAB', 'IMPLANT', 'INVISALIGN'] as const
const STATUSES = ['PENDING', 'PRICED', 'DONE'] as const

const CATEGORY_LABELS: Record<string, string> = {
  LAB: '牙醫化驗',
  IMPLANT: '植牙',
  INVISALIGN: '隱形矯正',
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  PENDING: { label: '未有價', color: 'yellow' },
  PRICED: { label: '已定價', color: 'blue' },
  DONE: { label: '已完成', color: 'green' },
  VOID: { label: '已作廢', color: 'gray' },
}

// ── Helper: suggest category from bill items ──────────────────
function suggestCategoryFromBill(bill: SearchBill): string {
  const desAll = bill.billDetails.map(d => (d.feeItem?.des ?? '').toUpperCase()).join(' ')
  if (desAll.includes('INVIS') || desAll.includes('CLEAR ALIGNER') || desAll.includes('透明')) return 'INVISALIGN'
  if (desAll.includes('IMPLANT') || desAll.includes('植入')) return 'IMPLANT'
  return 'LAB'
}

function suggestItemTypeFromBill(bill: SearchBill): string {
  const desAll = bill.billDetails.map(d => (d.feeItem?.des ?? '').toUpperCase()).join(' ')
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

// ── Main Component ─────────────────────────────────────────────

export default function CostEntryPage() {
  // ── Existing state (table + manual entry) ──────────────
  const [cases, setCases] = useState<CostCase[]>([])
  const [loading, setLoading] = useState(true)
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<any[]>([])
  const [labs, setLabs] = useState<any[]>([])
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

  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const [userId, setUserId] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [modalCategory, setModalCategory] = useState<'LAB' | 'INVISALIGN'>('LAB')
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    providerId: '', clinicId: '', category: 'LAB' as string,
    patientCode: '', patientName: '', orderedAt: '',
    itemType: '', labId: '', labOrderNo: '', dsaName: '',
    baseCost: '', discountPct: '', receivedAt: '', appointmentAt: '',
  })
  const [deleteId, setDeleteId] = useState<string | null>(null)

  // ── ★ MD-F: Picker state ───────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerStep, setPickerStep] = useState(0) // 0=patient, 1=bill, 2=cost

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
    labId: '',
    labOrderNo: '',
    labOther: '',
  })
  const [savingCost, setSavingCost] = useState(false)

  // ★ Q2: Discount from LabMonthlyDiscount table (read-only)
  const [labDiscountPct, setLabDiscountPct] = useState<number | null>(null)
  const [labDiscountPeriodMonth, setLabDiscountPeriodMonth] = useState<string>('')

  const canCreate = userRole ? hasPermission(userRole, 'cost_entry', grant, deny) : false

  // ── Existing load functions ──────────────────────────────

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

  const loadCases = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterProviderId) params.set('providerId', filterProviderId)
      if (filterPeriodMonth) params.set('periodMonth', filterPeriodMonth)
      if (filterCategory) params.set('category', filterCategory)
      if (filterStatus) params.set('status', filterStatus)
      if (filterClinicId) params.set('clinicId', filterClinicId)

      const data: any = await apiFetch(`/api/cost-cases?${params}`)
      setCases(data.cases || [])
      setSummary(data.summary || null)
    } catch (e) {
      console.error('Failed to load cases:', e)
    } finally {
      setLoading(false)
    }
  }, [filterProviderId, filterPeriodMonth, filterCategory, filterStatus, filterClinicId])

  const loadAuth = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/me')
      setUserRole(data.user?.role || '')
      setUserId(data.user?.id || '')
      const perms = data.user?.permissionsJson
      if (perms) {
        const parsed = typeof perms === 'string' ? JSON.parse(perms) : perms
        setGrant(parsed.grant || [])
        setDeny(parsed.deny || [])
      }
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
  }, [loadAuth, loadProviders, loadClinics, loadLabs])

  useEffect(() => {
    loadCases()
  }, [loadCases])

  // ★ Q2: Fetch discount from LabMonthlyDiscount when lab + orderedAt change
  useEffect(() => {
    if (pickerStep !== 2) return
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
  }, [costForm.labId, costForm.orderedAt, pickerStep])

  // ── Existing modal helpers ───────────────────────────────

  const resetForm = () => {
    setForm({
      providerId: '', clinicId: '', category: modalCategory,
      patientCode: '', patientName: '', orderedAt: todayHK(),
      itemType: '', labId: '', labOrderNo: '', dsaName: '',
      baseCost: '', discountPct: '', receivedAt: '', appointmentAt: '',
    })
  }

  const openCreateModal = (category: 'LAB' | 'INVISALIGN') => {
    setModalCategory(category)
    resetForm()
    setForm(prev => ({ ...prev, category }))
    setModalOpen(true)
  }

  const handleSubmit = async () => {
    if (!form.providerId || !form.clinicId || !form.patientCode || !form.orderedAt) {
      alert('醫生、診所、病人編號、落單日為必填')
      return
    }
    setSaving(true)
    try {
      const body: any = {
        providerId: form.providerId,
        clinicId: form.clinicId,
        category: form.category,
        patientCode: form.patientCode,
        patientName: form.patientName || null,
        orderedAt: form.orderedAt,
        itemType: form.itemType || null,
        labId: form.labId || null,
        labOrderNo: form.labOrderNo || null,
        dsaName: form.dsaName || null,
        baseCost: form.baseCost ? Number(form.baseCost) : null,
        // ★ Q2: discountPct removed — backend queries LabMonthlyDiscount table
        receivedAt: form.receivedAt || null,
        appointmentAt: form.appointmentAt || null,
      }

      await apiFetch('/api/cost-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      setModalOpen(false)
      loadCases()
    } catch (e) {
      alert(`建立失敗: ${e}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('確定要作廢呢筆記錄？')) return
    try {
      await apiFetch(`/api/cost-cases/${id}`, { method: 'DELETE' })
      loadCases()
    } catch (e: any) {
      alert(`作廢失敗: ${e.message}`)
    }
  }

  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('zh-HK') : '—'

  // ── ★ MD-F: Picker logic ────────────────────────────────

  const openPicker = () => {
    // Reset all picker state
    setPickerStep(0)
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
    })
    setLabDiscountPct(null)
    setLabDiscountPeriodMonth('')
    setPickerOpen(true)
  }

  const closePicker = () => {
    setPickerOpen(false)
    setApricotBusy(false)
  }

  // Step 0: search patients (button / Enter trigger)
  const handleSearchChange = (val: string) => {
    setSearchKeyword(val)
    setApricotBusy(false)
    setPatients([]) // clear old results on input change
  }

  const handleSearchSubmit = () => {
    if (searchKeyword.trim().length < 6) return
    searchPatientsApi(searchKeyword.trim())
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSearchSubmit()
    }
  }

  const searchPatientsApi = async (keyword: string) => {
    setSearchingPatients(true)
    setPatients([])
    setApricotBusy(false)
    try {
      const data: any = await apiFetch(`/api/cost-cases/patient-search?keyword=${encodeURIComponent(keyword)}`)
      setPatients(data.patients || [])
    } catch (e: any) {
      if (e?.status === 503) {
        setApricotBusy(true)
      }
    } finally {
      setSearchingPatients(false)
    }
  }

  // Step 0 → 1: select patient, search bills
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
      if (e?.status === 503) {
        setApricotBusy(true)
      }
    } finally {
      setSearchingBills(false)
    }
  }

  // Step 1 → 2: select bill, auto-fill form
  const selectBillForCost = (bill: SearchBill) => {
    setSelectedBill(bill)

    // Match clinic extId to internal clinic
    const clinic = clinics.find(c => c.apricotClinicId === bill.clinic?.id)
    const clinicId = clinic?.id || ''
    setSelectedClinicInternalId(clinicId)

    // Match provider extId to internal provider
    // bill.practitioner?.id → Provider.apricotId
    const provider = providers.find(p => p.apricotId === bill.practitioner?.id)
    const providerId = provider?.id || ''
    setSelectedProviderInternalId(providerId)

    // Suggest category + itemType from bill items
    const category = suggestCategoryFromBill(bill)
    const itemType = suggestItemTypeFromBill(bill)

    setCostForm({
      category,
      itemType,
      itemTypeOther: '',
      orderedAt: todayHK(),
      dsaName: '',
      baseCost: '',
      discountPct: '',
      receivedAt: '',
      appointmentAt: '',
      labId: '',
      labOrderNo: '',
      labOther: '',
    })

    // Load DSA employees
    if (clinicId) {
      loadDsaEmployees(clinicId)
    }

    setPickerStep(2)
  }

  const loadDsaEmployees = async (clinicId: string) => {
    setLoadingDsa(true)
    try {
      const data: any = await apiFetch(`/api/employees?clinicId=${encodeURIComponent(clinicId)}&status=ACTIVE&all=1`)
      setDsaEmployees(data.employees || data || [])
    } catch {
      setDsaEmployees([])
    } finally {
      setLoadingDsa(false)
    }
  }

  // Step 2: submit cost
  const submitCost = async () => {
    if (!selectedProviderInternalId || !selectedClinicInternalId) {
      alert('醫生或診所未能自動匹配，請用手動輸入')
      return
    }
    setSavingCost(true)
    try {
      const body: any = {
        providerId: selectedProviderInternalId,
        clinicId: selectedClinicInternalId,
        category: costForm.category,
        patientCode: selectedPatient?.code || '',
        patientName: selectedPatient?.fullName || null,
        orderedAt: costForm.orderedAt || todayHK(),
        itemType: costForm.itemType === 'Others' ? (costForm.itemTypeOther?.trim() || 'Others') : (costForm.itemType || null),
        itemTypeOther: costForm.itemType === 'Others' ? costForm.itemTypeOther || null : null,
        labId: costForm.labId === '__OTHERS__' || !costForm.labId ? null : costForm.labId,
        labOther: costForm.labId === '__OTHERS__' ? (costForm.labOther.trim() || null) : null,
        labOrderNo: costForm.labOrderNo || null,
        dsaName: costForm.dsaName || null,
        baseCost: costForm.baseCost ? Number(costForm.baseCost) : null,
        // ★ Q2: discountPct removed — backend queries LabMonthlyDiscount table
        receivedAt: costForm.receivedAt || null,
        appointmentAt: costForm.appointmentAt || null,
        // ★ MD-F: bill linking
        billExtId: selectedBill?.id || null,
        billCode: selectedBill?.code || null,
        billItemEleId: selectedBill?.billDetails?.[0]?.eleId || null,
      }

      await apiFetch('/api/cost-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      closePicker()
      loadCases()
    } catch (e) {
      alert(`建立失敗: ${e}`)
    } finally {
      setSavingCost(false)
    }
  }

  // ── Picker Step Labels ──────────────────────────────────
  const stepLabels = ['揀病人', '揀帳單', '填成本']
  const stepIcons = [Search, Search, Check]

  // ── Render ───────────────────────────────────────────────

  return (
    <div className="p-6 space-y-4">
      {/* Load error */}
      {loadError && (
        <Card className="p-3 bg-red-50 text-red-700 text-sm flex items-center gap-2">
          <AlertTriangle size={14} /> {loadError}
          <button onClick={() => setLoadError(null)} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </Card>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">成本錄入</h1>
        <div className="flex gap-2">
          {canCreate && (
            <>
              <button
                onClick={openPicker}
                className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 flex items-center gap-1"
              >
                <Plus size={14} /> 新增成本（揀單）
              </button>
              <div className="relative group">
                <button className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300">
                  手動輸入 ▾
                </button>
                <div className="absolute right-0 top-full mt-1 bg-white border rounded shadow-lg hidden group-hover:block z-10 min-w-[140px]">
                  <button onClick={() => openCreateModal('LAB')} className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-100">新增 LAB</button>
                  <button onClick={() => openCreateModal('INVISALIGN')} className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-100">新增 Invisalign</button>
                  <a href="/cost-entry/implant" className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-100">新增 Implant</a>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-5 gap-3">
          <select value={filterProviderId} onChange={e => setFilterProviderId(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">全部醫生</option>
            {providers.map(p => (<option key={p.id} value={p.id}>{p.name || p.shortName}</option>))}
          </select>
          <input type="month" value={filterPeriodMonth} onChange={e => setFilterPeriodMonth(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <select value={filterClinicId} onChange={e => setFilterClinicId(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">全部診所</option>
            {clinics.map(c => (<option key={c.id} value={c.id}>{c.shortName || c.name}</option>))}
          </select>
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">全部類別</option>
            {CATEGORIES.map(c => (<option key={c} value={c}>{CATEGORY_LABELS[c]}</option>))}
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
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-2">落單日</th>
                <th className="text-left p-2">病人編號</th>
                <th className="text-left p-2">病人姓名</th>
                <th className="text-left p-2">項目</th>
                <th className="text-left p-2">Lab · 單號</th>
                <th className="text-left p-2">DSA</th>
                <th className="text-right p-2">成本</th>
                <th className="text-left p-2">到貨</th>
                <th className="text-left p-2">覆診</th>
                <th className="text-left p-2">狀態</th>
                <th className="text-left p-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {cases.map(c => (
                <tr key={c.id} className="border-b hover:bg-gray-50">
                  <td className="p-2">{fmtDate(c.orderedAt)}</td>
                  <td className="p-2 font-mono">{c.patientCode}</td>
                  <td className="p-2">{c.patientName || '—'}</td>
                  <td className="p-2">
                    <Badge variant="secondary" className="text-xs">{CATEGORY_LABELS[c.category] || c.category}</Badge>
                    {c.itemType && <span className="ml-1 text-gray-500">{c.itemType}</span>}
                  </td>
                  <td className="p-2">
                    {c.lab?.name && <span>{c.lab.name}</span>}
                    {c.labOrderNo && <span className="ml-1 text-gray-500">{c.labOrderNo}</span>}
                  </td>
                  <td className="p-2">{c.dsaName || '—'}</td>
                  <td className="p-2 text-right">
                    {c.finalCost != null ? `$${c.finalCost.toFixed(2)}` : c.baseCost == null ? <span className="text-yellow-600">未有價</span> : '$—'}
                  </td>
                  <td className="p-2">{fmtDate(c.receivedAt)}</td>
                  <td className="p-2">{fmtDate(c.appointmentAt)}</td>
                  <td className="p-2">
                    <Badge variant={STATUS_CONFIG[c.status]?.color === 'green' ? 'default' : 'secondary'}>
                      {STATUS_CONFIG[c.status]?.label || c.status}
                    </Badge>
                  </td>
                  <td className="p-2">
                    {canCreate && c.status !== 'VOID' && !c.lockedByRunId && (
                      <button onClick={() => handleDelete(c.id)} className="text-red-500 text-xs hover:underline">作廢</button>
                    )}
                    {c.lockedByRunId && <span className="text-gray-400 text-xs">🔒</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Summary */}
      {summary && (
        <Card className="p-3">
          <div className="flex items-center gap-4 text-sm">
            <span>{filterPeriodMonth} 已入 {summary.total} 筆</span>
            <span>｜</span>
            <span>已定價 ${summary.totalFinalCost?.toFixed(2) ?? '0.00'}</span>
            {summary.unpricedCount > 0 && (
              <>
                <span>｜</span>
                <span className="flex items-center gap-1 text-yellow-600">
                  <AlertTriangle size={14} /> {summary.unpricedCount} 筆未有價（不會入月結）
                </span>
              </>
            )}
            {Object.keys(summary.labGroups || {}).length > 0 && (
              <>
                <span>｜</span>
                <span>按 lab：{Object.entries(summary.labGroups as Record<string, any>)
                  .map(([name, g]: [string, any]) => `${name} $${g.total?.toFixed(2) ?? '0.00'}`)
                  .join(' · ')}</span>
              </>
            )}
          </div>
        </Card>
      )}

      {/* ── ★ MD-F: 3-Step Picker Modal ─────────────────── */}
      {pickerOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-2xl max-h-[90vh] overflow-auto">
            {/* Step indicator */}
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

            {/* ── Step 0: Search Patient ─────────────────── */}
            {pickerStep === 0 && (
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
                  {searchKeyword.length > 0 && searchKeyword.length < 6 && (
                    <p className="text-xs text-gray-400 mt-1">最少輸入 6 字元</p>
                  )}
                </div>

                {/* Three states: searching / no results / apricot busy */}
                {searchingPatients && (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
                    <Loader2 size={16} className="animate-spin" /> 搜尋中…
                  </div>
                )}

                {apricotBusy && (
                  <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded">
                    <AlertTriangle size={16} /> Apricot 忙碌，請稍後重試
                  </div>
                )}

                {!searchingPatients && !apricotBusy && patients.length === 0 && searchKeyword.length >= 6 && (
                  <div className="text-sm text-gray-400 py-4 text-center">冇搵到病人</div>
                )}

                {/* Results */}
                <div className="space-y-1 max-h-60 overflow-auto">
                  {patients.map(p => (
                    <button
                      key={p.extId}
                      onClick={() => selectPatient(p)}
                      className="w-full text-left px-3 py-2 rounded hover:bg-blue-50 text-sm flex items-center justify-between border border-transparent hover:border-blue-200"
                    >
                      <span>
                        <span className="font-mono font-medium">{p.code}</span>
                        <span className="ml-2 text-gray-600">{p.fullName}</span>
                      </span>
                      <span className="text-xs text-gray-400">{p.extId.slice(0, 8)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Step 1: Search Bills ───────────────────── */}
            {pickerStep === 1 && selectedPatient && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm">
                  <button onClick={() => setPickerStep(0)} className="text-blue-600 hover:underline flex items-center gap-1">
                    <ArrowLeft size={14} /> 返回
                  </button>
                  <span className="font-mono font-medium">{selectedPatient.code}</span>
                  <span className="text-gray-600">{selectedPatient.fullName}</span>
                </div>

                {searchingBills && (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
                    <Loader2 size={16} className="animate-spin" /> 載入帳單…
                  </div>
                )}

                {apricotBusy && (
                  <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded">
                    <AlertTriangle size={16} /> Apricot 忙碌，請稍後重試
                  </div>
                )}

                {!searchingBills && !apricotBusy && bills.length === 0 && (
                  <div className="text-sm text-gray-400 py-4 text-center">近 12 個月冇帳單</div>
                )}

                {/* Bill list */}
                <div className="space-y-2 max-h-80 overflow-auto">
                  {bills.map(b => (
                    <button
                      key={b.id}
                      onClick={() => !b.isVoid && selectBillForCost(b)}
                      disabled={b.isVoid}
                      className={`w-full text-left border rounded p-3 text-sm ${
                        b.isVoid
                          ? 'opacity-40 cursor-not-allowed bg-gray-50'
                          : 'hover:bg-blue-50 hover:border-blue-200'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium">{b.code}</span>
                          <span className="text-gray-400">{new Date(b.billTime).toLocaleDateString('zh-HK')}</span>
                          {b.isVoid && <Badge variant="secondary" className="text-xs bg-gray-100">已作廢</Badge>}
                          {b.isRefunded && <Badge variant="secondary" className="text-xs bg-orange-50 text-orange-600">已退款</Badge>}
                          {b.existingCostCount > 0 && (
                            <Badge variant="secondary" className="text-xs bg-yellow-50 text-yellow-700">
                              已錄 {b.existingCostCount} 筆
                            </Badge>
                          )}
                        </div>
                        <div className="text-right">
                          <span className="font-medium">HK${Number(b.ttlAmt).toFixed(2)}</span>
                          {b.osAmt && Number(b.osAmt) > 0 && (
                            <span className="text-xs text-gray-400 ml-2">欠 ${Number(b.osAmt).toFixed(0)}</span>
                          )}
                        </div>
                      </div>
                      {/* Bill items (compact) */}
                      {b.billDetails.length > 0 && (
                        <div className="mt-1 pt-1 border-t text-xs text-gray-500 space-y-0.5">
                          {b.billDetails.slice(0, 3).map((item, i) => (
                            <div key={i} className="flex justify-between">
                              <span>{item.feeItem?.des || item.eleId}</span>
                              <span>x{item.qty} × ${Number(item.up).toFixed(0)}</span>
                            </div>
                          ))}
                          {b.billDetails.length > 3 && (
                            <div className="text-gray-400">… 等共 {b.billDetails.length} 項</div>
                          )}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Step 2: Fill Cost ──────────────────────── */}
            {pickerStep === 2 && selectedBill && selectedPatient && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm">
                  <button onClick={() => setPickerStep(1)} className="text-blue-600 hover:underline flex items-center gap-1">
                    <ArrowLeft size={14} /> 返回
                  </button>
                  <span className="text-gray-500">帳單 {selectedBill.code}</span>
                </div>

                {/* Read-only section: doctor / clinic / patient */}
                <Card className="p-3 bg-gray-50 space-y-2">
                  <div className="text-xs font-medium text-gray-500 mb-1">自動帶入（唯讀）</div>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <label className="block text-xs text-gray-400">醫生</label>
                      <div className="py-1">
                        {selectedProviderInternalId ? (
                          <span>{providers.find(p => p.id === selectedProviderInternalId)?.name}</span>
                        ) : (
                          <div className="text-sm">
                            <div className="text-amber-700">⚠️ 醫生未對應</div>
                            <div className="text-xs text-muted-foreground mt-1">
                              Apricot 醫生：<code>{selectedBill?.practitioner?.id ?? '—'}</code>
                            </div>
                            <div className="text-xs mt-1">
                              請去 <a href="/providers" className="underline">醫生管理</a> 將呢個 ID 填入對應醫生嘅「Apricot ID」
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400">診所</label>
                      <div className="py-1">
                        {selectedClinicInternalId ? (
                          <span>{clinics.find(c => c.id === selectedClinicInternalId)?.shortName || clinics.find(c => c.id === selectedClinicInternalId)?.name}</span>
                        ) : (
                          <div className="text-sm">
                            <div className="text-amber-700">⚠️ 診所未對應</div>
                            <div className="text-xs text-muted-foreground mt-1">
                              Apricot 診所：<code>{selectedBill?.clinic?.id ?? '—'}</code>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400">病人</label>
                      <div className="py-1">
                        <span className="font-mono">{selectedPatient.code}</span>
                        <span className="ml-1 text-gray-500">{selectedPatient.fullName}</span>
                      </div>
                    </div>
                  </div>
                </Card>

                {/* Editable form */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm mb-1">類別 <span className="text-xs text-gray-400">（自動建議）</span></label>
                    <select
                      value={costForm.category}
                      onChange={e => setCostForm({ ...costForm, category: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                    >
                      {CATEGORIES.map(c => (<option key={c} value={c}>{CATEGORY_LABELS[c]}</option>))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm mb-1">項目 <span className="text-xs text-gray-400">（可改）</span></label>
                    <select
                      value={costForm.itemType}
                      onChange={e => setCostForm({ ...costForm, itemType: e.target.value, itemTypeOther: e.target.value === 'Others' ? costForm.itemTypeOther : '' })}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                    >
                      {ITEM_TYPES.map(t => (<option key={t} value={t}>{t}</option>))}
                    </select>
                    {costForm.itemType === 'Others' && (
                      <input
                        value={costForm.itemTypeOther}
                        onChange={e => setCostForm({ ...costForm, itemTypeOther: e.target.value })}
                        className="w-full border rounded px-2 py-1.5 text-sm mt-1"
                        placeholder="輸入具體項目名稱"
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-sm mb-1">落單日</label>
                    <input
                      type="date"
                      value={costForm.orderedAt}
                      onChange={e => setCostForm({ ...costForm, orderedAt: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">DSA</label>
                    {loadingDsa ? (
                      <div className="py-1.5 text-sm text-gray-400"><Loader2 size={14} className="animate-spin inline" /> 載入中…</div>
                    ) : (
                      <select
                        value={costForm.dsaName}
                        onChange={e => setCostForm({ ...costForm, dsaName: e.target.value })}
                        className="w-full border rounded px-2 py-1.5 text-sm"
                      >
                        <option value="">不選</option>
                        {dsaEmployees.map((emp: any) => (
                          <option key={emp.id} value={emp.user?.name || emp.id}>
                            {emp.user?.name || emp.id}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm mb-1">成本 <span className="text-xs text-gray-400">（留空 = 未有價）</span></label>
                    <input
                      type="number"
                      step="0.01"
                      value={costForm.baseCost}
                      onChange={e => setCostForm({ ...costForm, baseCost: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                      placeholder="成本金額"
                    />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">折扣 % <span className="text-xs text-gray-400">（由工場折扣設定自動帶入）</span></label>
                    <div className="px-3 py-2 border rounded bg-muted text-sm">
                      {labDiscountPct != null
                        ? `${labDiscountPct}%（${labs.find(l => l.id === costForm.labId)?.name ?? '—'} · ${labDiscountPeriodMonth}）`
                        : '—（該工場今個月冇折扣設定）'}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm mb-1">到貨日</label>
                    <input
                      type="date"
                      value={costForm.receivedAt}
                      onChange={e => setCostForm({ ...costForm, receivedAt: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">覆診日</label>
                    <input
                      type="date"
                      value={costForm.appointmentAt}
                      onChange={e => setCostForm({ ...costForm, appointmentAt: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Lab</label>
                    <select
                      value={costForm.labId}
                      onChange={e => {
                        const val = e.target.value
                        setCostForm({ ...costForm, labId: val, labOther: val === '__OTHERS__' ? costForm.labOther : '' })
                      }}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                    >
                      <option value="">（不選）</option>
                      {labs.map((lab: any) => (
                        <option key={lab.id} value={lab.id}>{lab.name}</option>
                      ))}
                      <option value="__OTHERS__">其他（自行輸入）</option>
                    </select>
                    {costForm.labId === '__OTHERS__' && (
                      <input
                        value={costForm.labOther}
                        onChange={e => setCostForm({ ...costForm, labOther: e.target.value })}
                        className="w-full border rounded px-2 py-1.5 text-sm mt-1"
                        placeholder="工場名稱"
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Lab 單號</label>
                    <input
                      value={costForm.labOrderNo}
                      onChange={e => setCostForm({ ...costForm, labOrderNo: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm"
                      placeholder="Lab 單號"
                    />
                  </div>
                </div>

                {/* Bill items reference */}
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
              </div>
            )}

            {/* Footer actions */}
            <div className="flex justify-between mt-4 pt-3 border-t">
              {pickerStep === 0 ? (
                <button onClick={closePicker} className="px-4 py-1.5 border rounded text-sm">取消</button>
              ) : (
                <button onClick={() => pickerStep === 1 ? setPickerStep(0) : setPickerStep(1)} className="px-4 py-1.5 border rounded text-sm flex items-center gap-1">
                  <ArrowLeft size={14} /> 上一步
                </button>
              )}
              {pickerStep === 2 && (
                <button
                  onClick={submitCost}
                  disabled={savingCost || !selectedProviderInternalId || !selectedClinicInternalId}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
                >
                  {savingCost && <Loader2 size={14} className="animate-spin" />} 確定錄入
                </button>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* ── Existing Manual Entry Modal ─────────────────── */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-lg max-h-[90vh] overflow-auto">
            <h2 className="text-lg font-bold mb-4">新增 {CATEGORY_LABELS[modalCategory] || modalCategory} 成本</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm mb-1">醫生 *</label>
                <select value={form.providerId} onChange={e => setForm({ ...form, providerId: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm">
                  <option value="">請選擇</option>
                  {providers.map(p => <option key={p.id} value={p.id}>{p.name || p.shortName}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">診所 *</label>
                <select value={form.clinicId} onChange={e => setForm({ ...form, clinicId: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm">
                  <option value="">請選擇</option>
                  {clinics.map(c => <option key={c.id} value={c.id}>{c.shortName || c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">病人編號 *</label>
                <input value={form.patientCode} onChange={e => setForm({ ...form, patientCode: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="病人編號" />
              </div>
              <div>
                <label className="block text-sm mb-1">病人姓名</label>
                <input value={form.patientName} onChange={e => setForm({ ...form, patientName: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="病人姓名" />
              </div>
              <div>
                <label className="block text-sm mb-1">落單日 *</label>
                <input type="date" value={form.orderedAt} onChange={e => setForm({ ...form, orderedAt: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-sm mb-1">項目</label>
                <input value={form.itemType} onChange={e => setForm({ ...form, itemType: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Crown / Bridge / ..." />
              </div>
              <div>
                <label className="block text-sm mb-1">Lab</label>
                <input value={form.labId} onChange={e => setForm({ ...form, labId: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Lab ID" />
              </div>
              <div>
                <label className="block text-sm mb-1">Lab 單號</label>
                <input value={form.labOrderNo} onChange={e => setForm({ ...form, labOrderNo: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Lab 單號" />
              </div>
              <div>
                <label className="block text-sm mb-1">DSA</label>
                <input value={form.dsaName} onChange={e => setForm({ ...form, dsaName: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="DSA 名稱" />
              </div>
              <div>
                <label className="block text-sm mb-1">成本</label>
                <input type="number" step="0.01" value={form.baseCost} onChange={e => setForm({ ...form, baseCost: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="留空 = 未有價" />
              </div>
              <div>
                <label className="block text-sm mb-1">折扣 % <span className="text-xs text-gray-400">（由工場折扣設定自動帶入）</span></label>
                <div className="px-3 py-2 border rounded bg-muted text-sm">—（提交時由 LabMonthlyDiscount 查表）</div>
              </div>
              <div>
                <label className="block text-sm mb-1">到貨日</label>
                <input type="date" value={form.receivedAt} onChange={e => setForm({ ...form, receivedAt: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-sm mb-1">覆診日</label>
                <input type="date" value={form.appointmentAt} onChange={e => setForm({ ...form, appointmentAt: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setModalOpen(false)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={handleSubmit} disabled={saving}
                className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                {saving && <Loader2 size={14} className="animate-spin" />} 確定
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
