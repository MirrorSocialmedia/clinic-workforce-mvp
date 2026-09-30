'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import QRCode from 'qrcode'
import { QR_REFRESH_SECONDS } from '@/lib/qr-constants'

// ★ 2026-09-30 F-01：iPad 斷線唔可以靜默顯示過期碼（之前成間診所一齊打唔到卡，員工仲以為自己掃錯）
//   · 攞碼失敗 → 退避重試 2s/4s/8s/10s（唔再等 12 秒）
//   · 用伺服器 expiresAt 判斷過期；過期 → 紅屏，唔顯示舊碼
//   · 未過期但連線失敗 → 照顯示 QR（仲用得），加黃色提示（盡量唔擋打卡）
//   · 401 → 去登入；403（例如 IP 白名單）→ 紅屏顯示伺服器原文
//   · 返前台／網絡恢復 → 即刻攞新碼
const FETCH_TIMEOUT_MS = 8000
const RETRY_STEPS_MS = [2000, 4000, 8000, 10000]

export default function ClinicQRPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [shortCode, setShortCode] = useState('')
  const [expiresAt, setExpiresAt] = useState(0) // ★ 伺服器 expiresAt（ms）；0 = 未有碼
  const [clinicId, setClinicId] = useState('')
  const [clinics, setClinics] = useState<any[]>([])
  const [selectedClinic, setSelectedClinic] = useState<{ id: string; name: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState('')
  const [isKiosk, setIsKiosk] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const prevTokenRef = useRef('')
  const nextFetchAtRef = useRef(0) // 0 = 即刻攞；Infinity = 攞緊
  const failCountRef = useRef(0)
  const genRef = useRef(0)         // 轉診所時作廢舊請求

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

  const fetchToken = useCallback(async (gen: number): Promise<boolean> => {
    if (!clinicId) return false
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`/api/qr-tokens?clinicId=${clinicId}`, { credentials: 'include', cache: 'no-store', signal: ctrl.signal })
      if (gen !== genRef.current) return false
      if (res.status === 401) { window.location.href = '/login'; return false }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || `攞 QR 失敗（HTTP ${res.status}）`); return false }
      setError('')
      setToken(data.token)
      setShortCode(data.shortCode || '')
      setExpiresAt(Date.parse(data.expiresAt))
      // Only reset kiosk if token actually changed
      if (prevTokenRef.current !== data.token && prevTokenRef.current) setIsKiosk(true)
      prevTokenRef.current = data.token
      return true
    } catch (err: any) {
      if (gen !== genRef.current) return false
      setError(err?.name === 'AbortError' ? '連線逾時' : (err?.message || '網絡錯誤'))
      return false
    } finally {
      clearTimeout(t)
    }
  }, [clinicId])

  useEffect(() => {
    fetchUserData()
  }, [fetchUserData])

  useEffect(() => {
    if (user) fetchClinics() // ★ 攞碼交俾下面嘅排程，唔喺度直接 call
  }, [user, fetchClinics])

  useEffect(() => {
    if (user) setLoading(false)
  }, [user])

  // ★ 每秒 tick + 返前台／網絡恢復即刻攞碼
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    const kick = () => {
      if (document.visibilityState !== 'visible') return
      if (Number.isFinite(nextFetchAtRef.current)) nextFetchAtRef.current = 0 // 攞緊（Infinity）就唔好再開多個請求
      setNow(Date.now())
    }
    document.addEventListener('visibilitychange', kick)
    window.addEventListener('online', kick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', kick)
      window.removeEventListener('online', kick)
    }
  }, [])

  // ★ 轉診所 → 作廢舊請求、即刻攞新碼（一定要喺下面個排程 effect 之前）
  useEffect(() => {
    genRef.current++
    nextFetchAtRef.current = 0
    failCountRef.current = 0
    setExpiresAt(0)
  }, [clinicId])

  // ★ 排程：到鐘先攞；成功 → 12 秒後再攞；失敗 → 退避重試（唔 reset 倒數扮正常）
  useEffect(() => {
    if (!user || !clinicId) return
    if (now < nextFetchAtRef.current) return
    nextFetchAtRef.current = Infinity
    const gen = genRef.current
    fetchToken(gen).then(ok => {
      if (gen !== genRef.current) return
      if (ok) {
        failCountRef.current = 0
        nextFetchAtRef.current = Date.now() + QR_REFRESH_SECONDS * 1000
      } else {
        const i = Math.min(failCountRef.current, RETRY_STEPS_MS.length - 1)
        failCountRef.current++
        nextFetchAtRef.current = Date.now() + RETRY_STEPS_MS[i]
      }
      setNow(Date.now())
    })
  }, [now, user, clinicId, fetchToken])

  // Update selectedClinic when clinicId changes
  useEffect(() => {
    if (clinicId) {
      const found = clinics.find(c => c.id === clinicId)
      if (found) setSelectedClinic({ id: found.id, name: found.name })
    }
  }, [clinicId, clinics])

  // ★ All hooks must be before any early return (#310 fix)
  const qrDisplayText = shortCode || token
  useEffect(() => {
    if (!qrDisplayText) {
      setQrDataUrl('')
      return
    }
    QRCode.toDataURL(qrDisplayText, {
      width: 400,
      margin: 4,
      errorCorrectionLevel: 'M',
    }).then(setQrDataUrl).catch(console.error)
  }, [qrDisplayText])

  const handleFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen()
    } catch {
      // ignore
    }
  }

  const nextAt = nextFetchAtRef.current
  const countdown = Number.isFinite(nextAt) ? Math.max(0, Math.ceil((nextAt - now) / 1000)) : 0
  const expired = expiresAt > 0 && now >= expiresAt
  const validSecLeft = expiresAt > 0 ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-gray-950 text-gray-400">
      載入中...
    </div>
  )
  if (!user) return null

  // ─── Kiosk mode (fullscreen QR) ───
  if (isKiosk && qrDataUrl) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950 text-white select-none">
        <button
          onClick={() => setIsKiosk(false)}
          className="absolute top-4 right-4 text-gray-500 hover:text-white text-xs px-3 py-1 rounded border border-gray-700"
        >
          ✕ 退出全屏
        </button>

        <h1 className="text-3xl font-bold mb-8 text-center">
          {selectedClinic?.name || '診所'}
        </h1>

        {expired ? (
          // ★ F-01：過期就唔好再顯示舊碼 —— 員工掃咗都係失敗，仲會以為自己掃錯
          <div className="w-[368px] h-[368px] rounded-2xl bg-red-700 flex flex-col items-center justify-center text-center p-6 shadow-2xl">
            <div className="text-6xl mb-4">⚠️</div>
            <div className="text-2xl font-bold">QR 暫時用唔到</div>
            <div className="mt-3 text-red-100">iPad 連唔到伺服器，{countdown} 秒後自動再試…</div>
            {error && <div className="mt-3 text-xs text-red-200 break-all">{error}</div>}
            <div className="mt-4 text-xs text-red-200">持續出現請檢查 iPad Wi-Fi，或者重新開呢頁</div>
          </div>
        ) : (
          <div className="bg-white rounded-2xl p-6 shadow-2xl">
            <img src={qrDataUrl} alt="QR Code" className="w-[320px] h-[320px] rounded-xl" />
          </div>
        )}

        {!expired && error && (
          <div className="mt-4 text-amber-300 text-sm">
            ⚠️ 連線唔穩定，重試中…（呢個碼仲有效 {validSecLeft} 秒）
          </div>
        )}

        {!expired && shortCode && (
          <div className="mt-4 bg-gray-800/60 rounded-lg px-6 py-3">
            <span className="text-gray-400 text-sm">手動輸入碼：</span>
            <span className="text-2xl font-mono tracking-[0.5em] text-white ml-2 uppercase">{shortCode}</span>
          </div>
        )}

        {!expired && (
          <div className="mt-8 text-xl text-gray-300 font-mono">
            ⏱️ {countdown} 秒後自動刷新
          </div>
        )}

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
      ) : qrDataUrl ? (
        <div className="max-w-md w-full bg-gray-900 border border-gray-700 rounded-xl p-6 text-center">
          <img
            src={qrDataUrl}
            alt="QR Code"
            className="w-[240px] h-[240px] mx-auto rounded-lg mb-4"
          />
          {expired && <div className="text-red-400 text-sm mb-2">⚠️ 碼已過期，重新連線中…</div>}
          <div className="text-green-400 font-semibold text-lg mb-1">
            ⏱️ {countdown} 秒後自動刷新
          </div>
          {shortCode && (
            <div className="text-gray-300 text-sm font-mono tracking-widest mb-1 uppercase">
              短碼：{shortCode}
            </div>
          )}
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
        <div>• QR 碼每 ${QR_REFRESH_SECONDS} 秒自動刷新，防止翻拍舊碼</div>
        <div>• 點擊「進入全螢幕櫃檯模式」隱藏操作選項</div>
        <div>• 員工用手機掃描 QR 碼即可完成打卡</div>
      </div>
    </div>
  )
}
