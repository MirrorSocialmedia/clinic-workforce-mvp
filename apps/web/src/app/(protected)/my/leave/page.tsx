'use client'

import { useEffect, useState, useCallback } from 'react'

type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

interface LeaveRequestItem {
  id: string
  leaveTypeId: string
  leaveType: { id: string; name: string; isPaid: boolean; color: string | null }
  startDate: string
  endDate: string
  days: number
  reason: string | null
  status: LeaveStatus
  approvedAt: string | null
  createdAt: string
}

interface LeaveBalanceItem {
  id: string
  leaveTypeId: string
  leaveType: { id: string; name: string; isPaid: boolean; annualQuota: number | null; color: string | null }
  year: number
  entitled: number
  used: number
  remaining: number
}

interface LeaveTypeItem {
  id: string
  name: string
  isPaid: boolean
  annualQuota: number | null
  color: string | null
}

const STATUS_LABELS: Record<LeaveStatus, string> = {
  PENDING: '待審批',
  APPROVED: '已批准',
  REJECTED: '已拒絕',
}

const STATUS_COLORS: Record<LeaveStatus, string> = {
  PENDING: '#FF9800',
  APPROVED: '#4CAF50',
  REJECTED: '#dc3545',
}

export default function MyLeavePage() {
  const [requests, setRequests] = useState<LeaveRequestItem[]>([])
  const [balances, setBalances] = useState<LeaveBalanceItem[]>([])
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [filter, setFilter] = useState<LeaveStatus | ''>('')
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', days: '', reason: '' })

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/my/leave', { credentials: 'include' })
      const data = await res.json()
      setRequests(data.leaveRequests || [])
      setBalances(data.leaveBalances || [])
      setLeaveTypes(data.leaveTypes || [])
    } catch (err) {
      console.error('Fetch leave data error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

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

  const filteredRequests = filter
    ? requests.filter(r => r.status === filter)
    : requests

  if (loading) return <div style={{ padding: 24 }}>載入中...</div>

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', margin: 0 }}>🏖️ 我的假期</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? '取消' : '+ 申請假期'}
        </button>
      </div>

      {/* Leave Balance */}
      {balances.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2>假期餘額</h2>
          <div className="grid-4" style={{ marginBottom: 0 }}>
            {balances.map(b => (
              <div key={b.id} style={{
                padding: 16,
                borderRadius: 8,
                background: `${b.leaveType.color || '#1a1a2e'}10`,
                borderLeft: `4px solid ${b.leaveType.color || '#1a1a2e'}`,
              }}>
                <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>{b.leaveType.name}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{b.remaining.toFixed(1)}</div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  天剩餘
                  {b.leaveType.annualQuota !== null && ` / 共 ${b.leaveType.annualQuota} 天`}
                </div>
                <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>
                  已用 {b.used.toFixed(1)} 天
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Apply Form */}
      {showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2>申請假期</h2>
          <form onSubmit={handleApply}>
            <div className="grid-3" style={{ marginBottom: 0 }}>
              <div className="form-group">
                <label>假期類型</label>
                <select
                  value={form.leaveTypeId}
                  onChange={e => setForm({ ...form, leaveTypeId: e.target.value })}
                  required
                >
                  <option value="">請選擇</option>
                  {leaveTypes.map(t => (
                    <option key={t.id} value={t.id}>{t.name}{t.annualQuota ? ` (${t.annualQuota}天)` : ''}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>開始日期</label>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={e => setForm({ ...form, startDate: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>結束日期</label>
                <input
                  type="date"
                  value={form.endDate}
                  onChange={e => setForm({ ...form, endDate: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>天數</label>
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  value={form.days}
                  onChange={e => setForm({ ...form, days: e.target.value })}
                  required
                />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label>原因（可選）</label>
                <input
                  type="text"
                  value={form.reason}
                  onChange={e => setForm({ ...form, reason: e.target.value })}
                  placeholder="請填寫請假原因"
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" style={{ background: '#eee', color: '#333' }} onClick={() => setShowForm(false)}>
                取消
              </button>
              <button type="submit" className="btn btn-primary">提交申請</button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['', 'PENDING', 'APPROVED', 'REJECTED'] as const).map(s => (
          <button
            key={s || 'all'}
            className="btn"
            style={{
              background: filter === s ? '#1a1a2e' : '#f0f0f0',
              color: filter === s ? 'white' : '#333',
              fontSize: 13,
              padding: '6px 12px',
            }}
            onClick={() => setFilter(s)}
          >
            {s === 'PENDING' ? '待審批' : s === 'APPROVED' ? '已批准' : s === 'REJECTED' ? '已拒絕' : '全部'}
          </button>
        ))}
      </div>

      {/* Leave Requests */}
      <div className="card">
        <h2>我的假期申請 ({filteredRequests.length})</h2>
        {filteredRequests.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>尚無假期申請</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>類型</th>
                <th>日期</th>
                <th>天數</th>
                <th>原因</th>
                <th>狀態</th>
                <th>申請日期</th>
              </tr>
            </thead>
            <tbody>
              {filteredRequests.map(r => (
                <tr key={r.id}>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      background: `${r.leaveType.color || '#1a1a2e'}20`,
                      color: r.leaveType.color || '#1a1a2e',
                    }}>
                      {r.leaveType.name}
                    </span>
                  </td>
                  <td>
                    {new Date(r.startDate).toISOString().split('T')[0]}
                    {' → '}
                    {new Date(r.endDate).toISOString().split('T')[0]}
                  </td>
                  <td>{r.days}</td>
                  <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.reason || '-'}
                  </td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      background: `${STATUS_COLORS[r.status]}20`,
                      color: STATUS_COLORS[r.status],
                    }}>
                      {STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: '#888' }}>
                    {new Date(r.createdAt).toLocaleDateString('zh-HK')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
