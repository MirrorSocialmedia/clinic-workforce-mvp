'use client'

import { useEffect, useState, useCallback } from 'react'
import { toHKDateStr } from '@/lib/hk-date'
import { Plus } from 'lucide-react'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'
type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
type TabKey = 'requests' | 'balance' | 'types'

interface LeaveType {
  id: string
  name: string
  isPaid: boolean
  annualQuota: number | null
  color: string | null
  isActive: boolean | null
}

interface LeaveRequestItem {
  id: string
  employeeId: string
  leaveTypeId: string
  leaveType: { id: string; name: string; isPaid: boolean; color: string | null }
  startDate: string
  endDate: string
  days: number
  reason: string | null
  status: LeaveStatus
  approverId: string | null
  approvedAt: string | null
  createdAt: string
  employee?: {
    user: { id: string; name: string }
  }
}

interface LeaveBalanceItem {
  id: string
  employeeId: string
  leaveTypeId: string
  leaveType: { id: string; name: string; isPaid: boolean; annualQuota: number | null; color: string | null }
  year: number
  entitled: number
  used: number
  remaining: number
  employee?: {
    user: { id: string; name: string }
  }
}

const STATUS_LABELS: Record<LeaveStatus, string> = {
  PENDING: '待審批',
  APPROVED: '已批準',
  REJECTED: '已拒絕',
}

const STATUS_COLORS: Record<LeaveStatus, string> = {
  PENDING: '#FF9800',
  APPROVED: '#4CAF50',
  REJECTED: '#dc3545',
}

