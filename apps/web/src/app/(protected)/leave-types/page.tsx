'use client'

import { useEffect, useState, useCallback } from 'react'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

interface LeaveTypeItem {
  id: string
  name: string
  isPaid: boolean
  annualQuota: number | null
  color: string | null
  isActive: boolean
  createdAt: string
}

export default function LeaveTypesPage() {
  const [userRole, setUserRole] = useState<Role | null>(null)
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', isPaid: true, annualQuota: '', color: '#4CAF50' })
  const [editingId, setEditingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const meRes = await fetch('/api/me', { credentials: 'include' })
      const meData = await meRes.json()
      setUserRole(meData.user.role as Role)

      const res = await fetch('/api/leave-types', { credentials: 'include' })
      const data = await res.json()
      setLeaveTypes(data.leaveTypes || [])
    } catch (err) {
      console.error('Failed to fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const method = editingId ? 'PUT' : 'POST'
      const url = editingId ? `/api/leave-types/${editingId}` : '/api/leave-types'
      const body: any = {
        name: form.name,
        isPaid: form.isPaid,
        color: form.color,
      }
      if (form.annualQuota) body.annualQuota = parseFloat(form.annualQuota)
      else body.annualQuota = null

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })

      if (res.ok) {
        setForm({ name: '', isPaid: true, annualQuota: '', color: '#4CAF50' })
        setShowForm(false)
        setEditingId(null)
        fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '操作失敗')
      }
    } catch (err) {
      console.error('Submit error:', err)
    }
  }

  const handleEdit = (type: LeaveTypeItem) => {
    setForm({
      name: type.name,
      isPaid: type.isPaid,
      annualQuota: type.annualQuota?.toString() || '',
      color: type.color || '#4CAF50',
    })
    setEditingId(type.id)
    setShowForm(true)
  }

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/leave-types/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive: !isActive }),
      })
      if (res.ok) fetchData()
    } catch (err) {
      console.error('Toggle error:', err)
    }
  }

  if (loading) return <div className="main-content" style={{ padding: 24 }}>載入中...</div>
  if (userRole !== 'OWNER') return <div className="main-content" style={{ padding: 24 }}>⛔ 僅 OWNER 可訪問</div>

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', margin: 0 }}>🏷️ 假期類型管理</h1>
        <button className="btn btn-primary" onClick={() => { setShowForm(true); setEditingId(null); }}>
          + 新增類型
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2>{editingId ? '編輯假期類型' : '新增假期類型'}</h2>
          <form onSubmit={handleSubmit}>
            <div className="grid-3" style={{ marginBottom: 0 }}>
              <div className="form-group">
                <label>名稱</label>
                <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="如：年假" />
              </div>
              <div className="form-group">
                <label>年度額度（天，可選）</label>
                <input type="number" step="0.5" value={form.annualQuota} onChange={e => setForm({ ...form, annualQuota: e.target.value })} placeholder="留空=無限制" />
              </div>
              <div className="form-group">
                <label>顏色標記</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} style={{ width: 40, height: 32, border: 'none', cursor: 'pointer' }} />
                  <span style={{ fontSize: 13, color: '#888' }}>{form.color}</span>
                </div>
              </div>
              <div className="form-group">
                <label>有薪</label>
                <select value={form.isPaid ? '1' : '0'} onChange={e => setForm({ ...form, isPaid: e.target.value === '1' })}>
                  <option value="1">是</option>
                  <option value="0">否</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" style={{ background: '#eee', color: '#333' }} onClick={() => { setShowForm(false); setEditingId(null); }}>
                取消
              </button>
              <button type="submit" className="btn btn-primary">{editingId ? '保存' : '新增'}</button>
            </div>
          </form>
        </div>
      )}

      {/* Table */}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>顏色</th>
              <th>名稱</th>
              <th>有薪</th>
              <th>年度額度</th>
              <th>狀態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {leaveTypes.map(t => (
              <tr key={t.id}>
                <td>
                  <div style={{ width: 20, height: 20, borderRadius: 4, background: t.color || '#ccc' }} />
                </td>
                <td style={{ fontWeight: 500 }}>{t.name}</td>
                <td>{t.isPaid ? '✅ 有薪' : '❌ 無薪'}</td>
                <td>{t.annualQuota ? `${t.annualQuota} 天` : '無限制'}</td>
                <td>
                  <label style={{ fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={t.isActive}
                      onChange={() => handleToggleActive(t.id, t.isActive)}
                    />
                    {' '}
                    {t.isActive ? '啟用' : '停用'}
                  </label>
                </td>
                <td>
                  <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => handleEdit(t)}>
                    編輯
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
