'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { fmtDate, fmtDateTime } from '@/lib/hk-date'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

export default function HashPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [clinics, setClinics] = useState<any[]>([])
  const [selectedClinic, setSelectedClinic] = useState('')
  const [hashes, setHashes] = useState<any[]>([])
  const [hashLoading, setHashLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [verifyResult, setVerifyResult] = useState<any>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [dateRange, setDateRange] = useState({ start: '', end: '' })

  const fetchUserData = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) { router.push('/login'); return }
      const data = await res.json()
      setUser({ role: data.user.role, clinics: data.user.clinicIds || [] })
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

  const fetchHashes = useCallback(async () => {
    if (!selectedClinic) return

    setHashLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ clinicId: selectedClinic })
      if (dateRange.start) params.set('startDate', dateRange.start)
      if (dateRange.end) params.set('endDate', dateRange.end)

      const res = await fetch(`/api/daily-hash?${params}`, { credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `伺服器錯誤 (${res.status})`)
      }
      const data = await res.json()
      setHashes(data.hashes || [])
    } catch (err: any) {
      setError(err.message || '載入失敗')
    } finally {
      setHashLoading(false)
    }
  }, [selectedClinic, dateRange])

  const generateHash = useCallback(async () => {
    if (!selectedClinic || !selectedDate) return

    setGenerating(true)
    try {
      const res = await fetch('/api/daily-hash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ clinicId: selectedClinic, date: selectedDate }),
      })

      const data = await res.json()

      if (!res.ok) {
        alert(data.error || '生成完整性指紋失敗')
        return
      }

      alert(`完整性指紋生成成功！記錄數：${data.recordCount}`)
      fetchHashes()
    } finally {
      setGenerating(false)
    }
  }, [selectedClinic, selectedDate, fetchHashes])

  const verifyHash = useCallback(async () => {
    if (!selectedClinic || !selectedDate) return

    try {
      const res = await fetch(
        `/api/daily-hash/${selectedDate}?clinicId=${selectedClinic}&verify=true`,
        { credentials: 'include' }
      )

      if (res.ok) {
        const data = await res.json()
        setVerifyResult(data)
      }
    } catch {
      alert('驗證失敗')
    }
  }, [selectedClinic, selectedDate])

  useEffect(() => {
    fetchUserData()
  }, [fetchUserData])

  useEffect(() => {
    if (user) fetchClinics()
  }, [user, fetchClinics])

  useEffect(() => {
    if (user) setLoading(false)
  }, [user])

  useEffect(() => {
    if (selectedClinic) fetchHashes()
  }, [selectedClinic, fetchHashes])

  if (loading) return <div style={{ padding: 20 }}>載入中...</div>
  if (!user) return null
  if (error) return <div style={{ padding: 24, color: '#c00' }}>⚠️ {error}</div>

  return (
    <div style={{ padding: 20 }}>
      <h1 style={{ marginBottom: 8 }}>🔒 考勤完整性驗證</h1>
      <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>
        考勤完整性驗證確保打卡記錄完整性 — 所有記錄的 SHA-256 指紋，改動後可重算比對
      </p>

      {/* Clinic selector */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>選擇診所</label>
        <select
          value={selectedClinic}
          onChange={(e) => setSelectedClinic(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 4, border: '1px solid #ddd', fontSize: 14 }}
        >
          <option value="">請選擇診所...</option>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Generate hash */}
      {['OWNER', 'MANAGER'].includes(user.role) && (
        <div style={{
          background: '#f9f9f9', borderRadius: 8, padding: 16,
          marginBottom: 20, border: '1px solid #eee',
        }}>
          <h3 style={{ marginTop: 0, fontSize: 14 }}>🔧 生成完整性指紋</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>日期</label>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
              />
            </div>
            <button
              onClick={generateHash}
              disabled={generating || !selectedDate}
              style={{
                padding: '8px 16px', borderRadius: 4, border: 'none',
                background: generating || !selectedDate ? '#ccc' : '#3498db',
                color: '#fff', cursor: generating || !selectedDate ? 'not-allowed' : 'pointer',
              }}
            >
              {generating ? '生成中...' : '生成完整性指紋'}
            </button>
          </div>
        </div>
      )}

      {/* Verify hash */}
      <div style={{
        background: '#fef9e7', borderRadius: 8, padding: 16,
        marginBottom: 20, border: '1px solid #f9e79f',
      }}>
        <h3 style={{ marginTop: 0, fontSize: 14 }}>🔍 驗證完整性指紋</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>日期</label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
            />
          </div>
          <button
            onClick={verifyHash}
            disabled={!selectedDate}
            style={{
              padding: '8px 16px', borderRadius: 4, border: 'none',
              background: !selectedDate ? '#ccc' : '#27ae60',
              color: '#fff', cursor: !selectedDate ? 'not-allowed' : 'pointer',
            }}
          >
            驗證
          </button>
        </div>

        {verifyResult && (
          <div style={{
            marginTop: 12, padding: '12px 16px', borderRadius: 6,
            background: verifyResult.valid ? '#eafaf1' : '#fdedec',
            border: `1px solid ${verifyResult.valid ? '#a9dfbf' : '#f5b7b1'}`,
          }}>
            <div style={{ fontWeight: 'bold', marginBottom: 6 }}>
              {verifyResult.valid ? '✅ 完整性指紋一致 — 記錄完整' : '❌ 完整性指紋不一致 — 記錄可能被改動'}
            </div>
            {verifyResult.storedHash && (
              <div style={{ fontSize: 11, color: '#888', wordBreak: 'break-all' }}>
                儲存：{verifyResult.storedHash}
              </div>
            )}
            {verifyResult.computedHash && (
              <div style={{ fontSize: 11, color: '#888', wordBreak: 'break-all' }}>
                計算：{verifyResult.computedHash}
              </div>
            )}
            {verifyResult.recordCount && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                記錄數：{verifyResult.recordCount}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Hash list */}
      <div>
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>完整性指紋記錄</h3>

        {/* Date range filter */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>起始日期</label>
            <input
              type="date"
              value={dateRange.start}
              onChange={(e) => setDateRange((prev) => ({ ...prev, start: e.target.value }))}
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>結束日期</label>
            <input
              type="date"
              value={dateRange.end}
              onChange={(e) => setDateRange((prev) => ({ ...prev, end: e.target.value }))}
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd' }}
            />
          </div>
          <button
            onClick={() => { setDateRange({ start: '', end: '' }); fetchHashes() }}
            style={{
              padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd',
              background: '#f5f5f5', cursor: 'pointer',
            }}
          >
            清除
          </button>
        </div>

        {hashLoading ? (
          <p style={{ color: '#888' }}>載入中...</p>
        ) : hashes.length === 0 ? (
          <p style={{ color: '#888' }}>沒有完整性指紋記錄。需要先生成。</p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #eee' }}>
                  <th style={{ textAlign: 'left', padding: '8px 12px' }}>日期</th>
                  <th style={{ textAlign: 'left', padding: '8px 12px' }}>診所</th>
                  <th style={{ textAlign: 'left', padding: '8px 12px' }}>完整性指紋</th>
                  <th style={{ textAlign: 'left', padding: '8px 12px' }}>記錄數</th>
                  <th style={{ textAlign: 'left', padding: '8px 12px' }}>生成時間</th>
                </tr>
              </thead>
              <tbody>
                {hashes.map((h) => (
                  <tr key={h.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '8px 12px' }}>{fmtDate(h.date)}</td>
                    <td style={{ padding: '8px 12px' }}>{h.clinic?.name || h.clinicId}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11 }}>{h.hash.slice(0, 24)}...</td>
                    <td style={{ padding: '8px 12px' }}>{h.recordCount} 筆</td>
                    <td style={{ padding: '8px 12px', color: '#888', fontSize: 12 }}>{fmtDateTime(h.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {hashes.map((h) => (
                <div key={h.id} className="rounded-xl border shadow-card p-3">
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-semibold">{fmtDate(h.date)}</span>
                    <span className="text-sm">{h.recordCount} 筆</span>
                  </div>
                  <div className="text-xs text-muted-foreground mb-1">{h.clinic?.name || h.clinicId}</div>
                  <div className="text-xs font-mono text-muted-foreground break-all">{h.hash.slice(0, 32)}...</div>
                  <div className="text-xs text-muted-foreground mt-1">{fmtDateTime(h.createdAt)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
