'use client'

import { useEffect, useState, useCallback } from 'react'
import { hasPermission } from '@/lib/permissions'
import { todayHK } from '@/lib/hk-date'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, RefreshCw, Loader2, AlertTriangle } from 'lucide-react'

interface CostCase {
  id: string
  providerId: string
  clinicId: string
  category: string
  patientCode: string
  patientName: string | null
  orderedAt: string
  itemType: string | null
  labId: string | null
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

export default function CostEntryPage() {
  const [cases, setCases] = useState<CostCase[]>([])
  const [loading, setLoading] = useState(true)
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<any[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Filters
  const [filterProviderId, setFilterProviderId] = useState('')
  const [filterPeriodMonth, setFilterPeriodMonth] = useState(() => {
    const d = todayHK()
    return d.slice(0, 7) // YYYY-MM
  })
  const [filterCategory, setFilterCategory] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterClinicId, setFilterClinicId] = useState('')

  // Auth
  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const [userId, setUserId] = useState('')

  // Modal
  const [modalOpen, setModalOpen] = useState(false)
  const [modalCategory, setModalCategory] = useState<'LAB' | 'INVISALIGN'>('LAB')
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    providerId: '', clinicId: '', category: 'LAB' as string,
    patientCode: '', patientName: '', orderedAt: '',
    itemType: '', labId: '', labOrderNo: '', dsaName: '',
    baseCost: '', discountPct: '', receivedAt: '', appointmentAt: '',
  })

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const canCreate = userRole ? hasPermission(userRole, 'cost_entry', grant, deny) : false

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/providers', { credentials: 'include' })
      if (res.ok) {
        const data: any = await res.json()
        setProviders(data.providers || [])
      }
    } catch (e) {
      console.error('[cost-entry] load providers failed', e)
      setLoadError('載入醫生列表失敗')
    }
  }, [])

  const loadClinics = useCallback(async () => {
    try {
      const res = await fetch('/api/clinics', { credentials: 'include' })
      if (res.ok) {
        const data: any = await res.json()
        setClinics(data.clinics || [])
      }
    } catch (e) {
      console.error('[cost-entry] load clinics failed', e)
      setLoadError('載入診所列表失敗')
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

      const res = await fetch(`/api/cost-cases?${params}`, { credentials: 'include' })
      if (res.ok) {
        const data: any = await res.json()
        setCases(data.cases || [])
        setSummary(data.summary || null)
      }
    } catch (e) {
      console.error('Failed to load cases:', e)
    } finally {
      setLoading(false)
    }
  }, [filterProviderId, filterPeriodMonth, filterCategory, filterStatus, filterClinicId])

  const loadAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (res.ok) {
        const data: any = await res.json()
        setUserRole(data.user?.role || '')
        setUserId(data.user?.id || '')
        const perms = data.user?.permissionsJson
        if (perms) {
          const parsed = typeof perms === 'string' ? JSON.parse(perms) : perms
          setGrant(parsed.grant || [])
          setDeny(parsed.deny || [])
        }
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
  }, [loadAuth, loadProviders, loadClinics])

  useEffect(() => {
    loadCases()
  }, [loadCases])

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
        discountPct: form.discountPct ? Number(form.discountPct) : null,
        receivedAt: form.receivedAt || null,
        appointmentAt: form.appointmentAt || null,
      }

      const res = await fetch('/api/cost-cases', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        setModalOpen(false)
        loadCases()
      } else {
        const err: any = await res.json()
        alert(`建立失敗: ${err.error}`)
      }
    } catch (e) {
      alert(`建立失敗: ${e}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('確定要作廢呢筆記錄？')) return
    try {
      const res = await fetch(`/api/cost-cases/${id}`, { credentials: 'include', method: 'DELETE' })
      if (res.ok) {
        loadCases()
      } else {
        const err: any = await res.json()
        alert(`作廢失敗: ${err.error}`)
      }
    } catch (e) {
      alert(`作廢失敗: ${e}`)
    }
  }

  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('zh-HK') : '—'

  return (
    <div className="p-6 space-y-4">
      {/* B4: Load error alert */}
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
                onClick={() => openCreateModal('LAB')}
                className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 flex items-center gap-1"
              >
                <Plus size={14} /> 新增 LAB
              </button>
              <button
                onClick={() => openCreateModal('INVISALIGN')}
                className="px-3 py-1.5 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 flex items-center gap-1"
              >
                <Plus size={14} /> 新增 Invisalign
              </button>
              <a
                href="/cost-entry/implant"
                className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 flex items-center gap-1"
              >
                <Plus size={14} /> 新增 Implant
              </a>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-5 gap-3">
          <select
            value={filterProviderId}
            onChange={e => setFilterProviderId(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm"
          >
            <option value="">全部醫生</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.name || p.shortName}</option>
            ))}
          </select>
          <input
            type="month"
            value={filterPeriodMonth}
            onChange={e => setFilterPeriodMonth(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm"
          />
          <select
            value={filterClinicId}
            onChange={e => setFilterClinicId(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm"
          >
            <option value="">全部診所</option>
            {clinics.map(c => (
              <option key={c.id} value={c.id}>{c.shortName || c.name}</option>
            ))}
          </select>
          <select
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm"
          >
            <option value="">全部類別</option>
            {CATEGORIES.map(c => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm"
          >
            <option value="">全部狀態</option>
            {STATUSES.map(s => (
              <option key={s} value={s}>{STATUS_CONFIG[s]?.label}</option>
            ))}
          </select>
        </div>
      </Card>

      {/* Table */}
      <Card className="overflow-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="animate-spin" size={24} />
          </div>
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
                    <Badge variant={STATUS_CONFIG[c.status]?.color === 'green' ? 'default' : STATUS_CONFIG[c.status]?.color === 'yellow' ? 'secondary' : 'secondary'}>
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

      {/* Summary Bar */}
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

      {/* Create Modal */}
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
                <label className="block text-sm mb-1">折扣 %</label>
                <input type="number" step="0.1" value={form.discountPct} onChange={e => setForm({ ...form, discountPct: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="e.g. 8.5" />
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
