'use client'

/**
 * MD-U: Provider Referrals — 轉介錄入（改版 V2）
 * - U2: 帳單搜尋 + 勾選項目 + 批次轉介
 * - U3: 草稿系統（DRAFT/CONFIRMED）+ 取消確認
 * - V1: 分三區直排（草稿最前 → 已確認 → 帳單轉介）
 * - Y2: 按 billCode 分組摺疊
 * - Y3: 月份過濾（草稿不分月）
 * - Y4: 病人編號搜尋
 * OWNER / provider_payout 權限
 */
import { useEffect, useMemo, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Plus, Trash2, ArrowLeft, Search, Check, RotateCcw, FileText, ClipboardList,
  ChevronDown, ChevronRight, Users,
  Loader2, AlertCircle,
} from 'lucide-react'

/** W1: Draft reference for completing a draft with bill data */
interface DraftRef {
  id: string
  fromProviderId: string
  fromProviderName?: string
  patientNote: string | null
  periodMonth: string
}

interface ConfirmedRef {
  id: string
  fromProviderId: string
  fromProviderName?: string
  clinicName: string | null | '__DELETED_CLINIC__'
  billCode: string | null
  billExtId: string | null
  billTime: string | null
  itemDes: string | null
  unitPrice: number | null
  qty: number
  refPercent: number
  amount: number | null
  lockedByRunId: string | null
  periodMonth: string
}

