'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtDate } from '@/lib/hk-date'

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
  leaveType: { id: string; name: string; isPaid: boolean; annualQuota: number | null; color: string | null; systemKey: string | null }
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
  APPROVED: '已批準',
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
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [filter, setFilter] = useState<LeaveStatus | ''>('')
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', days: '', reason: '' })
  const [userRole, setUserRole] = useState<string>('')

  const fetchData = useCallback(async () => {
    setError('')
    try {
      const [leaveRes, meRes] = await Promise.all([
        fetch('/api/my/leave', { credentials: 'include' }),
        fetch('/api/me', { credentials: 'include' }).then(r => r).catch(() => ({ ok: false } as Response)),
      ])
      if (!leaveRes.ok) {
        const body = await leaveRes.json().catch(() => ({}))
        throw new Error(body.error || `伺服器錯誤 (${leaveRes.status})`)
      }
      const data = await leaveRes.json()
      setRequests(data.leaveRequests || [])
      setBalances(data.leaveBalances || [])
      setLeaveTypes(data.leaveTypes || [])
      if (meRes.ok) {
        const meData = await meRes.json()
        setUserRole(meData.user?.role || '')
      }
    } catch (err: any) {
      setError(err.message || '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

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

  const isEmployee = userRole === 'EMPLOYEE'

  const filteredRequests = filter ? requests.filter(r => r.status === filter) : requests

  if (loading) return <div className="flex justify-center items-center py-12 text-gray-400">載入中...</div>
  if (error) return <div className="p-4 text-red-600 dark:text-red-400">⚠️ {error}</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">🏖️ 我的假期</h1>
        {!isEmployee && (
          <button
            className="btn btn-primary"
            onClick={() => setShowForm(!showForm)}
          >
            {showForm ? '取消' : '+ 申請'}
          </button>
        )}
      </div>

      {/* Leave Balance */}
      {balances.length > 0 && (
        <div className="card mb-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">假期餘額</h2>
          <div className="space-y-2">
            {balances.map(b => (
              <div
                key={b.id}
                className="flex items-center justify-between p-3 rounded-lg"
                style={{
                  background: `${b.leaveType.color || '#0d7377'}10`,
                  borderLeft: `3px solid ${b.leaveType.color || '#0d7377'}`,
                }}
              >
                <div>
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-200">{b.leaveType.name}</div>
                  <div className="text-xs text-gray-400 mt-0.5">已用 {b.used.toFixed(1)} 天</div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-gray-900 dark:text-white">{b.remaining.toFixed(1)}</div>
                  <div className="text-xs text-gray-400">
                    天剩餘{b.leaveType.annualQuota !== null ? ` / ${b.leaveType.annualQuota}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Apply Form */}
      {showForm && !isEmployee && (
        <div className="card mb-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">申請假期</h2>
          <form onSubmit={handleApply}>
            <div className="space-y-3">
              <div className="form-group">
                <label>假期類型</label>
                <select
                  value={form.leaveTypeId}
                  onChange={e => setForm({ ...form, leaveTypeId: e.target.value })}
                  required
                  className="w-full p-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="">請選擇</option>
                  {leaveTypes.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.annualQuota ? ` (${t.annualQuota}天)` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="form-group">
                  <label>開始日期</label>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={e => setForm({ ...form, startDate: e.target.value })}
                    required
                    className="w-full p-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
                <div className="form-group">
                  <label>結束日期</label>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={e => setForm({ ...form, endDate: e.target.value })}
                    required
                    className="w-full p-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
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
                  className="w-full p-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>
              <div className="form-group">
                <label>原因（可選）</label>
                <input
                  type="text"
                  value={form.reason}
                  onChange={e => setForm({ ...form, reason: e.target.value })}
                  placeholder="請填寫請假原因"
                  className="w-full p-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button
                type="button"
                className="btn"
                style={{ background: '#eee', color: '#333' }}
                onClick={() => setShowForm(false)}
              >
                取消
              </button>
              <button type="submit" className="btn btn-primary">提交申請</button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
        {(['', 'PENDING', 'APPROVED', 'REJECTED'] as const).map(s => (
          <button
            key={s || 'all'}
            className="btn flex-shrink-0"
            style={{
              background: filter === s ? '#0d7377' : '#f0f0f0',
              color: filter === s ? 'white' : '#333',
              fontSize: 13,
              padding: '6px 14px',
            }}
            onClick={() => setFilter(s)}
          >
            {s === 'PENDING' ? '待審批' : s === 'APPROVED' ? '已批準' : s === 'REJECTED' ? '已拒絕' : '全部'}
          </button>
        ))}
      </div>

      {/* Leave Requests — card-based */}
      <div className="card">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">
          我的假期申請 ({filteredRequests.length})
        </h2>
        {filteredRequests.length === 0 ? (
          <div className="text-center text-gray-400 py-8">尚無假期申請</div>
        ) : (
          <div className="space-y-2">
            {filteredRequests.map(r => (
              <div
                key={r.id}
                className="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50"
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className="text-xs px-2 py-0.5 rounded font-medium"
                    style={{
                      background: `${r.leaveType.color || '#0d7377'}20`,
                      color: r.leaveType.color || '#0d7377',
                    }}
                  >
                    {r.leaveType.name}
                  </span>
                  <span
                    className="text-xs px-2 py-0.5 rounded"
                    style={{
                      background: `${STATUS_COLORS[r.status]}20`,
                      color: STATUS_COLORS[r.status],
                    }}
                  >
                    {STATUS_LABELS[r.status]}
                  </span>
                </div>
                <div className="text-sm text-gray-800 dark:text-gray-200 mt-1.5">
                  {fmtDate(r.startDate)}
                  {' → '}
                  {fmtDate(r.endDate)}
                  {'  (' + r.days + '天)'}
                </div>
                {r.reason && (
                  <div className="text-xs text-gray-400 mt-1 truncate">{r.reason}</div>
                )}
                <div className="text-xs text-gray-400 mt-1">
                  申請日期: {fmtDate(r.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
