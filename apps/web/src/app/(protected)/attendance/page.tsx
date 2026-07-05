'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

interface PunchRecord {
  id: string
  employeeId: string
  clinicId: string
  punchTime: string
  punchType: string
  source: string
  tokenValid: boolean | null
  deviceInfo: string | null
  notes: string | null
  createdAt: string
  employee: {
    user: { name: string; phone: string }
  }
  clinic: { id: string; name: string }
  corrections: any[]
}

export default function AttendancePage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [records, setRecords] = useState<PunchRecord[]>([])
  const [clinics, setClinics] = useState<{ id: string; name: string }[]>([])
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)

  // Filters
  const [clinicFilter, setClinicFilter] = useState('')
  const [employeeFilter, setEmployeeFilter] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const fetchUserData = async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) { router.push('/login'); return }
      const data = await res.json()
      setUser({ role: data.user.role, clinics: data.user.clinicIds || [] })
    } catch { router.push('/login') }
  }

  const fetchClinics = async () => {
    try {
      const res = await fetch('/api/clinics', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setClinics(data.clinics || [])
      }
    } catch {}
  }

  const fetchEmployees = async () => {
    try {
      const res = await fetch('/api/employees', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setEmployees((data.employees || []).map((e: any) => ({
          id: e.id,
          name: e.user?.name || e.id,
        })))
      }
    } catch {}
  }

  const fetchRecords = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
      })
      if (clinicFilter) params.set('clinicId', clinicFilter)
      if (employeeFilter) params.set('employeeId', employeeFilter)
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)

      const res = await fetch(`/api/punches?${params}`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setRecords(data.records || [])
        setTotal(data.total || 0)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUserData()
  }, [])

  useEffect(() => {
    if (user) {
      fetchClinics()
      fetchEmployees()
    }
  }, [user])

  useEffect(() => {
    if (user) fetchRecords()
  }, [user, page, clinicFilter, employeeFilter, startDate, endDate])

  if (!user) return <div style={{ padding: 20 }}>Loading...</div>

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div style={{ padding: 20 }}>
      <h1 style={{ marginBottom: 20 }}>📋 考勤記錄</h1>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 20,
        flexWrap: 'wrap', alignItems: 'flex-end',
      }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>診所</label>
          <select
            value={clinicFilter}
            onChange={(e) => { setClinicFilter(e.target.value); setPage(1) }}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
          >
            <option value="">全部</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>員工</label>
          <select
            value={employeeFilter}
            onChange={(e) => { setEmployeeFilter(e.target.value); setPage(1) }}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
          >
            <option value="">全部</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>起始日期</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => { setStartDate(e.target.value); setPage(1) }}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>結束日期</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => { setEndDate(e.target.value); setPage(1) }}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
          />
        </div>

        <button
          onClick={() => { setClinicFilter(''); setEmployeeFilter(''); setStartDate(''); setEndDate(''); setPage(1) }}
          style={{
            padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd',
            background: '#f5f5f5', cursor: 'pointer',
          }}
        >
          清除篩查
        </button>
      </div>

      {/* Records Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #eee' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>員工</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>診所</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>時間</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>類型</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>來源</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Token</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>修正</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 20, color: '#888' }}>載入中...</td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 20, color: '#888' }}>沒有考勤記錄</td></tr>
            ) : (
              records.map((record) => (
                <tr key={record.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '8px 12px' }}>
                    {record.employee?.user?.name || record.employeeId}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {record.clinic?.name || record.clinicId}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {new Date(record.punchTime).toLocaleString('zh-HK')}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 10, fontSize: 11,
                      background: record.punchType === 'CLOCK_IN' ? '#e6f7e6' : '#fff3e6',
                      color: record.punchType === 'CLOCK_IN' ? '#2d7a2d' : '#b35900',
                    }}>
                      {record.punchType === 'CLOCK_IN' ? '上班' : '下班'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span style={{ fontSize: 11, color: '#666' }}>
                      {record.source === 'QR_DYNAMIC' ? '📱 動態碼' :
                       record.source === 'QR_STATIC' ? '📱 固定碼' :
                       record.source === 'MANUAL_CORRECTION' ? '✏️ 補打卡' :
                       '⚙️ 系統'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {record.tokenValid === true ? '✅' :
                     record.tokenValid === false ? '❌' :
                     record.tokenValid === null ? '—' : '?'}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {record.corrections?.length > 0 ? (
                      <span style={{ color: '#e67e22', fontSize: 12 }}>
                        {record.corrections.length} 筆修正
                      </span>
                    ) : (
                      <span style={{ color: '#27ae60', fontSize: 12 }}>✓ 無修正</span>
                    )}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <Link href={`/attendance/${record.id}`} style={{ color: '#3498db', fontSize: 12 }}>
                      詳情
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 20 }}>
          {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              style={{
                padding: '4px 10px', borderRadius: 4, border: '1px solid #ddd',
                background: p === page ? '#3498db' : '#fff',
                color: p === page ? '#fff' : '#333',
                cursor: 'pointer',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 12, color: '#888' }}>
        共 {total} 筆記錄
      </div>
    </div>
  )
}
