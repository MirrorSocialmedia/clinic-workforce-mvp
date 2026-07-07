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

  const fetchUserData = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) { router.push('/login'); return }
      const data = await res.json()
      setUser({ role: data.user.role, clinics: data.user.clinicIds || [] })
    } catch { router.push('/login') }
  }, [router])

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
      fetchRecords()
      setLoading(false)
    }
  }, [user, fetchRecords])

  // Auto-refresh records every 30s
  useEffect(() => {
    if (!user) return
    const interval = setInterval(fetchRecords, 30000)
    return () => clearInterval(interval)
  }, [user, fetchRecords])

  async function handleManualPunch(punchType: 'CLOCK_IN' | 'CLOCK_OUT') {
    if (!manualToken.trim()) {
      setResult({ success: false, message: '請輸入 QR Token' })
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
          token: manualToken.trim(),
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
    <div className="main-content" style={{ maxWidth: 600, margin: '0 auto' }}>
      <div className="page-header">
        <div>
          <h1 style={{ fontSize: 22 }}>📱 打卡</h1>
          <div className="subtitle">掃描診所 QR 碼，輸入 Token 打卡</div>
        </div>
      </div>

      {/* Info box */}
      <div style={{
        background: '#e8f4f4',
        border: '1px solid #b2dfdb',
        borderRadius: 8,
        padding: '14px 18px',
        marginBottom: 24,
        fontSize: 13,
        color: '#00695c',
        lineHeight: 1.6,
      }}>
        <strong>📋 打卡方式：</strong>
        <br/>
        1. 掃描診所櫃檯螢幕上的 QR 碼，取得 Token
        <br/>
        2. 將 Token 輸入下方方框
        <br/>
        3. 選擇上班或下班打卡
      </div>

      {/* Token input */}
      <div className="card">
        <h2>輸入 QR Token</h2>
        <div className="form-group">
          <input
            type="text"
            value={manualToken}
            onChange={(e) => setManualToken(e.target.value)}
            placeholder="請貼上 QR Token"
            style={{
              width: '100%', padding: '12px 14px', borderRadius: 6, border: '1px solid var(--border)',
              fontSize: 14, boxSizing: 'border-box', fontFamily: 'var(--font-mono)',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={() => handleManualPunch('CLOCK_IN')}
            disabled={punching || !manualToken.trim()}
            className="btn btn-primary"
            style={{
              flex: 1, padding: '14px 20px', fontSize: 15, fontWeight: 600,
              justifyContent: 'center',
              opacity: punching || !manualToken.trim() ? 0.5 : 1,
            }}
          >
            ☀️ 上班打卡
          </button>
          <button
            onClick={() => handleManualPunch('CLOCK_OUT')}
            disabled={punching || !manualToken.trim()}
            className="btn"
            style={{
              flex: 1, padding: '14px 20px', fontSize: 15, fontWeight: 600,
              justifyContent: 'center',
              background: '#e67e22', color: '#fff',
              opacity: punching || !manualToken.trim() ? 0.5 : 1,
            }}
          >
            🌙 下班打卡
          </button>
        </div>
      </div>

      {/* Result message */}
      {result && (
        <div className={result.success ? 'success-box' : 'error-box'}>
          {result.success ? '✅' : '❌'} {result.message}
        </div>
      )}

      {/* Recent records */}
      <div className="card">
        <h2>最近打卡記錄</h2>
        {records.length === 0 ? (
          <div className="text-muted" style={{ textAlign: 'center', padding: 20 }}>暫無打卡記錄</div>
        ) : (
          records.slice(0, 10).map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`badge ${r.punchType === 'CLOCK_IN' ? 'badge-success' : 'badge-warning'}`}>
                  {r.punchType === 'CLOCK_IN' ? '上班' : '下班'}
                </span>
                <span>{r.clinic?.name || '診所'}</span>
              </div>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {new Date(r.punchTime).toLocaleString('zh-HK')}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
