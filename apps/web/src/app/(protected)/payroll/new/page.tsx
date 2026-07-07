'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

interface Clinic {
  id: string
  name: string
}

export default function NewPayrollPage() {
  const router = useRouter()
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [selectedClinic, setSelectedClinic] = useState<string>('')
  const [periodMonth, setPeriodMonth] = useState(() => {
    const now = new Date()
    // Default to previous month
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`
  })
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ runId: string; itemCount: number; totalPayable: number } | null>(null)
  const [userRole, setUserRole] = useState<string>('')

  // Preview + employee states
  const [previewing, setPreviewing] = useState(false)
  const [previewResult, setPreviewResult] = useState<{
    items: Array<{
      employeeId: string; employeeName: string; payType: string;
      workedHours: number; otHours: number; leaveDays: number; absentDays: number;
      basePay: number; otPay: number; splitPay: number | null; deduction: number;
      totalPayable: number; error?: string;
    }>;
    itemCount: number; totalPayable: number;
  } | null>(null)
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([])
  const [selectedEmployee, setSelectedEmployee] = useState<string>('')

  const fetchClinics = useCallback(async () => {
    try {
      const res = await fetch('/api/clinics')
      if (res.ok) {
        const data = await res.json()
        setClinics(data.clinics || data || [])
      }
    } catch (err) {
      console.error('Failed to fetch clinics:', err)
    }
  }, [])

  useEffect(() => {
    fetchClinics()
    fetch('/api/me').then(async r => {
      if (!r.ok) return { user: { role: '' } }
      const d = await r.json()
      setUserRole(d.user?.role || '')
    })
    fetch('/api/employees?pageSize=200').then(async r => {
      if (!r.ok) return
      const d = await r.json()
      setEmployees((d.employees || []).map((e: any) => ({
        id: e.id,
        name: e.user?.name || e.id,
      })))
    })
  }, [fetchClinics])

  // Redirect if not OWNER
  useEffect(() => {
    if (userRole && userRole !== 'OWNER') {
      router.push('/payroll')
    }
  }, [userRole, router])

  const handleGenerate = async () => {
    if (!periodMonth) {
      setError('請選擇計糧月份')
      return
    }

    setGenerating(true)
    setError(null)

    try {
      const res = await fetch('/api/payroll-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          periodMonth,
          clinicId: selectedClinic || null,
        }),
      })

      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || '生成失敗')
      }

      const data = await res.json()
      setResult(data)
    } catch (err: any) {
      setError(err.message || '生成失敗')
    } finally {
      setGenerating(false)
    }
  }

  const handlePreview = async () => {
    if (!periodMonth) {
      setError('請選擇計糧月份')
      return
    }
    setPreviewing(true)
    setError(null)
    setPreviewResult(null)
    try {
      const res = await fetch('/api/payroll-runs/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          periodMonth,
          clinicId: selectedClinic || null,
          employeeId: selectedEmployee || null,
        }),
      })
      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || '試算失敗')
      }
      const data = await res.json()
      setPreviewResult(data)
    } catch (err: any) {
      setError(err.message || '試算失敗')
    } finally {
      setPreviewing(false)
    }
  }

  if (userRole && userRole !== 'OWNER') return null

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24 }}>+ 生成計糧</h1>

      <div style={{ maxWidth: 500 }}>
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 14 }}>
            計糧月份
          </label>
          <input
            type="month"
            value={periodMonth}
            onChange={e => setPeriodMonth(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #ddd',
              fontSize: 16,
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 14 }}>
            診所（留空 = 全部診所）
          </label>
          <select
            value={selectedClinic}
            onChange={e => setSelectedClinic(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #ddd',
              fontSize: 16,
              boxSizing: 'border-box',
            }}
          >
            <option value="">全部診所</option>
            {clinics.map(clinic => (
              <option key={clinic.id} value={clinic.id}>
                {clinic.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 14 }}>
            員工（留空 = 全部員工）
          </label>
          <select
            value={selectedEmployee}
            onChange={e => setSelectedEmployee(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid #ddd',
              fontSize: 16,
              boxSizing: 'border-box',
            }}
          >
            <option value="">全部員工</option>
            {employees.map(emp => (
              <option key={emp.id} value={emp.id}>{emp.name}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={handlePreview}
            disabled={previewing || !periodMonth}
            style={{
              flex: 1,
              background: previewing || !periodMonth ? '#ccc' : '#198754',
              color: '#fff',
              padding: '12px 24px',
              borderRadius: 6,
              border: 'none',
              fontSize: 16,
              fontWeight: 600,
              cursor: previewing || !periodMonth ? 'default' : 'pointer',
            }}
          >
            {previewing ? '試算中...' : '🔍 試算預覽'}
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating || !periodMonth}
            style={{
              flex: 1,
              background: generating || !periodMonth ? '#ccc' : '#0d6efd',
              color: '#fff',
              padding: '12px 24px',
              borderRadius: 6,
              border: 'none',
              fontSize: 16,
              fontWeight: 600,
              cursor: generating || !periodMonth ? 'default' : 'pointer',
            }}
          >
            {generating ? '計算中...' : '生成計糧'}
          </button>
        </div>

        {error && (
          <div style={{
            marginTop: 16,
            padding: '12px 16px',
            background: '#f8d7da',
            color: '#842029',
            borderRadius: 6,
            fontSize: 14,
          }}>
            ⚠️ {error}
          </div>
        )}

        {result && (
          <div style={{
            marginTop: 16,
            padding: '16px',
            background: '#d1e7dd',
            color: '#0f5132',
            borderRadius: 6,
            fontSize: 14,
          }}>
            <div style={{ marginBottom: 8, fontWeight: 600 }}>✅ 計糧生成成功！</div>
            <div>員工數: {result.itemCount}</div>
            <div>應付總額: HK${result.totalPayable.toLocaleString()}</div>
            <div style={{ marginTop: 12 }}>
              <a
                href={`/payroll/${result.runId}`}
                style={{ color: '#0f5132', fontWeight: 600 }}
              >
                查看詳情 →
              </a>
            </div>
          </div>
        )}

        {/* Preview Results */}
        {previewResult && (
          <div style={{
            marginTop: 16,
            padding: '16px',
            background: '#e7f1ff',
            color: '#084298',
            borderRadius: 6,
            fontSize: 14,
          }}>
            <div style={{ marginBottom: 12, fontWeight: 600, fontSize: 15 }}>
              🔍 試算結果（未儲存）
            </div>
            <div style={{ marginBottom: 8, fontSize: 13 }}>
              員工數: {previewResult.itemCount} | 應付總額: HK${previewResult.totalPayable.toLocaleString()}
            </div>
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #084298', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px' }}>員工</th>
                    <th style={{ padding: '6px 8px' }}>薪資類型</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>工時</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>加班</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>底薪</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>加班費</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>扣款</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>總額</th>
                  </tr>
                </thead>
                <tbody>
                  {previewResult.items.map((item: any, i: number) => (
                    <tr key={item.employeeId || i} style={{ borderBottom: '1px solid #cfe2ff' }}>
                      {item.error ? (
                        <td colSpan={8} style={{ padding: '6px 8px', color: '#dc3545' }}>
                          {item.employeeName}: {item.error}
                        </td>
                      ) : (
                        <>
                          <td style={{ padding: '6px 8px' }}>{item.employeeName}</td>
                          <td style={{ padding: '6px 8px' }}>{item.payType}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{item.workedHours}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{item.otHours}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>HK${(item.basePay || 0).toLocaleString()}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>HK${(item.otPay || 0).toLocaleString()}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>-HK${(item.deduction || 0).toLocaleString()}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>
                            HK${(item.totalPayable || 0).toLocaleString()}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
