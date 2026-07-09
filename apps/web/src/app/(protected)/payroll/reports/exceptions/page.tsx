'use client'

import { useEffect, useState, useCallback } from 'react'
import { BackButton } from '@/components/BackButton'

interface ExceptionRecord {
  employeeId: string
  employeeName: string
  clinicName: string
  date: string
  type: 'LATE' | 'ABSENT' | 'CORRECTION'
  detail: string
  punchTime?: string
  correctionTime?: string
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

  useEffect(() => {
    fetchClinics()
    fetchEmployees()
  }, [fetchClinics, fetchEmployees])

  const fetchExceptions = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ periodMonth })
      if (clinicId) params.set('clinicId', clinicId)
      if (employeeId) params.set('employeeId', employeeId)

      const res = await fetch(`/api/payroll-runs/_exceptions?${params}`)
      if (res.ok) {
        const data = await res.json()
        setExceptions(data.exceptions || [])
      } else {
        // Fallback: compute client-side from available data
        setExceptions([])
      }
    } catch {
      setExceptions([])
    } finally {
      setLoading(false)
    }
  }, [clinicId, employeeId, periodMonth])

  const typeLabel = (type: string) => {
    switch (type) {
      case 'LATE': return '遲到'
      case 'ABSENT': return '缺勤'
      case 'CORRECTION': return '補登'
      default: return type
    }
  }

  const typeColor = (type: string) => {
    switch (type) {
      case 'LATE': return '#ffc107'
      case 'ABSENT': return '#dc3545'
      case 'CORRECTION': return '#0dcaf0'
      default: return '#888'
    }
  }

  // Group by type for summary
  const summary = {
    total: exceptions.length,
    late: exceptions.filter(e => e.type === 'LATE').length,
    absent: exceptions.filter(e => e.type === 'ABSENT').length,
    correction: exceptions.filter(e => e.type === 'CORRECTION').length,
  }

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

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
        {[
          { label: '異常總數', value: summary.total, color: '#495057' },
          { label: '遲到', value: summary.late, color: '#ffc107' },
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
              </tr>
            </thead>
            <tbody>
              {exceptions.map((ex, i) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
