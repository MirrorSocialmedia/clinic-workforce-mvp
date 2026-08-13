'use client'

import { useEffect, useState, useCallback } from 'react'
import { hasPermission } from '@/lib/permissions'
import { Card } from '@/components/ui/card'
import { Plus, Loader2, Trash2 } from 'lucide-react'

interface MaterialLine {
  materialItemId: string
  qty: number
  unitPrice: number
  subtotal: number
}

export default function ImplantEntryPage() {
  const [providers, setProviders] = useState<any[]>([])
  const [clinics, setClinics] = useState<any[]>([])
  const [materials, setMaterials] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])

  // Form state
  const [form, setForm] = useState({
    providerId: '', clinicId: '', patientCode: '', patientName: '',
    orderedAt: new Date().toISOString().slice(0, 10),
    itemType: '', dsaName: '', receivedAt: '', appointmentAt: '',
  })
  const [materialLines, setMaterialLines] = useState<MaterialLine[]>([])
  const [saving, setSaving] = useState(false)

  const canCreate = userRole ? hasPermission(userRole, 'cost_entry', grant, deny) : false

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [providersRes, clinicsRes, materialsRes] = await Promise.all([
        fetch('/api/providers', { credentials: 'include' }),
        fetch('/api/clinics', { credentials: 'include' }),
        fetch('/api/material-items', { credentials: 'include' }),
      ])
      if (providersRes.ok) {
        const d: any = await providersRes.json()
        setProviders(d.providers || [])
      }
      if (clinicsRes.ok) {
        const d: any = await clinicsRes.json()
        setClinics(d.clinics || [])
      }
      if (materialsRes.ok) {
        const d: any = await materialsRes.json()
        setMaterials(d.items || [])
      }
    } catch (e) {
      console.error('Failed to load:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (res.ok) {
        const data: any = await res.json()
        setUserRole(data.user?.role || '')
        const perms = data.user?.permissionsJson
        if (perms) {
          const parsed = typeof perms === 'string' ? JSON.parse(perms) : perms
          setGrant(parsed.grant || [])
          setDeny(parsed.deny || [])
        }
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadAuth()
    loadAll()
  }, [loadAuth, loadAll])

  const addMaterialLine = () => {
    setMaterialLines([...materialLines, { materialItemId: '', qty: 1, unitPrice: 0, subtotal: 0 }])
  }

  const removeMaterialLine = (idx: number) => {
    setMaterialLines(materialLines.filter((_, i) => i !== idx))
  }

  const updateMaterialLine = (idx: number, field: keyof MaterialLine, value: any) => {
    const updated = [...materialLines]
    if (field === 'materialItemId') {
      const selected = materials.find(m => m.id === value)
      updated[idx] = {
        ...updated[idx],
        materialItemId: value,
        unitPrice: selected ? Number(selected.unitPrice) : 0,
        subtotal: 0,
      }
      // Recalculate subtotal
      updated[idx].subtotal = Number((updated[idx].unitPrice * updated[idx].qty).toFixed(2))
    } else if (field === 'qty') {
      updated[idx] = { ...updated[idx], qty: Number(value) || 1 }
      updated[idx].subtotal = Number((updated[idx].unitPrice * updated[idx].qty).toFixed(2))
    }
    setMaterialLines(updated)
  }

  const totalCost = materialLines.reduce((sum, l) => sum + l.subtotal, 0)

  const handleSubmit = async () => {
    if (!form.providerId || !form.clinicId || !form.patientCode || !form.orderedAt) {
      alert('醫生、診所、病人編號、落單日為必填')
      return
    }
    if (materialLines.length === 0 || materialLines.some(l => !l.materialItemId)) {
      alert('請至少添加一行有效材料')
      return
    }
    setSaving(true)
    try {
      const body = {
        providerId: form.providerId,
        clinicId: form.clinicId,
        patientCode: form.patientCode,
        patientName: form.patientName || null,
        orderedAt: form.orderedAt,
        itemType: form.itemType || null,
        dsaName: form.dsaName || null,
        receivedAt: form.receivedAt || null,
        appointmentAt: form.appointmentAt || null,
        materials: materialLines.map(l => ({ materialItemId: l.materialItemId, qty: l.qty })),
      }

      const res = await fetch('/api/cost-cases/implant', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        alert('建立成功！')
        // Reset form
        setForm({
          providerId: '', clinicId: '', patientCode: '', patientName: '',
          orderedAt: new Date().toISOString().slice(0, 10),
          itemType: '', dsaName: '', receivedAt: '', appointmentAt: '',
        })
        setMaterialLines([])
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

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={24} /></div>
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Implant 成本錄入</h1>
        <a href="/cost-entry" className="text-sm text-blue-600 hover:underline">← 返回成本錄入</a>
      </div>

      {!canCreate && (
        <Card className="p-3 bg-yellow-50 text-yellow-700 text-sm">
          ⚠️ 你冇權錄入成本，請聯絡 OWNER
        </Card>
      )}

      <Card className="p-4">
        <div className="grid grid-cols-3 gap-3 mb-4">
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
        </div>
        <div className="grid grid-cols-4 gap-3 mb-6">
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
              className="w-full border rounded px-2 py-1.5 text-sm" placeholder="e.g. Single Implant" />
          </div>
          <div>
            <label className="block text-sm mb-1">DSA</label>
            <input value={form.dsaName} onChange={e => setForm({ ...form, dsaName: e.target.value })}
              className="w-full border rounded px-2 py-1.5 text-sm" placeholder="DSA 名稱" />
          </div>
        </div>

        {/* Materials Section */}
        <div className="border-t pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">材料明細</h3>
            {canCreate && (
              <button onClick={addMaterialLine} disabled={!canCreate}
                className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700 flex items-center gap-1 disabled:opacity-50">
                <Plus size={14} /> 加一行
              </button>
            )}
          </div>

          {materialLines.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-4">點擊「加一行」添加材料</p>
          ) : (
            <div className="space-y-2">
              {materialLines.map((line, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={line.materialItemId}
                    onChange={e => updateMaterialLine(idx, 'materialItemId', e.target.value)}
                    className="flex-1 border rounded px-2 py-1.5 text-sm"
                  >
                    <option value="">選擇材料</option>
                    {materials.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name} — ${Number(m.unitPrice).toFixed(2)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="1"
                    value={line.qty}
                    onChange={e => updateMaterialLine(idx, 'qty', e.target.value)}
                    className="w-16 border rounded px-2 py-1.5 text-sm text-center"
                    placeholder="數量"
                  />
                  <span className="w-20 text-sm text-right">${line.unitPrice.toFixed(2)}</span>
                  <span className="w-20 text-sm text-right font-medium">${line.subtotal.toFixed(2)}</span>
                  {canCreate && (
                    <button onClick={() => removeMaterialLine(idx)} className="text-red-400 hover:text-red-600">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              <div className="flex justify-end pt-2 border-t">
                <span className="font-bold text-lg">合計 ${totalCost.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 mt-4">
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

        <div className="flex justify-end mt-4">
          <button onClick={handleSubmit} disabled={saving || !canCreate}
            className="px-6 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
            {saving && <Loader2 size={14} className="animate-spin" />} 提交
          </button>
        </div>
      </Card>
    </div>
  )
}