export default function LeavePage() {
  const [userRole, setUserRole] = useState<Role | null>(null)
  const [userId, setUserId] = useState<string>('')
  const [requests, setRequests] = useState<LeaveRequestItem[]>([])
  const [balances, setBalances] = useState<LeaveBalanceItem[]>([])
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<LeaveStatus | ''>('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', days: '', reason: '' })

  // Leave Types management state
  const [activeTab, setActiveTab] = useState<TabKey>('requests')
  const [ltShowForm, setLtShowForm] = useState(false)
  const [ltForm, setLtForm] = useState({ name: '', isPaid: true, annualQuota: '', color: '#4CAF50' })
  const [ltEditingId, setLtEditingId] = useState<string | null>(null)

  // Auto-calculate days when start/end dates change
  useEffect(() => {
    if (form.startDate && form.endDate) {
      const start = new Date(form.startDate)
      const end = new Date(form.endDate)
      const diffDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1
      if (diffDays > 0) {
        setForm(f => ({ ...f, days: String(diffDays) }))
      }
    }
  }, [form.startDate, form.endDate])

  const isManager = userRole === 'OWNER' || userRole === 'MANAGER'
  const isOwner = userRole === 'OWNER'

  const fetchData = useCallback(async () => {
    try {
      const meRes = await fetch('/api/me', { credentials: 'include' })
      const meData = await meRes.json()
      setUserRole(meData.user.role as Role)
      setUserId(meData.user.id)

      const params = new URLSearchParams()
      if (filter) params.set('status', filter)
      const reqRes = await fetch(`/api/leave-requests?${params}`, { credentials: 'include' })
      const reqData = await reqRes.json()
      setRequests(reqData.leaveRequests || [])

      const balRes = await fetch('/api/leave-balance', { credentials: 'include' })
      const balData = await balRes.json()
      setBalances(balData.leaveBalances || [])

      const typesRes = await fetch('/api/leave-types', { credentials: 'include' })
      const typesData = await typesRes.json()
      setLeaveTypes(typesData.leaveTypes || [])
    } catch (err) {
      console.error('Failed to fetch leave data:', err)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { fetchData() }, [fetchData])

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.leaveTypeId || !form.startDate || !form.endDate || !form.days) return

    try {
      const res = await fetch('/api/leave-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          leaveTypeId: form.leaveTypeId,
          startDate: form.startDate,
          endDate: form.endDate,
          days: parseFloat(form.days),
          reason: form.reason || undefined,
        }),
      })

      if (res.ok) {
        setForm({ leaveTypeId: '', startDate: '', endDate: '', days: '', reason: '' })
        setShowForm(false)
        fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '申請失敗')
      }
    } catch (err) {
      console.error('Leave request error:', err)
    }
  }

  const handleApproveReject = async (id: string, action: 'APPROVE' | 'REJECT') => {
    if (!isManager) return
    try {
      const res = await fetch(`/api/leave-requests/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action }),
      })

      if (res.ok) {
        fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '操作失敗')
      }
    } catch (err) {
      console.error('Approval error:', err)
    }
  }

  // Leave Types handlers
  const handleLtSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const method = ltEditingId ? 'PUT' : 'POST'
      const url = ltEditingId ? `/api/leave-types/${ltEditingId}` : '/api/leave-types'
      const body: any = { name: ltForm.name, isPaid: ltForm.isPaid, color: ltForm.color }
      if (ltForm.annualQuota) body.annualQuota = parseFloat(ltForm.annualQuota)
      else body.annualQuota = null

      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
      if (res.ok) {
        setLtForm({ name: '', isPaid: true, annualQuota: '', color: '#4CAF50' })
        setLtShowForm(false); setLtEditingId(null); fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '操作失敗')
      }
    } catch (err) { console.error('Submit error:', err) }
  }

  const handleLtEdit = (t: LeaveType) => {
    setLtForm({ name: t.name, isPaid: t.isPaid, annualQuota: t.annualQuota?.toString() || '', color: t.color || '#4CAF50' })
    setLtEditingId(t.id); setLtShowForm(true)
  }

  const handleLtToggleActive = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/leave-types/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ isActive: !isActive }),
      })
      if (res.ok) fetchData()
    } catch (err) { console.error('Toggle error:', err) }
  }

  if (loading) return <div className="main-content" style={{ padding: 24 }}>載入中...</div>

  const tabs = [
    { key: 'requests' as TabKey, label: '假期申請' },
    { key: 'balance' as TabKey, label: '假期餘額' },
    ...(isOwner ? [{ key: 'types' as TabKey, label: '假期類型設定' }] : []),
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', margin: 0 }}>假期管理</h1>
        {userRole !== 'EMPLOYEE' && activeTab === 'requests' && (
          <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? '取消' : '            <span className="flex items-center gap-1"><Plus size={16} /> 申請假期</span>'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '2px solid #eee', paddingBottom: 0 }}>
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '8px 16px', border: 'none', borderBottom: activeTab === tab.key ? '2px solid #1a1a2e' : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? '#1a1a2e' : '#888', transition: 'all 0.2s',
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Requests Tab */}
      {activeTab === 'requests' && (
        <>
          {/* Apply Form */}
          {showForm && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h2>申請假期</h2>
              <form onSubmit={handleApply}>
                <div className="grid-3" style={{ marginBottom: 0 }}>
                  <div className="form-group">
                    <label>假期類型</label>
                    <select value={form.leaveTypeId} onChange={e => setForm({ ...form, leaveTypeId: e.target.value })} required>
                      <option value="">請選擇</option>
                      {leaveTypes.map(t => (
                        <option key={t.id} value={t.id}>{t.name}{t.annualQuota ? ` (${t.annualQuota}天)` : ''}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>開始日期</label>
                    <input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} required />
                  </div>
                  <div className="form-group">
                    <label>結束日期</label>
                    <input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} required />
                  </div>
                  <div className="form-group">
                    <label>天數（自動計算）</label>
                    <input type="number" step="0.5" min="0.5" value={form.days} onChange={e => setForm({ ...form, days: e.target.value })}
                      readOnly style={{ background: '#f5f5f5', cursor: 'default' }} required />
                  </div>
                  <div className="form-group" style={{ gridColumn: 'span 2' }}>
                    <label>原因（可選）</label>
                    <input type="text" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="請填寫請假原因" />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn" style={{ background: '#eee', color: '#333' }} onClick={() => setShowForm(false)}>取消</button>
                  <button type="submit" className="btn btn-primary">提交申請</button>
                </div>
              </form>
            </div>
          )}

          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {(['', 'PENDING', 'APPROVED', 'REJECTED'] as const).map(s => (
              <button key={s || 'all'} className="btn"
                style={{ background: filter === s ? '#1a1a2e' : '#f0f0f0', color: filter === s ? 'white' : '#333', fontSize: 13, padding: '6px 12px' }}
                onClick={() => setFilter(s)}>
                {s === 'PENDING' ? '待審批' : s === 'APPROVED' ? '已批準' : s === 'REJECTED' ? '已拒絕' : '全部'}
              </button>
            ))}
          </div>

          {/* Leave Requests Table */}
          <div className="card">
            <h2>假期申請記錄 ({requests.length})</h2>
            {requests.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>尚無假期申請</div>
            ) : (
              <table>
                <thead>
                  <tr><th>員工</th><th>類型</th><th>日期</th><th>天數</th><th>原因</th><th>狀態</th>{isManager && <th>操作</th>}</tr>
                </thead>
                <tbody>
                  {requests.map(r => (
                    <tr key={r.id}>
                      <td>{r.employee?.user?.name || '-'}</td>
                      <td>
                        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12,
                          background: `${r.leaveType.color || '#1a1a2e'}20`, color: r.leaveType.color || '#1a1a2e' }}>
                          {r.leaveType.name}
                        </span>
                      </td>
                      <td>{toHKDateStr(new Date(r.startDate))} → {toHKDateStr(new Date(r.endDate))}</td>
                      <td>{r.days}</td>
                      <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.reason || '-'}</td>
                      <td>
                        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12,
                          background: `${STATUS_COLORS[r.status]}20`, color: STATUS_COLORS[r.status] }}>
                          {STATUS_LABELS[r.status]}
                        </span>
                      </td>
                      {isManager && r.status === 'PENDING' && (
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn btn-sm" style={{ background: '#4CAF50', color: 'white' }}
                              onClick={() => handleApproveReject(r.id, 'APPROVE')}>✓</button>
                            <button className="btn btn-sm" style={{ background: '#dc3545', color: 'white' }}
                              onClick={() => handleApproveReject(r.id, 'REJECT')}>✗</button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Balance Tab */}
      {activeTab === 'balance' && (
        <>
          {balances.length > 0 ? (
            <div className="card">
              <h2>假期餘額</h2>
              <div className="grid-4" style={{ marginBottom: 0 }}>
                {balances.map(b => (
                  <div key={b.id} style={{
                    padding: 16, borderRadius: 8,
                    background: `${b.leaveType.color || '#1a1a2e'}10`,
                    borderLeft: `4px solid ${b.leaveType.color || '#1a1a2e'}`,
                  }}>
                    <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>{b.leaveType.name} ({b.year})</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{b.remaining.toFixed(1)}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>
                      剩餘 / 已用 {b.used.toFixed(1)} / 共 {b.entitled.toFixed(1)} 天
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', padding: 40, color: '#888' }}>尚無假期餘額記錄</div>
          )}
        </>
      )}

      {/* Leave Types Tab (OWNER only) */}
      {activeTab === 'types' && isOwner && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: '#1a1a2e', margin: 0 }}>假期類型管理</h2>
            <button className="btn btn-primary" onClick={() => { setLtShowForm(true); setLtEditingId(null); }}>
              <span className="flex items-center gap-1"><Plus size={16} /> 新增類型</span>
            </button>
          </div>

          {/* Leave Types Form */}
          {ltShowForm && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h2>{ltEditingId ? '編輯假期類型' : '新增假期類型'}</h2>
              <form onSubmit={handleLtSubmit}>
                <div className="grid-3" style={{ marginBottom: 0 }}>
                  <div className="form-group">
                    <label>名稱</label>
                    <input type="text" value={ltForm.name} onChange={e => setLtForm({ ...ltForm, name: e.target.value })} required placeholder="如：年假" />
                  </div>
                  <div className="form-group">
                    <label>年度額度（天，可選）</label>
                    <input type="number" step="0.5" value={ltForm.annualQuota} onChange={e => setLtForm({ ...ltForm, annualQuota: e.target.value })} placeholder="留空=無限制" />
                  </div>
                  <div className="form-group">
                    <label>顏色標記</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="color" value={ltForm.color} onChange={e => setLtForm({ ...ltForm, color: e.target.value })}
                        style={{ width: 40, height: 32, border: 'none', cursor: 'pointer' }} />
                      <span style={{ fontSize: 13, color: '#888' }}>{ltForm.color}</span>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>有薪</label>
                    <select value={ltForm.isPaid ? '1' : '0'} onChange={e => setLtForm({ ...ltForm, isPaid: e.target.value === '1' })}>
                      <option value="1">是</option>
                      <option value="0">否</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn" style={{ background: '#eee', color: '#333' }} onClick={() => { setLtShowForm(false); setLtEditingId(null); }}>取消</button>
                  <button type="submit" className="btn btn-primary">{ltEditingId ? '保存' : '新增'}</button>
                </div>
              </form>
            </div>
          )}

          {/* Leave Types Table */}
          <div className="card">
            <table>
              <thead>
                <tr><th>顏色</th><th>名稱</th><th>有薪</th><th>年度額度</th><th>狀態</th><th>操作</th></tr>
              </thead>
              <tbody>
                {leaveTypes.map(t => (
                  <tr key={t.id}>
                    <td><div style={{ width: 20, height: 20, borderRadius: 4, background: t.color || '#ccc' }} /></td>
                    <td style={{ fontWeight: 500 }}>{t.name}</td>
                    <td>{t.isPaid ? '✅ 有薪' : '❌ 無薪'}</td>
                    <td>{t.annualQuota ? `${t.annualQuota} 天` : '無限制'}</td>
                    <td>
                      <label style={{ fontSize: 13, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!t.isActive} onChange={() => handleLtToggleActive(t.id, !!t.isActive)} />
                        {' '}{t.isActive ? '啟用' : '停用'}
                      </label>
                    </td>
                    <td>
                      <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => handleLtEdit(t)}>編輯</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
