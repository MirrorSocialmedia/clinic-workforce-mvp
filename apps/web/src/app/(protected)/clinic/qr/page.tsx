'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'

export default function ClinicQRPage() {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [clinicId, setClinicId] = useState('')
  const [clinics, setClinics] = useState<any[]>([])
  const [countdown, setCountdown] = useState(30)
  const [error, setError] = useState('')

  const fetchUserData = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) { router.push('/login'); return }
      const data = await res.json()
      setUser(data.user)
      if (data.user.clinicIds?.length > 0 && !clinicId) {
        setClinicId(data.user.clinicIds[0])
      }
    } catch { router.push('/login') }
  }, [router, clinicId])

  const fetchClinics = useCallback(async () => {
    try {
      const res = await fetch('/api/clinics', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setClinics(data.clinics || [])
      }
    } catch {}
  }, [])

  const fetchToken = useCallback(async () => {
    if (!clinicId) return

    try {
      setError('')
      const res = await fetch(`/api/qr-tokens?clinicId=${clinicId}`, { credentials: 'include' })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to generate token')
        return
      }
      const data = await res.json()
      setToken(data.token)
      setExpiresAt(data.expiresAt)
      setCountdown(30)
    } catch (err: any) {
      setError(err.message || 'Failed to generate token')
    }
  }, [clinicId])

  useEffect(() => {
    fetchUserData()
  }, [fetchUserData])

  useEffect(() => {
    if (user) {
      fetchClinics()
      fetchToken()
    }
  }, [user, fetchClinics, fetchToken])

  useEffect(() => {
    if (user) setLoading(false)
  }, [user])

  // Countdown timer
  useEffect(() => {
    if (!token) return
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchToken()
          return 30
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [token, clinicId])

  if (loading) return <div style={{ padding: 20 }}>載入中...</div>
  if (!user) return null

  // Generate QR code image URL using a public API
  const qrImageUrl = token
    ? `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(token)}`
    : null

  return (
    <div style={{ padding: 20, maxWidth: 400, margin: '0 auto', textAlign: 'center' }}>
      <h1 style={{ marginBottom: 8 }}>🏥 診所打卡 QR 碼</h1>
      <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>
        員工掃碼打卡 — QR 碼每 30 秒自動刷新
      </p>

      {/* Clinic selector */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>選擇診所</label>
        <select
          value={clinicId}
          onChange={(e) => setClinicId(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 14 }}
        >
          <option value="">請選擇診所...</option>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* QR Code Display */}
      <div style={{
        background: '#fff', borderRadius: 12, padding: 24,
        border: '2px solid #3498db', marginBottom: 20,
      }}>
        {error ? (
          <div style={{ color: '#e74c3c', padding: 20 }}>{error}</div>
        ) : qrImageUrl ? (
          <>
            <img
              src={qrImageUrl}
              alt="QR Code"
              style={{ width: 280, height: 280, borderRadius: 8 }}
            />
            <div style={{
              marginTop: 16, padding: '8px 12px',
              background: '#eafaf1', borderRadius: 6,
              fontSize: 14, color: '#27ae60', fontWeight: 'bold',
            }}>
              ⏱️ {countdown} 秒後自動刷新
            </div>
            <div style={{
              marginTop: 8, fontSize: 11, color: '#888',
              wordBreak: 'break-all',
            }}>
              Token: {token.slice(0, 16)}...
            </div>
          </>
        ) : (
          <div style={{ color: '#888', padding: 20 }}>
            請選擇診所以生成 QR 碼
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{
        background: '#fef9e7', borderRadius: 8, padding: 16,
        fontSize: 12, color: '#7d6608', textAlign: 'left',
        border: '1px solid #f9e79f',
      }}>
        <div style={{ fontWeight: 'bold', marginBottom: 6 }}>📋 說明</div>
        <div>• QR 碼每 30 秒自動刷新，防止翻拍舊碼</div>
        <div>• 員工打卡時需選擇上班/下班</div>
        <div>• 原始打卡記錄不可修改，所有修正留痕</div>
      </div>
    </div>
  )
}