export default function ReferralsPage() {
  // ─── Data ───────────────────────────────────────────────────────
  const [confirmedRefs, setConfirmedRefs] = useState<ConfirmedRef[]>([])
  const [draftRefs, setDraftRefs] = useState<any[]>([])
  const [providers, setProviders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Y3: Month filter
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  // Y2: Collapse state
  const [expandedBills, setExpandedBills] = useState<Set<string>>(new Set())

  // Y2: Filter by doctor / clinic / billCode
  const [filterDoctor, setFilterDoctor] = useState('')
  const [filterClinic, setFilterClinic] = useState('')
  const [filterBillCode, setFilterBillCode] = useState('')

  // Y4: Patient search mode
  type SearchMode = 'billCode' | 'patient'
  const [searchMode, setSearchMode] = useState<SearchMode>('billCode')
  const [patientSearch, setPatientSearch] = useState('')
  const [patientResults, setPatientResults] = useState<any[] | null>(null)
  const [patientSearching, setPatientSearching] = useState(false)
  const [patientSearchError, setPatientSearchError] = useState<string | null>(null)
  const [selectedPatient, setSelectedPatient] = useState<any | null>(null)
  const [billSearchResults, setBillSearchResults] = useState<any[] | null>(null)
  const [billSearching, setBillSearching] = useState(false)
  const [billSearchError, setBillSearchError] = useState<string | null>(null)

  // ─── Bill lookup state ─────────────────────────────────────────
  const [searchCode, setSearchCode] = useState('')
  const [billData, setBillData] = useState<any>(null)
  const [selectedItems, setSelectedItems] = useState<string[]>([])
  const [refPercent, setRefPercent] = useState('2')
  const [batchLoading, setBatchLoading] = useState(false)

  // W1: completingDraft state
  const [completingDraft, setCompletingDraft] = useState<DraftRef | null>(null)

  // ─── Draft form state ──────────────────────────────────────────
  const [showDraftForm, setShowDraftForm] = useState(false)
  const [draftForm, setDraftForm] = useState({
    fromProviderId: '',
    toProviderId: '',
    patientNote: '',
    periodMonth: new Date().toISOString().slice(0, 7),
  })
  const [draftSaving, setDraftSaving] = useState(false)

  // W1: fromProviderId for bill-referral-section (pre-filled from draft or bill)
  const [fromProviderId, setFromProviderId] = useState('')

  // ─── Effects ───────────────────────────────────────────────────
  useEffect(() => { loadAll() }, [month])

  async function loadAll() {
    try {
      // Y3: Confirmed = with month filter; Draft = no month filter
      const [refConfirmedRes, refDraftRes, provRes] = await Promise.all([
        apiFetch<any>(`/api/provider-referrals?periodMonth=${month}&status=CONFIRMED`),
        apiFetch<any>(`/api/provider-referrals?status=DRAFT`),
        apiFetch<any>('/api/providers'),
      ])
      setConfirmedRefs((refConfirmedRes as any).referrals || [])
      setDraftRefs((refDraftRes as any).referrals || [])
      setProviders((provRes as any).providers || [])
    } catch (e) {
      console.error('Failed to load data', e)
    } finally {
      setLoading(false)
    }
  }

  // ─── Bill lookup ───────────────────────────────────────────────
  async function lookupBill() {
    if (!searchCode.trim()) return
    try {
      const res = await apiFetch<any>(`/api/provider-referrals/bill-lookup?code=${encodeURIComponent(searchCode.trim())}`)
      setBillData(res)
      setSelectedItems([])
      if (!completingDraft && res.providerId) {
        setFromProviderId(res.providerId)
      }
    } catch (e: any) {
      alert(`查找失敗: ${e.message || '帳單未找到'}`)
      setBillData(null)
    }
  }

  // Y4: Patient search handlers
  async function searchPatients() {
    if (!patientSearch.trim() || patientSearch.trim().length < 6) {
      if (patientSearch.trim().length > 0 && patientSearch.trim().length < 6) {
        setPatientSearchError('病人編號最少 6 字元')
      }
      return
    }
    setPatientSearching(true)
    setPatientSearchError(null)
    setPatientResults(null)
    try {
      const res = await apiFetch<any>(`/api/cost-cases/patient-search?keyword=${encodeURIComponent(patientSearch.trim())}`)
      if ((res as any).error) {
        setPatientSearchError((res as any).error)
        setPatientResults([])
      } else {
        setPatientResults(res.patients || [])
        if (res.patients?.length === 0) {
          setPatientSearchError(`揾唔到病人編號 ${patientSearch.trim()}`)
        }
      }
    } catch (e: any) {
      setPatientSearchError(`Apricot 連線失敗（或系統同步中）`)
      setPatientResults(null)
    } finally {
      setPatientSearching(false)
    }
  }

  async function selectPatient(patient: any) {
    setSelectedPatient(patient)
    setBillSearchResults(null)
    setBillSearching(true)
    setBillSearchError(null)
    try {
      const res = await apiFetch<any>(`/api/cost-cases/bill-search?patientExtId=${patient.id}&months=12`)
      if ((res as any).error) {
        setBillSearchError((res as any).error)
        setBillSearchResults([])
      } else {
        // Count existing referrals per bill
        const billsWithReferralCount = (res.bills || []).map((b: any) => {
          const referralCount = confirmedRefs.filter(r => r.billExtId === b.id).length
          return { ...b, referralCount }
        })
        setBillSearchResults(billsWithReferralCount)
      }
    } catch (e: any) {
      setBillSearchError(`Apricot 連線失敗（或系統同步中）`)
      setBillSearchResults(null)
    } finally {
      setBillSearching(false)
    }
  }

  async function selectBillFromPatient(bill: any) {
    // bill-search doesn't return items; fetch via bill-lookup
    try {
      const res = await apiFetch<any>(`/api/provider-referrals/bill-lookup?code=${encodeURIComponent(bill.code)}`)
      setBillData(res)
      setSelectedItems([])
      if (res.providerId && !completingDraft) {
        setFromProviderId(res.providerId)
      }
    } catch (e: any) {
      alert(`載入帳單項目失敗: ${e.message || '未知錯誤'}`)
      return
    }
    document.getElementById('bill-referral-section')?.scrollIntoView({ behavior: 'smooth' })
  }

  const toggleItem = (eleId: string) => {
    setSelectedItems(v => v.includes(eleId) ? v.filter(x => x !== eleId) : [...v, eleId])
  }

  const selectedTotal = useMemo(() => {
    const items = billData?.items.filter((i: any) => selectedItems.includes(i.eleId)) || []
    return items.reduce((sum: number, i: any) => sum + i.unitPrice * i.qty, 0)
  }, [billData, selectedItems])

  const totalRef = useMemo(() => {
    return selectedItems.reduce((sum: number, eleId: string) => {
      const it = billData?.items.find((i: any) => i.eleId === eleId)
      if (!it) return sum
      return sum + Math.round(Number(it.unitPrice) * Number(it.qty) * (Number(refPercent) || 0) / 100 * 100) / 100
    }, 0)
  }, [billData, selectedItems, refPercent])

  // W1: handleSubmit — dual path (completingDraft → POST /complete / new → batch POST)
  async function handleSubmit() {
    if (completingDraft) {
      if (selectedItems.length === 0) { alert('請至少揀一個項目'); return }
      if (!billData) { alert('請先搜尋帳單'); return }
      const items = selectedItems.map(eleId => {
        const it = billData!.items.find((i: any) => i.eleId === eleId)!
        return { eleId, itemDes: it.feeItemDes, unitPrice: it.unitPrice, qty: it.qty }
      })
      setBatchLoading(true)
      try {
        await apiFetch(`/api/provider-referrals/${completingDraft.id}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            billExtId: billData.billExtId,
            billCode: billData.billCode,
            refPercent,
            items,
          }),
        })
        setCompletingDraft(null)
        setFromProviderId('')
        setBillData(null)
        setSelectedItems([])
        setSearchCode('')
        await loadAll()
      } catch (e: any) {
        alert(`補上帳單失敗：${e.message}`)
      } finally {
        setBatchLoading(false)
      }
      return
    }

    // Batch new referral path
    if (selectedItems.length === 0) { alert('請勾選項目'); return }
    if (!billData) return
    setBatchLoading(true)
    try {
      const items = billData.items.filter((i: any) => selectedItems.includes(i.eleId))
      await apiFetch('/api/provider-referrals/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromProviderId,
          billExtId: billData.billExtId,
          refPercent: Number(refPercent),
          items: items.map((i: any) => ({
            eleId: i.eleId,
            itemDes: i.feeItemDes,
            unitPrice: i.unitPrice,
            qty: i.qty,
          })),
        }),
      })
      alert(`成功新增 ${items.length} 筆轉介`)
      setSelectedItems([])
      setBillData(null)
      setSearchCode('')
      loadAll()
    } catch (e: any) {
      alert(`批次轉介失敗: ${e.message}`)
    } finally {
      setBatchLoading(false)
    }
  }

  // ─── Draft operations ──────────────────────────────────────────
  async function handleCreateDraft(e: React.FormEvent) {
    e.preventDefault()
    if (!draftForm.fromProviderId || !draftForm.periodMonth) {
      alert('轉介醫生和月份為必填')
      return
    }
    setDraftSaving(true)
    try {
      await apiFetch('/api/provider-referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draftForm,
          status: 'DRAFT',
        }),
      })
      setDraftForm({
        fromProviderId: '', toProviderId: '', patientNote: '',
        periodMonth: new Date().toISOString().slice(0, 7),
      })
      setFromProviderId('')
      setShowDraftForm(false)
      loadAll()
    } catch (e: any) {
      alert(`建立草稿失敗: ${e.message}`)
    } finally {
      setDraftSaving(false)
    }
  }

  async function handleDeleteDraft(id: string) {
    if (!confirm('確定刪除此草稿？')) return
    try {
      await apiFetch(`/api/provider-referrals/${id}`, { method: 'DELETE' })
      loadAll()
    } catch (e: any) {
      alert(`刪除失敗: ${e.message}`)
    }
  }

  function goToBillReferral(draft: DraftRef) {
    setCompletingDraft(draft)
    setFromProviderId(draft.fromProviderId)
    setSearchCode('')
    setBillData(null)
    setSelectedItems([])
    document.getElementById('bill-referral-section')?.scrollIntoView({ behavior: 'smooth' })
  }

  // ─── Confirmed operations ──────────────────────────────────────
  async function handleReset(id: string) {
    if (!confirm('確定取消確認？轉介將變回草稿狀態。')) return
    try {
      await apiFetch(`/api/provider-referrals/${id}/reset`, { method: 'POST' })
      loadAll()
    } catch (e: any) {
      alert(`取消確認失敗: ${e.message}`)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('確定刪除此轉介記錄？')) return
    try {
      await apiFetch(`/api/provider-referrals/${id}`, { method: 'DELETE' })
      loadAll()
    } catch (e: any) {
      alert(`刪除失敗: ${e.message}`)
    }
  }

  // Y2: Reset entire bill group — skip locked items
  const resetBillGroup = useCallback(async (billCode: string, group: ConfirmedRef[]) => {
    const resettable = group.filter(r => !r.lockedByRunId)
    if (resettable.length === 0) {
      alert('該帳單全部轉介已鎖定')
      return
    }
    if (resettable.length < group.length) {
      if (!confirm(`${group.length} 項中有 ${group.length - resettable.length} 項已鎖定，只會取消 ${resettable.length} 項。繼續？`)) {
        return
      }
    }
    for (const r of resettable) {
      await apiFetch(`/api/provider-referrals/${r.id}/reset`, { method: 'POST' })
    }
    await loadAll()
  }, [])

  // Y3: Filter confirmed by doctor / clinic / billCode
  const filteredConfirmed = useMemo(() => {
    return confirmedRefs.filter(r => {
      if (filterDoctor && r.fromProviderId !== filterDoctor) return false
      if (filterClinic && r.clinicName !== '__DELETED_CLINIC__' && r.clinicName !== filterClinic) return false
      if (filterClinic && r.clinicName === '__DELETED_CLINIC__') return false
      if (filterBillCode && r.billCode !== filterBillCode) return false
      return true
    })
  }, [confirmedRefs, filterDoctor, filterClinic, filterBillCode])

  // Y2: Group confirmed by billCode
  const groupedConfirmed = useMemo(() => {
    const map = new Map<string, ConfirmedRef[]>()
    for (const r of filteredConfirmed) {
      const key = r.billCode ?? '(無帳單)'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    // Sort by billTime desc, then billCode desc
    return [...map.entries()].sort((a, b) => {
      const ta = a[1][0].billTime ? new Date(a[1][0].billTime).getTime() : 0
      const tb = b[1][0].billTime ? new Date(b[1][0].billTime).getTime() : 0
      if (tb !== ta) return tb - ta
      return b[0].localeCompare(a[0])
    })
  }, [filteredConfirmed])

  // Unique clinics for filter dropdown
  const clinicNames = useMemo(() => {
    const set = new Set<string>()
    for (const r of confirmedRefs) {
      if (r.clinicName && r.clinicName !== '__DELETED_CLINIC__') set.add(r.clinicName)
    }
    return [...set]
  }, [confirmedRefs])

  const toggleBillExpand = (key: string) => {
    setExpandedBills(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Y3: Summary stats
  const confirmedTotal = useMemo(() => {
    return confirmedRefs.reduce((sum, r) => sum + (r.amount ?? 0), 0)
  }, [confirmedRefs])

  if (loading) return <div className="p-6">載入中...</div>

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <a href="/payout" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-2">
        <ArrowLeft size={14} /> 返回醫生月結單
      </a>
      <h1 className="text-2xl font-bold">轉介錄入</h1>

      {/* ═══════════════════════════════════════════════════════
          SECTION 1: Draft referrals (最前 — 未完成嘅工作)
          ═══════════════════════════════════════════════════════ */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2">
            <FileText className="w-4 h-4" />
            草稿（{draftRefs.length} 筆，不分月份）
          </h2>
          <Button size="sm" onClick={() => setShowDraftForm(v => !v)}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            {showDraftForm ? '收起表單' : '新增草稿'}
          </Button>
        </div>

        {/* Draft creation form */}
        {showDraftForm && (
          <form onSubmit={handleCreateDraft} className="mb-4 p-3 bg-amber-50 rounded space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">轉介醫生 *</label>
                <select
                  className="w-full border rounded px-3 py-2"
                  value={draftForm.fromProviderId}
                  onChange={e => setDraftForm({ ...draftForm, fromProviderId: e.target.value })}
                  required
                >
                  <option value="">選擇醫生</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">接手醫生（可選）</label>
                <select
                  className="w-full border rounded px-3 py-2"
                  value={draftForm.toProviderId}
                  onChange={e => setDraftForm({ ...draftForm, toProviderId: e.target.value })}
                >
                  <option value="">選擇醫生</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">病人備註</label>
              <Input
                value={draftForm.patientNote}
                onChange={e => setDraftForm({ ...draftForm, patientNote: e.target.value })}
                placeholder="病人名稱或識別資訊"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">月份 *</label>
              <Input
                type="month"
                value={draftForm.periodMonth}
                onChange={e => setDraftForm({ ...draftForm, periodMonth: e.target.value })}
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={draftSaving} size="sm">
                {draftSaving ? '提交中...' : '建立草稿'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowDraftForm(false)}>
                取消
              </Button>
            </div>
          </form>
        )}

        {/* Draft list */}
        {draftRefs.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">暫無草稿</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b bg-gray-50">
                <th className="py-2 px-2">轉介醫生</th>
                <th className="py-2 px-2">病人備註</th>
                <th className="py-2 px-2">月份</th>
                <th className="py-2 px-2 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {draftRefs.map((d: any) => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="py-2 px-2">{d.fromProviderName || d.fromProviderId}</td>
                  <td className="py-2 px-2">{d.patientNote || '—'}</td>
                  <td className="py-2 px-2">{d.periodMonth}</td>
                  <td className="py-2 px-2 text-center space-x-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-blue-600 text-xs"
                      onClick={() => goToBillReferral({
                        id: d.id,
                        fromProviderId: d.fromProviderId,
                        fromProviderName: d.fromProviderName,
                        patientNote: d.patientNote,
                        periodMonth: d.periodMonth,
                      })}
                    >
                      <FileText className="w-3.5 h-3.5 mr-1" />
                      補上帳單
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteDraft(d.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ═══════════════════════════════════════════════════════
          SECTION 2: Confirmed referrals (Y2: 摺疊分組 + Y3: 月份過濾)
          ═══════════════════════════════════════════════════════ */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Check className="w-4 h-4" />
          已確認（{filteredConfirmed.length} 筆 · 合共 ${confirmedTotal.toFixed(2)}）
        </h2>

        {/* Y3: Filter bar */}
        <div className="flex flex-wrap gap-3 mb-4 p-3 bg-gray-50 rounded">
          <div>
            <label className="block text-xs text-gray-500 mb-1">月份</label>
            <Input
              type="month"
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="w-36"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">醫生</label>
            <select
              className="border rounded px-2 py-2 text-sm w-32"
              value={filterDoctor}
              onChange={e => setFilterDoctor(e.target.value)}
            >
              <option value="">全部</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">診所</label>
            <select
              className="border rounded px-2 py-2 text-sm w-32"
              value={filterClinic}
              onChange={e => setFilterClinic(e.target.value)}
            >
              <option value="">全部</option>
              {clinicNames.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">帳單編號</label>
            <Input
              value={filterBillCode}
              onChange={e => setFilterBillCode(e.target.value)}
              placeholder="帳單編號____"
              className="w-44"
            />
          </div>
        </div>

        {filteredConfirmed.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">暫無已確認轉介</p>
        ) : (
          <div className="space-y-1">
            {/* Y2: Grouped confirmed by billCode */}
            {groupedConfirmed.map(([billCode, items]) => {
              const isSingle = items.length === 1
              const isExpanded = expandedBills.has(billCode) || isSingle
              const groupTotal = items.reduce((s, r) => s + (r.amount ?? 0), 0)
              const firstItem = items[0]
              const billDate = firstItem.billTime
                ? new Date(firstItem.billTime).toLocaleDateString('zh-HK')
                : '—'

              return (
                <div key={billCode} className="border rounded mb-1">
                  {/* Collapse header */}
                  {!isSingle && (
                    <button
                      onClick={() => toggleBillExpand(billCode)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-gray-50 hover:bg-gray-100 rounded cursor-pointer text-left"
                    >
                      {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                      <span className="font-mono font-medium">{billCode}</span>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-600">{firstItem.fromProviderName || '—'}</span>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-600">
                        {firstItem.clinicName === '__DELETED_CLINIC__'
                          ? '⚠️ 診所已刪除'
                          : (firstItem.clinicName || '—')}
                      </span>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-600">{billDate}</span>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-600">{items.length} 個項目</span>
                      <span className="font-medium ml-1">${groupTotal.toFixed(2)}</span>
                    </button>
                  )}

                  {/* Items table */}
                  {(isExpanded || isSingle) && (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left border-b bg-gray-50">
                          <th className="py-2 px-2">帳單編號</th>
                          <th className="py-2 px-2">轉介醫生</th>
                          <th className="py-2 px-2">診所</th>
                          <th className="py-2 px-2">項目</th>
                          <th className="py-2 px-2 text-right">單價</th>
                          <th className="py-2 px-2 text-right">數量</th>
                          <th className="py-2 px-2 text-right">轉介%</th>
                          <th className="py-2 px-2 text-right">金額</th>
                          <th className="py-2 px-2 text-center">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((r: ConfirmedRef) => (
                          <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50">
                            <td className="py-2 px-2 font-mono text-xs">{r.billCode || '—'}</td>
                            <td className="py-2 px-2">{r.fromProviderName || r.fromProviderId}</td>
                            <td className="py-2 px-2">
                              {r.clinicName === '__DELETED_CLINIC__'
                                ? <span className="text-amber-600 text-xs">⚠️ 診所已刪除</span>
                                : (r.clinicName || '—')}
                            </td>
                            <td className="py-2 px-2">{r.itemDes || '—'}</td>
                            <td className="py-2 px-2 text-right">
                              {r.unitPrice != null ? `$${r.unitPrice.toFixed(2)}` : '—'}
                            </td>
                            <td className="py-2 px-2 text-right">{r.qty}</td>
                            <td className="py-2 px-2 text-right">{r.refPercent}%</td>
                            <td className="py-2 px-2 text-right font-medium">
                              {r.amount != null ? `$${r.amount.toFixed(2)}` : '—'}
                            </td>
                            <td className="py-2 px-2 text-center space-x-1">
                              {r.lockedByRunId ? (
                                <Badge variant="secondary" className="text-xs">已鎖定</Badge>
                              ) : (
                                <button
                                  onClick={() => handleReset(r.id)}
                                  className="text-xs text-amber-600 underline hover:text-amber-800 flex items-center gap-1"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  取消確認
                                </button>
                              )}
                              {!r.lockedByRunId && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleDelete(r.id)}
                                >
                                  <Trash2 className="w-3.5 h-3.5 text-red-500" />
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* Reset all for group */}
                  {!isSingle && isExpanded && (
                    <div className="px-3 py-2 border-t border-gray-100 flex justify-between items-center">
                      <span className="text-xs text-gray-500">
                        合共 {items.length} 項 · ${groupTotal.toFixed(2)}
                        {items.some(r => r.lockedByRunId) && (
                          <span className="text-amber-600 ml-2">
                            （{items.filter(r => r.lockedByRunId).length} 項已鎖定）
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => resetBillGroup(billCode, items)}
                        className="text-xs text-amber-600 underline hover:text-amber-800 flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" />
                        全部取消確認
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ═══════════════════════════════════════════════════════
          SECTION 3: Bill lookup + batch referral (入新轉介嘅表单)
          ═══════════════════════════════════════════════════════ */}
      <Card className="p-4" id="bill-referral-section">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Search className="w-4 h-4" /> 帳單轉介
        </h2>

        {/* W1: Status bar when completing a draft */}
        {completingDraft && (
          <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-3 flex justify-between items-center">
            <div className="text-sm">
              <span className="font-medium text-blue-800">補上帳單中</span>
              <span className="ml-2 text-gray-700">
                {completingDraft.fromProviderName ?? completingDraft.fromProviderId}
                {completingDraft.patientNote && ` · ${completingDraft.patientNote}`}
              </span>
            </div>
            <button
              onClick={() => {
                setCompletingDraft(null)
                setFromProviderId('')
                setBillData(null)
                setSelectedItems([])
                setSearchCode('')
              }}
              className="text-sm text-blue-600 underline"
            >
              取消
            </button>
          </div>
        )}

        <div className="flex flex-col gap-3 mb-4">
          {/* W1: fromProviderId select - disabled when completing draft */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-sm text-gray-600 mb-1">轉介醫生</label>
              <select
                className="w-full border rounded px-3 py-2"
                value={fromProviderId}
                disabled={!!completingDraft}
                onChange={e => setFromProviderId(e.target.value)}
              >
                <option value="">選擇醫生</option>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Y4: Search mode toggle */}
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="searchMode"
                checked={searchMode === 'billCode'}
                onChange={() => setSearchMode('billCode')}
              />
              直接打帳單編號
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="searchMode"
                checked={searchMode === 'patient'}
                onChange={() => setSearchMode('patient')}
              />
              用病人編號揾
            </label>
          </div>

          {/* Y4: Patient search flow */}
          {searchMode === 'patient' ? (
            <div className="space-y-3">
              {/* Step 1: Patient search input */}
              <div className="flex gap-2">
                <Input
                  value={patientSearch}
                  onChange={e => { setPatientSearch(e.target.value); setPatientSearchError(null); setPatientResults(null); setSelectedPatient(null); setBillSearchResults(null) }}
                  placeholder="輸入病人編號（最少 6 字元）"
                  onKeyDown={e => e.key === 'Enter' && searchPatients()}
                />
                <Button onClick={searchPatients} disabled={patientSearching}>
                  {patientSearching ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Search className="w-4 h-4 mr-1" />}
                  搜尋
                </Button>
              </div>

              {/* Patient search error */}
              {patientSearchError && (
                <div className="flex items-center gap-2 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4" />
                  {patientSearchError}
                </div>
              )}

              {/* Step 1: Patient results */}
              {patientResults !== null && patientResults.length > 0 && !selectedPatient && (
                <div className="border rounded overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left bg-gray-50 border-b">
                        <th className="py-2 px-3">病人編號</th>
                        <th className="py-2 px-3">姓名</th>
                        <th className="py-2 px-3">性別</th>
                        <th className="py-2 px-3">出生日期</th>
                      </tr>
                    </thead>
                    <tbody>
                      {patientResults.map((p: any) => (
                        <tr
                          key={p.id}
                          className="border-b last:border-0 hover:bg-blue-50 cursor-pointer"
                          onClick={() => selectPatient(p)}
                        >
                          <td className="py-2 px-3 font-mono text-xs">{p.externalId || p.id}</td>
                          <td className="py-2 px-3">{p.fullName || '—'}</td>
                          <td className="py-2 px-3">{p.gender || '—'}</td>
                          <td className="py-2 px-3">{p.birthDate || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Step 2: Bill results (after selecting patient) */}
              {selectedPatient && (
                <div className="space-y-2">
                  <div className="text-sm text-gray-600 flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    已選：{selectedPatient.fullName || selectedPatient.externalId || selectedPatient.id}
                    <button onClick={() => { setSelectedPatient(null); setBillSearchResults(null) }} className="text-blue-600 underline text-xs ml-2">重新選擇</button>
                  </div>

                  {billSearching && (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <Loader2 className="w-4 h-4 animate-spin" /> 載入帳單中...
                    </div>
                  )}

                  {billSearchError && (
                    <div className="flex items-center gap-2 text-sm text-red-600">
                      <AlertCircle className="w-4 h-4" />
                      {billSearchError}
                    </div>
                  )}

                  {billSearchResults !== null && billSearchResults.length > 0 && (
                    <div className="border rounded overflow-hidden max-h-64 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0">
                          <tr className="text-left bg-gray-50 border-b">
                            <th className="py-2 px-3">帳單編號</th>
                            <th className="py-2 px-3">日期</th>
                            <th className="py-2 px-3 text-right">金額</th>
                            <th className="py-2 px-3">狀態</th>
                          </tr>
                        </thead>
                        <tbody>
                          {billSearchResults.map((b: any) => (
                            <tr
                              key={b.id}
                              className={`border-b last:border-0 hover:bg-blue-50 cursor-pointer ${b.isVoid ? 'opacity-50' : ''}`}
                              onClick={() => !b.isVoid && selectBillFromPatient(b)}
                            >
                              <td className="py-2 px-3 font-mono text-xs">{b.code || b.id}</td>
                              <td className="py-2 px-3">{b.billTime ? new Date(b.billTime).toLocaleDateString('zh-HK') : '—'}</td>
                              <td className="py-2 px-3 text-right">${(b.amt ?? 0).toFixed(2)}</td>
                              <td className="py-2 px-3">
                                {b.isVoid && <Badge variant="secondary" className="text-xs">已取消</Badge>}
                                {b.referralCount > 0 && <span className="text-amber-600 text-xs">⚠️ 已有 {b.referralCount} 筆轉介</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {billSearchResults !== null && billSearchResults.length === 0 && (
                    <div className="text-sm text-gray-500 text-center py-4">該病人近 12 個月冇帳單</div>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* Bill code search (original) */
            <div className="flex gap-2">
              <Input
                value={searchCode}
                onChange={e => setSearchCode(e.target.value)}
                placeholder="輸入帳單編號（如 202607050007）"
                onKeyDown={e => e.key === 'Enter' && lookupBill()}
              />
              <Button onClick={lookupBill}>
                <Search className="w-4 h-4 mr-1" /> 搜尋
              </Button>
            </div>
          )}
        </div>

        {billData && (
          <div className="space-y-4">
            {/* Bill info */}
            <div className="flex flex-wrap gap-4 text-sm bg-gray-50 p-3 rounded">
              <span><strong>帳單:</strong> {billData.billCode}</span>
              <span><strong>醫生:</strong> {billData.providerName || '—'}</span>
              <span><strong>診所:</strong> {billData.clinicName || '—'}</span>
              <span><strong>日期:</strong> {new Date(billData.billTime).toLocaleDateString('zh-HK')}</span>
            </div>

            {/* Items table with checkboxes */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b bg-gray-50">
                    <th className="py-2 px-2 w-8">
                      {(() => {
                        const selectableItems = billData.items.filter(
                          (i: any) => Number(i.unitPrice) >= 0 && !i.alreadyReferred
                        )
                        return (
                          <input
                            type="checkbox"
                            checked={selectableItems.length > 0 && selectedItems.length === selectableItems.length}
                            onChange={e => {
                              if (e.target.checked) {
                                setSelectedItems(selectableItems.map((i: any) => i.eleId))
                              } else {
                                setSelectedItems([])
                              }
                            }}
                          />
                        )
                      })()}
                    </th>
                    <th className="py-2 px-2">項目</th>
                    <th className="py-2 px-2 text-right">單價</th>
                    <th className="py-2 px-2 text-right">數量</th>
                    <th className="py-2 px-2 text-right">小計</th>
                    <th className="py-2 px-2 text-center">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {billData.items.map((item: any) => (
                    <tr
                      key={item.eleId}
                      className={`border-b hover:bg-gray-50 ${item.alreadyReferred ? 'opacity-50' : ''}`}
                    >
                      <td className="py-2 px-2">
                        <input
                          type="checkbox"
                          checked={selectedItems.includes(item.eleId)}
                          onChange={() => toggleItem(item.eleId)}
                          disabled={item.alreadyReferred || Number(item.unitPrice) < 0}
                        />
                        {Number(item.unitPrice) < 0 && (
                          <span className="ml-2 text-xs text-gray-400">（負數項目，唔可以轉介）</span>
                        )}
                      </td>
                      <td className="py-2 px-2">{item.feeItemDes}</td>
                      <td className="py-2 px-2 text-right">${item.unitPrice.toFixed(2)}</td>
                      <td className="py-2 px-2 text-right">{item.qty}</td>
                      <td className="py-2 px-2 text-right font-medium">${item.amt.toFixed(2)}</td>
                      <td className="py-2 px-2 text-center">
                        {item.alreadyReferred && (
                          <Badge variant="secondary" className="text-xs">已轉介</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Summary + submit */}
            {selectedItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-4 p-3 bg-blue-50 rounded">
                <div className="text-sm">
                  <span className="font-medium">已選 {selectedItems.length} 項</span>
                  <span className="text-gray-600 ml-2">
                    合計: <strong>${selectedTotal.toFixed(2)}</strong>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm">轉介%:</label>
                  <Input
                    type="number"
                    step="0.1"
                    value={refPercent}
                    onChange={e => setRefPercent(e.target.value)}
                    className="w-20"
                  />
                </div>
                <div className="text-sm">
                  轉介金額: <strong className="text-blue-700">${totalRef.toFixed(2)}</strong>
                </div>
                <div className="flex-1" />
                <Button onClick={handleSubmit} disabled={batchLoading}>
                  <Plus className="w-4 h-4 mr-1" />
                  {batchLoading ? '提交中...' : completingDraft ? '確認補上帳單' : `批次轉介 (${selectedItems.length} 項)`}
                </Button>
              </div>
            )}
          </div>
        )}

        {!billData && (
          <div className="text-center py-8 text-gray-400">
            <ClipboardList className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">輸入帳單編號搜尋項目</p>
          </div>
        )}
      </Card>
    </div>
  )
}
