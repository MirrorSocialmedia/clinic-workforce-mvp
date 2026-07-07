'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

export default function ClinicQRPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [clinicId, setClinicId] = useState('')
  const [clinics, setClinics] = useState<any[]>([])
  const [selectedClinicName, setSelectedClinicName] = useState('')
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

  // Update clinic name when clinicId changes
  useEffect(() => {
    if (clinicId) {
      const clinic = clinics.find(c => c.id === clinicId)
      setSelectedClinicName(clinic?.name || '')
    }
  }, [clinicId, clinics])

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

  // Fullscreen handler
  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  if (loading) return null // Silent loading for kiosk
  if (!user) return null

  // Generate QR code image URL
  const qrImageUrl = token
    ? `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(token)}`
    : null

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
      color: '#e2e8f0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* Fullscreen button */}
      <button
        onClick={handleFullscreen}
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          zIndex: 100,
          background: 'rgba(59, 130, 246, 0.8)',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '10px 18px',
          fontSize: 16,
          cursor: 'pointer',
          backdropFilter: 'blur(4px)',
        }}
      >
        {document.fullscreenElement ? '⛶ 離開全螢幕' : '⛶ 全螢幕'}
      </button>

      {/* Top instruction */}
      <div style={{
        textAlign: 'center',
        marginBottom: 32,
        maxWidth: 600,
      }}>
        <div style={{ fontSize: 16, color: '#94a3b8', lineHeight: 1.6 }}>
          此頁供診所櫃檯螢幕顯示。請將此畫面放在櫃檯，員工用手機掃碼打卡。
        </div>
      </div>

      {/* Clinic name */}
      {selectedClinicName && (
        <div style={{
          fontSize: 36,
          fontWeight: 700,
          color: '#f1f5f9',
          marginBottom: 8,
          letterSpacing: 2,
        }}>
          🏥 {selectedClinicName}
        </div>
      )}

      {/* Clinic selector - small and unobtrusive */}
      <div style={{ marginBottom: 24 }}>
        <select
          value={clinicId}
          onChange={(e) => setClinicId(e.target.value)}
          style={{
            background: 'rgba(30, 41, 59, 0.8)',
            color: '#e2e8f0',
            border: '1px solid #334155',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          <option value="">請選擇診所...</option>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* QR Code Display - big and centered */}
      <div style={{
        background: '#ffffff',
        borderRadius: 24,
        padding: 32,
        boxShadow: '0 0 60px rgba(59, 130, 246, 0.15)',
        marginBottom: 24,
      }}>
        {error ? (
          <div style={{ color: '#e74c3c', padding: 20, fontSize: 18 }}>{error}</div>
        ) : qrImageUrl ? (
          <>
            <img
              src={qrImageUrl}
              alt="打卡 QR 碼"
              style={{ width: 320, height: 320, borderRadius: 12 }}
            />
          </>
        ) : (
          <div style={{ color: '#888', padding: 40, fontSize: 18 }}>
            請選擇診所以生成 QR 碼
          </div>
        )}
      </div>

      {/* Countdown */}
      {token && (
        <div style={{
          fontSize: 22,
          fontWeight: 600,
          color: '#60a5fa',
          marginTop: 8,
        }}>
          ⏱️ {countdown} 秒後自動刷新
        </div>
      )}

      {/* Footer info */}
      <div style={{
        marginTop: 32,
        fontSize: 14,
        color: '#64748b',
        textAlign: 'center',
        lineHeight: 1.8,
      }}>
        <div>• QR 碼每 30 秒自動刷新，防止翻拍舊碼</div>
        <div>• 員工用手機開啟「我要打卡」頁面掃描此碼</div>
      </div>
    </div>
  )
}
