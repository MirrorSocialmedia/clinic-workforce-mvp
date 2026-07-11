'use client'

import { useEffect, useState, useCallback } from 'react'
import { BackButton } from '@/components/BackButton'

interface ExceptionRecord {
  employeeId: string
  employeeName: string
  clinicName: string
  date: string
  type: 'LATE' | 'ABSENT' | 'CORRECTION' | 'EARLY_LEAVE'
  detail: string
  punchTime?: string
  correctionTime?: string
}

interface EmployeeSummary {
  employeeId: string
  employeeName: string
  otMinutes: number
  owedMinutes: number
  availableMinutes: number
  convertibleLeaveDays: number
  lateCount: number
}

export default function ExceptionsReportPage() {
  const [clinicId, setClinicId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [periodMonth, setPeriodMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7)
  })
  const [exceptions, setExceptions] = useState<ExceptionRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [clinics, setClinics] = useState<Array<{ id: string; name: string }>>([])
  const [employees, setEmployees] = useState<Array<{ id: string; name: string }>>([])
  const [userRole, setUserRole] = useState<string>('')
  const [employeeSummaries, setEmployeeSummaries] = useState<EmployeeSummary[]>([])
  const [makeupOpen, setMakeupOpen] = useState<string | null>(null)
  const [makeupForm, setMakeupForm] = useState({ date: '', minutes: '', reason: '' })
  const [makeupSubmitting, setMakeupSubmitting] = useState(false)

  const isOwner = userRole === 'OWNER'

  const fetchClinics = useCallback(async () => {
    try {
      const res = await fetch('/api/clinics')
      if (res.ok) {
        const data = await res.json()
        setClinics(data.clinics || data || [])
      }
    } catch { /* ignore */ }
  }, [])

  const fetchEmployees = useCallback(async () => {
    try {
      const res = await fetch('/api/employees')
      if (res.ok) {
        const data = await res.json()
        setEmployees(data.employees || data || [])
      }
    } catch { /* ignore */ }
  }, [])

  const fetchUserRole = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setUserRole(data.user?.role || '')
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchClinics()
    fetchEmployees()
    fetchUserRole()
  }, [fetchClinics, fetchEmployees, fetchUserRole])

  const fetchExceptions = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ periodMonth })
      if (clinicId) params.set('clinicId', clinicId)
      if (employeeId) params.set('employeeId', employeeId)

      const res = await fetch(`/api/payroll-runs/exceptions?${params}`)
      if (res.ok) {
        const data = await res.json()
        setExceptions(data.exceptions || [])
        setEmployeeSummaries(data.employeeSummaries || [])
      } else {
        setExceptions([])
        setEmployeeSummaries([])
      }
    } catch {
      setExceptions([])
      setEmployeeSummaries([])
    } finally {
      setLoading(false)
    }
  }, [clinicId, employeeId, periodMonth])

  const handleMakeup = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!makeupOpen || !makeupForm.date || !makeupForm.minutes) return
    setMakeupSubmitting(true)
    try {
      const res = await fetch('/api/timebank/makeup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          employeeId: makeupOpen,
          date: makeupForm.date,
          minutes: parseInt(makeupForm.minutes),
          reason: makeupForm.reason || undefined,
        }),
      })
      if (res.ok) {
        setMakeupForm({ date: '', minutes: '', reason: '' })
        setMakeupOpen(null)
        fetchExceptions()
      } else {
        const err = await res.json()
        alert(err.error || '補鐘失敗')
      }
    } catch { alert('補鐘失敗') }
    finally { setMakeupSubmitting(false) }
  }

  const typeLabel = (type: string) => {
    switch (type) {
      case 'LATE': return '遲到'
      case 'EARLY_LEAVE': return '早退'
      case 'ABSENT': return '缺勤'
      case 'CORRECTION': return '補登'
      default: return type
    }
  }

  const typeColor = (type: string) => {
    switch (type) {
      case 'LATE': return '#ffc107'
      case 'EARLY_LEAVE': return '#fd7e14'
      case 'ABSENT': return '#dc3545'
      case 'CORRECTION': return '#0dcaf0'
      default: return '#888'
    }
  }

  const summary = {
    total: exceptions.length,
    late: exceptions.filter(e => e.type === 'LATE').length,
    absent: exceptions.filter(e => e.type === 'ABSENT').length,
    correction: exceptions.filter(e => e.type === 'CORRECTION').length,
    earlyLeave: exceptions.filter(e => e.type === 'EARLY_LEAVE').length,
  }

  const getEmployeeTimebank = (empId: string) => {
    return employeeSummaries.find(s => s.employeeId === empId) || null
  }

  const minutesToHours = (m: number) => (m / 60).toFixed(1)

  return (
    <div>
      <BackButton to="/payroll" label="返回計糧" />
      <h1 style={{ margin: '0 0 24px', fontSize: 24 }}>考勤異常報表</h1>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>月份</label>
          <input
            type="month"
            value={periodMonth}
            onChange={e => setPeriodMonth(e.target.value)}
            style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>診所</label>
          <select
            value={clinicId}
            onChange={e => setClinicId(e.target.value)}
            style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd', minWidth: 150 }}
          >
            <option value="">全部</option>
            {clinics.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>員工</label>
          <select
            value={employeeId}
            onChange={e => setEmployeeId(e.target.value)}
            style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd', minWidth: 150 }}
          >
            <option value="">全部</option>
            {employees.map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>

        <button
          onClick={fetchExceptions}
          disabled={loading}
          style={{
            padding: '6px 16px',
            borderRadius: 4,
            border: 'none',
            background: '#0d6efd',
            color: '#fff',
            cursor: loading ? 'default' : 'pointer',
            fontWeight: 600,
          }}
        >
          {loading ? '查詢中...' : '查詢'}
        </button>
      </div>

      {/* Overall Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
        {[
          { label: '異常總數', value: summary.total, color: '#495057' },
          { label: '遲到', value: summary.late, color: '#ffc107' },
          { label: '早退', value: summary.earlyLeave, color: '#fd7e14' },
          { label: '缺勤', value: summary.absent, color: '#dc3545' },
          { label: '補登', value: summary.correction, color: '#0dcaf0' },
        ].map(card => (
          <div key={card.label} style={{
            padding: '12px 16px',
            background: card.color + '10',
            borderLeft: `3px solid ${card.color}`,
            borderRadius: 4,
          }}>
            <div style={{ fontSize: 12, color: '#888' }}>{card.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: card.color }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* Per-Employee TimeBank Summary Cards */}
      {employeeSummaries.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12, color: '#333' }}>員工時間銀行匯總</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {employeeSummaries.map(s => (
              <div key={s.employeeId} style={{
                padding: '14px 16px',
                border: '1px solid #e0e0e0',
                borderRadius: 8,
                background: '#fafafa',
              }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>{s.employeeName}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 13 }}>
                  <span style={{ color: '#888' }}>🟢 OT:</span>
                  <span style={{ fontWeight: 600, color: '#198754' }}>{minutesToHours(s.otMinutes)}h</span>
                  <span style={{ color: '#888' }}>🔴 拖欠:</span>
                  <span style={{ fontWeight: 600, color: '#dc3545' }}>{minutesToHours(s.owedMinutes)}h</span>
                  <span style={{ color: '#888' }}>🟡 可換假:</span>
                  <span style={{ fontWeight: 600, color: '#0d6efd' }}>{s.convertibleLeaveDays} 天</span>
                  <span style={{ color: '#888' }}>⏰ 遲到次數:</span>
                  <span style={{ fontWeight: 600 }}>{s.lateCount} 次</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>查詢中...</div>
      ) : exceptions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>
          沒有找到異常記錄 🎉
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #dee2e6' }}>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>員工</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>診所</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>日期</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>類型</th>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>詳情</th>
                {isOwner && <th style={{ textAlign: 'left', padding: '8px 6px' }}>操作</th>}
              </tr>
            </thead>
            <tbody>
              {exceptions.map((ex, i) => {
                const tb = getEmployeeTimebank(ex.employeeId)
                const showMakeupBtn = (ex.type === 'LATE' || ex.type === 'EARLY_LEAVE') && isOwner
                return (
                  <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '8px 6px', fontWeight: 600 }}>{ex.employeeName}</td>
                    <td style={{ padding: '8px 6px' }}>{ex.clinicName}</td>
                    <td style={{ padding: '8px 6px' }}>{ex.date}</td>
                    <td style={{ padding: '8px 6px' }}>
                      <span style={{
                        background: typeColor(ex.type),
                        color: ex.type === 'LATE' ? '#333' : '#fff',
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        fontWeight: 600,
                      }}>
                        {typeLabel(ex.type)}
                      </span>
                    </td>
                    <td style={{ padding: '8px 6px', fontSize: 12, color: '#888' }}>{ex.detail}</td>
                    {isOwner && (
                      <td style={{ padding: '8px 6px' }}>
                        {showMakeupBtn && (
                          <button
                            onClick={() => {
                              setMakeupOpen(ex.employeeId)
                              setMakeupForm({ date: ex.date, minutes: '', reason: '' })
                            }}
                            style={{
                              padding: '2px 8px',
                              fontSize: 12,
                              borderRadius: 4,
                              border: '1px solid #0d6efd',
                              background: '#f0f4ff',
                              color: '#0d6efd',
                              cursor: 'pointer',
                            }}
                          >
                            補鐘
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Makeup Modal */}
      {makeupOpen && isOwner && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999,
        }} onClick={() => setMakeupOpen(null)}>
          <div style={{
            background: '#fff', borderRadius: 8, padding: 24, width: 400, maxWidth: '90vw',
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px' }}>補鐘</h3>
            <form onSubmit={handleMakeup}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: '#555' }}>日期</label>
                <input type="date" value={makeupForm.date}
                  onChange={e => setMakeupForm({ ...makeupForm, date: e.target.value })}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd', boxSizing: 'border-box' }} required />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: '#555' }}>分鐘</label>
                <input type="number" min="1" value={makeupForm.minutes}
                  onChange={e => setMakeupForm({ ...makeupForm, minutes: e.target.value })}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd', boxSizing: 'border-box' }} required />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: '#555' }}>原因（可選）</label>
                <input type="text" value={makeupForm.reason}
                  onChange={e => setMakeupForm({ ...makeupForm, reason: e.target.value })}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd', boxSizing: 'border-box' }}
                  placeholder="如：補遲到" />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setMakeupOpen(null)}
                  style={{ padding: '6px 16px', borderRadius: 4, border: '1px solid #ddd', background: '#f5f5f5', cursor: 'pointer' }}>
                  取消
                </button>
                <button type="submit" disabled={makeupSubmitting}
                  style={{ padding: '6px 16px', borderRadius: 4, border: 'none', background: '#0d6efd', color: '#fff', cursor: makeupSubmitting ? 'default' : 'pointer' }}>
                  {makeupSubmitting ? '提交中...' : '確認補鐘'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
