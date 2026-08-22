'use client'

import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import { Card } from '@/components/ui/card'
import { Loader2, AlertTriangle, Edit3, Power, Trash2 } from 'lucide-react'

export default function LabDiscountsPage() {
  const [labs, setLabs] = useState<any[]>([])
  const [discounts, setDiscounts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [userRole, setUserRole] = useState('')
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])

  // Edit modal
  const [editOpen, setEditOpen] = useState(false)
  const [editLabId, setEditLabId] = useState('')
  const [editMonth, setEditMonth] = useState('')
  const [editDiscount, setEditDiscount] = useState('')
  const [editNote, setEditNote] = useState('')
  const [saving, setSaving] = useState(false)

  const canEdit = userRole ? hasPermission(userRole, 'provider_payout', grant, deny) : false

  const loadLabs = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/labs')
      setLabs(data.labs || [])
    } catch (e) {
      console.error('[lab-discounts] load labs failed', e)
      setLoadError('Lab 名單載入失敗')
    }
  }, [])

  const loadDiscounts = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/lab-discounts')
      setDiscounts(data.discounts || [])
    } catch (e) {
      console.error('[lab-discounts] load discounts failed', e)
      setLoadError('折扣資料載入失敗')
    }
  }, [])

  const loadAuth = useCallback(async () => {
    try {
      const data: any = await apiFetch('/api/me')
      setUserRole(data.user?.role || '')
      // ★ 2026-08-22：/api/me 已經 parse 好，直接回 user.grant / user.deny
      //   （permissionsJson 喺 route.ts:24 被剷走，讀佢永遠 undefined）
      setGrant(data.user?.grant ?? [])
      setDeny(data.user?.deny ?? [])
    } catch (e) {
      console.error('[lab-discounts] load auth failed', e)
      setLoadError('權限載入失敗')
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadAuth(), loadLabs(), loadDiscounts()]).finally(() => setLoading(false))
  }, [loadAuth, loadLabs, loadDiscounts])

  // Build a map: labId -> periodMonth -> discount
  const discountMap = new Map<string, Map<string, number>>()
  for (const d of discounts) {
    if (!discountMap.has(d.labId)) discountMap.set(d.labId, new Map())
    discountMap.get(d.labId)!.set(d.periodMonth, Number(d.discountPct))
  }

  // Get last 3 months for display
  const months = (() => {
    const now = new Date()
    const result: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      result.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    }
    return result
  })()

  const openRename = async (labId: string, currentName: string) => {
    const newName = prompt('改名：', currentName)
    if (newName && newName.trim() && newName.trim() !== currentName) {
      try {
        await apiFetch(`/api/labs?id=${labId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName.trim() }),
        })
        alert('改名成功')
        loadLabs()
      } catch (e: any) {
        alert(`改名失敗: ${e.message}`)
      }
    }
  }

  const toggleActive = async (labId: string, currentActive: boolean) => {
    const action = currentActive ? '停用' : '啟用'
    if (!confirm(`確定要${action}呢個工場？`)) return
    try {
      await apiFetch(`/api/labs?id=${labId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !currentActive }),
      })
      alert(`${action}成功`)
      loadLabs()
    } catch (e: any) {
      alert(`${action}失敗: ${e.message}`)
    }
  }

  const handleDeleteLab = async (labId: string, labName: string) => {
    if (!confirm(`確定要刪除工場「${labName}」？此操作不可逆。`)) return
    try {
      await apiFetch(`/api/labs?id=${labId}`, { method: 'DELETE' })
      alert('刪除成功')
      loadLabs()
    } catch (e: any) {
      alert(`刪除失敗: ${e.message}`)
    }
  }

  const openEdit = (labId: string, month: string) => {
    setEditLabId(labId)
    setEditMonth(month)
    const existing = discountMap.get(labId)?.get(month)
    setEditDiscount(existing != null ? String(existing) : '')
    setEditNote('')
    setEditOpen(true)
  }

  const handleSave = async () => {
    if (!editDiscount || Number(editDiscount) < 0 || Number(editDiscount) > 100) {
      alert('折扣百分比必須為 0-100')
      return
    }
    setSaving(true)
    try {
      const res = await apiFetch('/api/lab-discounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          labId: editLabId,
          periodMonth: editMonth,
          discountPct: Number(editDiscount),
          note: editNote || null,
        }),
      })

      setEditOpen(false)

      // AB4: Ask user if they want to recompute unlocked cost cases
      try {
        const affected = await apiFetch<any>(`/api/cost-cases?labId=${editLabId}&periodMonth=${editMonth}&unlocked=1`)
        const n = affected?.cases?.length ?? 0
        if (n > 0 && confirm(`已儲存。該月有 ${n} 筆未鎖定成本記錄，要用新折扣重算？`)) {
          const r = await apiFetch<any>('/api/cost-cases/recompute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labId: editLabId, periodMonth: editMonth }),
          })
          alert(`重算咗 ${r.recomputedCount} 筆，總成本差異 ±$${r.totalDiff}`)
        }
      } catch (recomputeErr: any) {
        console.warn('[lab-discounts] recompute check failed', recomputeErr)
        // Don't block — just a nice-to-have
      }

      loadDiscounts()
    } catch (e: any) {
      alert(`儲存失敗: ${e.message}`)
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
        <h1 className="text-2xl font-bold">Lab 折扣設定</h1>
        <a href="/cost-entry" className="text-sm text-blue-600 hover:underline">← 返回成本錄入</a>
      </div>

      <Card className="p-3 bg-blue-50 text-blue-700 text-sm">
        💡 取消折扣要設 0%，唔好刪記錄。
      </Card>

      {!canEdit && (
        <Card className="p-3 bg-yellow-50 text-yellow-700 text-sm">
          ⚠️ 設定折扣需要 OWNER 權限
        </Card>
      )}

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left p-2">Lab</th>
              {months.map(m => <th key={m} className="text-center p-2">{m}</th>)}
              <th className="p-1"></th>
            </tr>
          </thead>
          <tbody>
            {labs.map(lab => (
              <tr key={lab.id} className="border-b hover:bg-gray-50">
                <td className="p-2 font-medium">
                  <span className={lab.isActive == false ? 'line-through text-gray-400' : ''}>{lab.name}</span>
                </td>
                {months.map(month => {
                  const val = discountMap.get(lab.id)?.get(month)
                  return (
                    <td key={month} className="text-center p-2">
                      {val != null ? (
                        <span className="font-mono">{val}%</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  )
                })}
                <td className="p-2 text-right">
                  {canEdit && (
                    <div className="flex items-center gap-3 justify-end">
                      <button onClick={() => openRename(lab.id, lab.name)} className="text-blue-600 text-xs hover:underline" title="改名">
                        <Edit3 size={12} />
                      </button>
                      <button onClick={() => toggleActive(lab.id, lab.isActive ?? true)} className="text-amber-600 text-xs hover:underline" title={lab.isActive == false ? '啟用' : '停用'}>
                        <Power size={12} />
                      </button>
                      <button onClick={() => handleDeleteLab(lab.id, lab.name)} className="text-red-500 text-xs hover:underline" title="刪除">
                        <Trash2 size={12} />
                      </button>
                      <button
                        onClick={() => openEdit(lab.id, months[0])}
                        className="text-blue-600 text-xs hover:underline"
                      >
                        編輯
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Edit Modal */}
      {editOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">設定 {editMonth} 折扣</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">Lab</label>
                <select value={editLabId} onChange={e => setEditLabId(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm">
                  {labs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">月份</label>
                <select value={editMonth} onChange={e => setEditMonth(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm">
                  {months.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">折扣 %</label>
                <input type="number" step="0.1" min="0" max="100" value={editDiscount}
                  onChange={e => setEditDiscount(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="e.g. 8.5" />
              </div>
              <div>
                <label className="block text-sm mb-1">備註</label>
                <input value={editNote} onChange={e => setEditNote(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="可選" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEditOpen(false)} className="px-4 py-1.5 border rounded text-sm">取消</button>
              <button onClick={handleSave} disabled={saving}
                className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                {saving && <Loader2 size={14} className="animate-spin" />} 儲存
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
