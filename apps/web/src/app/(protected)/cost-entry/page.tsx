'use client'

import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import { todayHK } from '@/lib/hk-date'
import { ITEM_TYPES } from '@/lib/payout/constants'
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

interface MaterialLine {
  materialName: string
  qty: number
  unitPrice: number
  masterPrice: number | null
  isPriceOverridden: boolean
  subtotal: number
}

// ── Constants ──────────────────────────────────────────

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

// ── Helper: suggest category from bill items ──────────
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
    labId: '',
    labOrderNo: '',
    labOther: '',
    // ★ MD-K: manual mode fields
    patientCode: '',
    patientName: '',
  })
  const [savingCost, setSavingCost] = useState(false)

  // ★ MD-K: Implant material lines
  const [materialLines, setMaterialLines] = useState<MaterialLine[]>([])

  // ★ Q2: Discount from LabMonthlyDiscount table
  const [labDiscountPct, setLabDiscountPct] = useState<number | null>(null)
  const [labDiscountPeriodMonth, setLabDiscountPeriodMonth] = useState<string>('')

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
    loadMaterials()
  }, [loadAuth, loadProviders, loadClinics, loadLabs, loadMaterials])

  useEffect(() => {
    loadCases()
  }, [loadCases])

  // ★ Q2: Fetch discount from LabMonthlyDiscount
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
    })
    setMaterialLines([])
    setLabDiscountPct(null)
    setLabDiscountPeriodMonth('')
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
    })
    setMaterialLines([])

    if (clinicId) loadDsaEmployees(clinicId)
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

  // ★ MD-K: Material line helpers
  const addMaterialLine = () => {
    setMaterialLines(prev => [...prev, { materialName: '', qty: 1, unitPrice: 0, masterPrice: null, isPriceOverridden: false, subtotal: 0 }])
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
      }
      updated[idx] = line
      return updated
    })
  }

  const totalMaterialCost = materialLines.reduce((sum, l) => sum + l.subtotal, 0)

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
          materials: materialLines.map(l => ({
            materialName: l.materialName,
            qty: l.qty,
            unitPrice: l.isPriceOverridden || l.masterPrice === null ? l.unitPrice : undefined,
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
          labOrderNo: costForm.labOrderNo || null,
          dsaName: costForm.dsaName || null,
          baseCost: costForm.baseCost ? Number(costForm.baseCost) : null,
          receivedAt: costForm.receivedAt || null,
          appointmentAt: costForm.appointmentAt || null,
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
              <h2 className="text-lg font-bold mb-4 text-center">手動新增成本</h2>
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
                    <div>
                      <label className="block text-sm mb-1">醫生 *</label>
                      <select value={selectedProviderInternalId} onChange={e => setSelectedProviderInternalId(e.target.value)}
                        className="w-full border rounded px-2 py-1.5 text-sm" autoFocus>
                        <option value="">請選擇</option>
                        {providers.map(p => <option key={p.id} value={p.id}>{p.name || p.shortName}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm mb-1">診所 *</label>
                      <select value={selectedClinicInternalId} onChange={e => setSelectedClinicInternalId(e.target.value)}
                        className="w-full border rounded px-2 py-1.5 text-sm">
                        <option value="">請選擇</option>
                        {clinics.map(c => <option key={c.id} value={c.id}>{c.shortName || c.name}</option>)}
                      </select>
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
                  </div>
                )}

                {/* Editable form */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm mb-1">類別 {pickerMode === 'bill' && <span className="text-xs text-gray-400">（自動建議）</span>}</label>
                    <div className="flex gap-1">
                      {CATEGORIES.map(c => (
                        <button key={c} type="button"
                          onClick={() => setCostForm({ ...costForm, category: c })}
                          className={`px-3 py-1.5 text-sm rounded border ${
                            costForm.category === c ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                          }`}>
                          {CATEGORY_LABELS[c]}
                        </button>
                      ))}
                    </div>
                  </div>
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
                  <div>
                    <label className="block text-sm mb-1">落單日</label>
                    <input type="date" value={costForm.orderedAt} onChange={e => setCostForm({ ...costForm, orderedAt: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">DSA</label>
                    {loadingDsa ? (
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
                      <div>
                        <label className="block text-sm mb-1">折扣 % <span className="text-xs text-gray-400">（由工場折扣設定自動帶入）</span></label>
                        <div className="px-3 py-2 border rounded bg-muted text-sm">
                          {labDiscountPct != null
                            ? `${labDiscountPct}%（${labs.find(l => l.id === costForm.labId)?.name ?? '—'} · ${labDiscountPeriodMonth}）`
                            : '—（該工場今個月冇折扣設定）'}
                        </div>
                      </div>
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
                      <div>
                        <label className="block text-sm mb-1">Lab 單號</label>
                        <input value={costForm.labOrderNo} onChange={e => setCostForm({ ...costForm, labOrderNo: e.target.value })}
                          className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Lab 單號" />
                      </div>
                    </>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm mb-1">到貨日</label>
                    <input type="date" value={costForm.receivedAt} onChange={e => setCostForm({ ...costForm, receivedAt: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">覆診日</label>
                    <input type="date" value={costForm.appointmentAt} onChange={e => setCostForm({ ...costForm, appointmentAt: e.target.value })}
                      className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
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
                <button onClick={submitCost}
                  disabled={savingCost || (!selectedProviderInternalId && pickerMode === 'bill') || (!selectedClinicInternalId && pickerMode === 'bill')}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                  {savingCost && <Loader2 size={14} className="animate-spin" />} 確定錄入
                </button>
              ) : null}
            </div>
          </Card>
        </div>
      )}

    </div>
  )
}
