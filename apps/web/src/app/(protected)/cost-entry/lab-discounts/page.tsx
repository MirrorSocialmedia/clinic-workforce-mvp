'use client'

import { useEffect, useState, useCallback } from 'react'
import { hasPermission } from '@/lib/permissions'
import { Card } from '@/components/ui/card'
import { Loader2, AlertTriangle } from 'lucide-react'

export default function LabDiscountsPage() {
  const [labs, setLabs] = useState<any[]>([])
  const [discounts, setDiscounts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

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
  const [affectedCount, setAffectedCount] = useState(0)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const canEdit = userRole ? hasPermission(userRole, 'provider_payout', grant, deny) : false

  const loadLabs = useCallback(async () => {
    try {
      const res = await fetch('/api/labs', { credentials: 'include' })
      if (res.ok) {
        const data: any = await res.json()
        setLabs(data.labs || [])
      }
    } catch { /* ignore */ }
  }, [])

  const loadDiscounts = useCallback(async () => {
    try {
      const res = await fetch('/api/lab-discounts', { credentials: 'include' })
      if (res.ok) {
        const data: any = await res.json()
        setDiscounts(data.discounts || [])
      }
    } catch { /* ignore */ }
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
      const res = await fetch('/api/lab-discounts', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          labId: editLabId,
          periodMonth: editMonth,
          discountPct: Number(editDiscount),
          note: editNote || null,
        }),
      })

      if (res.ok) {
        const data: any = await res.json()
        setAffectedCount(data.affectedCount || 0)
        setEditOpen(false)
        setConfirmOpen(false)
        loadDiscounts()
      } else {
        const err: any = await res.json()
        alert(`儲存失敗: ${err.error}`)
      }
    } catch (e) {
      alert(`儲存失敗: ${e}`)
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
        <h1 className="text-2xl font-bold">Lab 折扣設定</h1>
        <a href="/cost-entry" className="text-sm text-blue-600 hover:underline">← 返回成本錄入</a>
      </div>

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
                <td className="p-2 font-medium">{lab.name}</td>
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
                    <button
                      onClick={() => openEdit(lab.id, months[0])}
                      className="text-blue-600 text-xs hover:underline"
                    >
                      編輯
                    </button>
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
