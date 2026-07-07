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
  const [selectedClinic, setSelectedClinic] = useState<any>(null)
  const [countdown, setCountdown] = useState(30)
  const [error, setError] = useState('')
  const [, setRefreshTick] = useState(0)

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
      setRefreshTick(t => t + 1)
    } catch (err: any) {
      setError(err.message || 'Failed to generate token')
    }
  }, [clinicId])

  useEffect(() => { fetchUserData() }, [fetchUserData])

  useEffect(() => {
    if (user) {
      fetchClinics()
      fetchToken()
    }
  }, [user, fetchClinics, fetchToken])

  useEffect(() => {
    if (user) setLoading(false)
  }, [user])

  // When clinic list loads, set selected clinic name
  useEffect(() => {
    if (clinics.length > 0 && clinicId) {
      const c = clinics.find(cl => cl.id === clinicId)
      if (c) setSelectedClinic(c)
    }
  }, [clinics, clinicId])

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

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-white">
      <div className="text-gray-400 text-lg">載入中...</div>
    </div>
  )
  if (!user) return null

  const qrImageUrl = token
    ? `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(token)}`
    : null

  return (
    <div className="fixed inset-0 bg-white flex flex-col items-center justify-center p-4 select-none" style={{ zIndex: 9999 }}>
      {/* Top instruction bar */}
      <div className="absolute top-0 left-0 right-0 bg-gray-50 border-b border-gray-200 px-6 py-3 text-center">
        <p className="text-sm text-gray-600">
          此頁供診所櫃檯螢幕顯示。請將此畫面放在櫃檯，員工用手機掃碼打卡。
        </p>
      </div>

      {/* Clinic selector (only when loading or no token) */}
      {!token && (
        <div className="mb-6 w-full max-w-xs">
          <label className="block text-sm font-medium text-gray-700 mb-2 text-center">選擇診所</label>
          <select
            value={clinicId}
            onChange={(e) => setClinicId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">請選擇診所...</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Clinic name */}
      {selectedClinic && (
        <h1 className="text-2xl font-bold text-gray-800 mb-2">
          {selectedClinic.name}
        </h1>
      )}

      {/* QR Code */}
      <div className="flex flex-col items-center">
        {error ? (
          <div className="text-red-500 text-lg">{error}</div>
        ) : qrImageUrl ? (
          <>
            <div className="bg-white p-4 rounded-2xl shadow-lg border-2 border-gray-200">
              <img
                src={qrImageUrl}
                alt="QR Code"
                className="w-80 h-80"
              />
            </div>

            {/* Countdown */}
            <div className="mt-6 flex items-center gap-2 text-gray-500 text-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{countdown} 秒後自動刷新</span>
            </div>
          </>
        ) : (
          <div className="text-gray-400 text-lg">
            請選擇診所以生成 QR 碼
          </div>
        )}
      </div>

      {/* Fullscreen button */}
      <button
        onClick={toggleFullscreen}
        className="absolute bottom-6 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg text-sm transition-colors flex items-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
        全螢幕
      </button>
    </div>
  )
}
