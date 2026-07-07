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
    return prevMonth.toISOString().slice(0, 7)
  })
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ runId: string; itemCount: number; totalPayable: number } | null>(null)
  const [userRole, setUserRole] = useState<string>('')

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

        <button
          onClick={handleGenerate}
          disabled={generating || !periodMonth}
          style={{
            background: generating || !periodMonth ? '#ccc' : '#0d6efd',
            color: '#fff',
            padding: '12px 24px',
            borderRadius: 6,
            border: 'none',
            fontSize: 16,
            fontWeight: 600,
            cursor: generating || !periodMonth ? 'default' : 'pointer',
            width: '100%',
          }}
        >
          {generating ? '計算中...' : '生成計糧'}
        </button>

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
      </div>
    </div>
  )
}
