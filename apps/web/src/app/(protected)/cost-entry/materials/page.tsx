'use client'

import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import { Card } from '@/components/ui/card'
import { Plus, Loader2 } from 'lucide-react'

export default function MaterialsPage() {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])

  // Create modal
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ name: '', unitPrice: '', effectiveFrom: new Date().toISOString().slice(0, 10) })
  const [saving, setSaving] = useState(false)

  const canCreate = userRole ? hasPermission(userRole, 'provider_payout', grant, deny) : false

  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      const data: any = await apiFetch('/api/material-items')
      setItems(data.items || [])
    } catch (e) {
      console.error('[materials] load materials failed', e)
      setLoadError('材料清單載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadAuth = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/me')
      setUserRole(data.user?.role || '')
      const perms = data.user?.permissionsJson
      if (perms) {
        const parsed = typeof perms === 'string' ? JSON.parse(perms) : perms
        setGrant(parsed.grant || [])
        setDeny(parsed.deny || [])
      }
    } catch (e) {
      console.error('[materials] load auth failed', e)
      setLoadError('權限載入失敗')
    }
  }, [])

  useEffect(() => {
    loadAuth()
    loadItems()
  }, [loadAuth, loadItems])

  const handleSubmit = async () => {
    if (!form.name || !form.unitPrice || !form.effectiveFrom) {
      alert('名稱、單價、生效日為必填')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/api/material-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          unitPrice: Number(form.unitPrice),
          effectiveFrom: form.effectiveFrom,
        }),
      })

      setModalOpen(false)
      setForm({ name: '', unitPrice: '', effectiveFrom: new Date().toISOString().slice(0, 10) })
      loadItems()
    } catch (e: any) {
      alert(`新增失敗: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={24} /></div>
  }

  return (
    <div className="p-6 space-y-4">
      {loadError && (
        <div className="text-red-500 text-sm p-2 bg-red-50 rounded">{loadError}</div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">材料主檔</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">★ 只准新增唔准改舊記錄</span>
          <a href="/cost-entry" className="text-sm text-blue-600 hover:underline">← 返回成本錄入</a>
        </div>
      </div>

      {!canCreate && (
        <Card className="p-3 bg-yellow-50 text-yellow-700 text-sm">
          ⚠️ 新增材料需要 OWNER 權限
        </Card>
      )}

      <div className="flex justify-end">
        {canCreate && (
          <button onClick={() => setModalOpen(true)}
            className="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 flex items-center gap-1">
            <Plus size={14} /> 新增材料
          </button>
        )}
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-2">名稱</th>
              <th className="text-right p-2">單價</th>
              <th className="text-left p-2">生效日</th>
              <th className="text-left p-2">到期日</th>
              <th className="text-left p-2">狀態</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className="border-b hover:bg-gray-50">
                <td className="p-2 font-medium">{item.name}</td>
                <td className="p-2 text-right font-mono">${Number(item.unitPrice).toFixed(2)}</td>
                <td className="p-2">{new Date(item.effectiveFrom).toLocaleDateString('zh-HK')}</td>
                <td className="p-2">{item.effectiveTo ? new Date(item.effectiveTo).toLocaleDateString('zh-HK') : '—'}</td>
                <td className="p-2">
                  <span className={`text-xs px-2 py-0.5 rounded ${item.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {item.isActive ? '有效' : '已停用'}
                  </span>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-gray-400">暫無材料記錄</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Create Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">新增材料項目</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">名稱 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="材料名稱" />
              </div>
              <div>
                <label className="block text-sm mb-1">單價 *</label>
                <input type="number" step="0.01" value={form.unitPrice} onChange={e => setForm({ ...form, unitPrice: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="單價" />
              </div>
              <div>
                <label className="block text-sm mb-1">生效日 *</label>
                <input type="date" value={form.effectiveFrom} onChange={e => setForm({ ...form, effectiveFrom: e.target.value })}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setModalOpen(false)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={handleSubmit} disabled={saving}
                className="px-4 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50 flex items-center gap-1">
                {saving && <Loader2 size={14} className="animate-spin" />} 確定
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
