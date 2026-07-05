'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

export default function PunchPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [punching, setPunching] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)
  const [records, setRecords] = useState<any[]>([])
  const [manualToken, setManualToken] = useState('')
  const [selectedClinic, setSelectedClinic] = useState('')
  const [clinics, setClinics] = useState<any[]>([])

  const fetchUserData = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) { router.push('/login'); return }
      const data = await res.json()
      setUser({ role: data.user.role, clinics: data.user.clinicIds || [] })
      if (data.user.clinicIds?.length > 0) {
        setSelectedClinic(data.user.clinicIds[0])
      }
    } catch { router.push('/login') }
  }, [router])

  const fetchClinics = useCallback(async () => {
    try {
      const res = await fetch('/api/clinics', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setClinics(data.clinics || [])
      }
    } catch {}
  }, [])

  const fetchRecords = useCallback(async () => {
    try {
      const res = await fetch('/api/punch/my-records', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setRecords(data.records || [])
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchUserData()
  }, [fetchUserData])

  useEffect(() => {
    if (user) {
      fetchClinics()
      fetchRecords()
    }
  }, [user, fetchClinics, fetchRecords])

  useEffect(() => {
    if (user) setLoading(false)
  }, [user])

  // Auto-refresh records
  useEffect(() => {
    const interval = setInterval(fetchRecords, 30000)
    return () => clearInterval(interval)
  }, [fetchRecords])

  async function handlePunch(punchType: 'CLOCK_IN' | 'CLOCK_OUT') {
    if (!selectedClinic) {
      setResult({ success: false, message: '請先選擇診所' })
      return
    }

    setPunching(true)
    setResult(null)

    try {
      // Generate QR token for the selected clinic
      const tokenRes = await fetch(`/api/qr-tokens?clinicId=${selectedClinic}`, { credentials: 'include' })
      if (!tokenRes.ok) throw new Error('Failed to generate QR token')

      const tokenData = await tokenRes.json()

      // Punch with the generated token
      const punchRes = await fetch('/api/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          token: tokenData.token,
          punchType,
          deviceInfo: navigator.userAgent,
        }),
      })

      const punchData = await punchRes.json()

      if (!punchRes.ok) throw new Error(punchData.error || 'Punch failed')

      setResult({ success: true, message: `打卡成功！${punchType === 'CLOCK_IN' ? '上班' : '下班'}時間：${new Date(punchData.punchTime).toLocaleTimeString('zh-HK')}` })
      fetchRecords()
    } catch (err: any) {
      setResult({ success: false, message: err.message || '打卡失敗' })
    } finally {
      setPunching(false)
    }
  }

  async function handleManualPunch(punchType: 'CLOCK_IN' | 'CLOCK_OUT') {
    if (!manualToken) {
      setResult({ success: false, message: '請輸入 Token' })
      return
    }

    setPunching(true)
    setResult(null)

    try {
      const punchRes = await fetch('/api/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          token: manualToken,
          punchType,
          deviceInfo: navigator.userAgent,
        }),
      })

      const punchData = await punchRes.json()

      if (!punchRes.ok) throw new Error(punchData.error || 'Punch failed')

      setResult({ success: true, message: `打卡成功！${punchType === 'CLOCK_IN' ? '上班' : '下班'}時間：${new Date(punchData.punchTime).toLocaleTimeString('zh-HK')}` })
      setManualToken('')
      fetchRecords()
    } catch (err: any) {
      setResult({ success: false, message: err.message || '打卡失敗' })
    } finally {
      setPunching(false)
    }
  }

  if (loading) return <div style={{ padding: 20 }}>載入中...</div>
  if (!user) return null

  return (
    <div style={{ padding: 20, maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 8 }}>📱 打卡</h1>
      <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>
        選擇診所後點擊按鈕打卡，或輸入 Token 手動打卡
      </p>

      {/* Clinic selector */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>選擇診所</label>
        <select
          value={selectedClinic}
          onChange={(e) => setSelectedClinic(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 14 }}
        >
          <option value="">請選擇診所...</option>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Quick punch buttons */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <button
          onClick={() => handlePunch('CLOCK_IN')}
          disabled={punching || !selectedClinic}
          style={{
            flex: 1, padding: '16px 20px', borderRadius: 8, border: 'none',
            background: punching || !selectedClinic ? '#ccc' : '#27ae60',
            color: '#fff', fontSize: 16, fontWeight: 'bold', cursor: punching || !selectedClinic ? 'not-allowed' : 'pointer',
          }}
        >
          ☀️ 上班打卡
        </button>
        <button
          onClick={() => handlePunch('CLOCK_OUT')}
          disabled={punching || !selectedClinic}
          style={{
            flex: 1, padding: '16px 20px', borderRadius: 8, border: 'none',
            background: punching || !selectedClinic ? '#ccc' : '#e67e22',
            color: '#fff', fontSize: 16, fontWeight: 'bold', cursor: punching || !selectedClinic ? 'not-allowed' : 'pointer',
          }}
        >
          🌙 下班打卡
        </button>
      </div>

      {/* Manual token input */}
      <div style={{
        background: '#f9f9f9', borderRadius: 8, padding: 16, marginBottom: 24,
        border: '1px solid #eee',
      }}>
        <h3 style={{ marginTop: 0, fontSize: 14 }}>手動輸入 Token</h3>
        <input
          type="text"
          value={manualToken}
          onChange={(e) => setManualToken(e.target.value)}
          placeholder="輸入 QR Token"
          style={{
            width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid #ddd',
            fontSize: 13, marginBottom: 8, boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => handleManualPunch('CLOCK_IN')}
            disabled={punching}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 4, border: 'none',
              background: '#27ae60', color: '#fff', fontSize: 13, cursor: punching ? 'not-allowed' : 'pointer',
            }}
          >
            ☀️ 上班
          </button>
          <button
            onClick={() => handleManualPunch('CLOCK_OUT')}
            disabled={punching}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 4, border: 'none',
              background: '#e67e22', color: '#fff', fontSize: 13, cursor: punching ? 'not-allowed' : 'pointer',
            }}
          >
            🌙 下班
          </button>
        </div>
      </div>

      {/* Result message */}
      {result && (
        <div style={{
          padding: '12px 16px', borderRadius: 6, marginBottom: 20,
          background: result.success ? '#eafaf1' : '#fdedec',
          border: `1px solid ${result.success ? '#a9dfbf' : '#f5b7b1'}`,
          color: result.success ? '#27ae60' : '#e74c3c',
          fontSize: 14,
        }}>
          {result.success ? '✅' : '❌'} {result.message}
        </div>
      )}

      {/* Recent records */}
      <div>
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>最近打卡記錄</h3>
        {records.length === 0 ? (
          <p style={{ color: '#888', fontSize: 13 }}>暫無打卡記錄</p>
        ) : (
          records.slice(0, 5).map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontSize: 13,
              }}
            >
              <div>
                <span style={{
                  padding: '2px 6px', borderRadius: 4, fontSize: 11,
                  background: r.punchType === 'CLOCK_IN' ? '#e6f7e6' : '#fff3e6',
                  color: r.punchType === 'CLOCK_IN' ? '#2d7a2d' : '#b35900',
                }}>
                  {r.punchType === 'CLOCK_IN' ? '上班' : '下班'}
                </span>
                <span style={{ marginLeft: 8 }}>{r.clinic?.name}</span>
              </div>
              <span style={{ color: '#888', fontSize: 12 }}>
                {new Date(r.punchTime).toLocaleString('zh-HK')}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
