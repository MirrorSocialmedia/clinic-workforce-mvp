'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'

export default function ClinicQRPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [clinicId, setClinicId] = useState('')
  const [clinics, setClinics] = useState<any[]>([])
  const [selectedClinic, setSelectedClinic] = useState<{ id: string; name: string } | null>(null)
  const [countdown, setCountdown] = useState(30)
  const [error, setError] = useState('')
  const [isKiosk, setIsKiosk] = useState(false)
  const prevTokenRef = useRef('')

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
      const newToken = data.token
      setToken(newToken)
      setCountdown(30)
      // Only reset kiosk if token actually changed
      if (prevTokenRef.current !== newToken && prevTokenRef.current) {
        setIsKiosk(true)
      }
      prevTokenRef.current = newToken
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

  // Countdown timer — refresh when hitting 0
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

  // Update selectedClinic when clinicId changes
  useEffect(() => {
    if (clinicId) {
      const found = clinics.find(c => c.id === clinicId)
      if (found) setSelectedClinic({ id: found.id, name: found.name })
    }
  }, [clinicId, clinics])

  // Enter fullscreen
  const handleFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen()
    } catch {
      // ignore
    }
  }

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-gray-950 text-gray-400">
      載入中...
    </div>
  )
  if (!user) return null

  const qrImageUrl = token
    ? `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(token)}`
    : null

  // ─── Kiosk mode (fullscreen QR) ───
  if (isKiosk && qrImageUrl) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950 text-white select-none">
        {/* Exit kiosk hint */}
        <button
          onClick={() => setIsKiosk(false)}
          className="absolute top-4 right-4 text-gray-500 hover:text-white text-xs px-3 py-1 rounded border border-gray-700"
        >
          ✕ 退出全屏
        </button>

        {/* Clinic name */}
        <h1 className="text-3xl font-bold mb-8 text-center">
          🏥 {selectedClinic?.name || '診所'}
        </h1>

        {/* QR Code — 320px */}
        <div className="bg-white rounded-2xl p-6 shadow-2xl">
          <img
            src={qrImageUrl}
            alt="QR Code"
            className="w-[320px] h-[320px] rounded-xl"
          />
        </div>

        {/* Countdown */}
        <div className="mt-8 text-xl text-gray-300 font-mono">
          ⏱️ {countdown} 秒後自動刷新
        </div>

        {/* Decorative line */}
        <div className="mt-12 text-sm text-gray-600">
          請用手機掃描 QR 碼打卡
        </div>
      </div>
    )
  }

  // ─── Setup mode (select clinic, enter kiosk) ───
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">
      {/* Header */}
      <div className="max-w-md w-full text-center mb-8">
        <h1 className="text-2xl font-bold mb-3">🖥 診所打卡螢幕</h1>
        <p className="text-gray-400 text-sm leading-relaxed">
          此頁供診所櫃檯螢幕顯示。請將此畫面放在櫃檯，員工用手機掃碼打卡。
        </p>
      </div>

      {/* Clinic selector */}
      <div className="max-w-md w-full mb-6">
        <label className="block text-sm text-gray-400 mb-2 text-left">
          選擇診所
        </label>
        <select
          value={clinicId}
          onChange={(e) => {
            setClinicId(e.target.value)
            setIsKiosk(false)
          }}
          className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-4 py-3 text-lg focus:outline-none focus:ring-2 focus:ring-brand"
        >
          <option value="">請選擇診所...</option>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* QR Preview */}
      {error ? (
        <div className="max-w-md w-full bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-400 text-center">
          {error}
        </div>
      ) : qrImageUrl ? (
        <div className="max-w-md w-full bg-gray-900 border border-gray-700 rounded-xl p-6 text-center">
          <img
            src={qrImageUrl}
            alt="QR Code"
            className="w-[240px] h-[240px] mx-auto rounded-lg mb-4"
          />
          <div className="text-green-400 font-semibold text-lg mb-1">
            ⏱️ {countdown} 秒後自動刷新
          </div>
          <div className="text-gray-500 text-xs font-mono break-all">
            Token: {token.slice(0, 16)}...
          </div>

          {/* Enter kiosk button */}
          <button
            onClick={() => setIsKiosk(true)}
            className="mt-6 w-full bg-brand hover:bg-brand/80 text-white font-bold py-3 px-6 rounded-lg text-lg transition-colors"
          >
            🖥 進入全螢幕櫃檯模式
          </button>
        </div>
      ) : (
        <div className="max-w-md w-full bg-gray-900 border border-gray-700 rounded-xl p-8 text-center text-gray-500">
          請選擇診所以生成 QR 碼
        </div>
      )}

      {/* Fullscreen button (top-right) */}
      <button
        onClick={handleFullscreen}
        className="mt-6 text-gray-400 hover:text-white text-sm border border-gray-700 rounded-lg px-4 py-2 transition-colors"
      >
        ⛶ 瀏覽器全螢幕
      </button>

      {/* Info */}
      <div className="max-w-md w-full mt-8 bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-400 text-left">
        <div className="font-bold mb-2 text-gray-300">📋 說明</div>
        <div>• QR 碼每 30 秒自動刷新，防止翻拍舊碼</div>
        <div>• 點擊「進入全螢幕櫃檯模式」隱藏操作選項</div>
        <div>• 員工用手機掃描 QR 碼即可完成打卡</div>
      </div>
    </div>
  )
}
