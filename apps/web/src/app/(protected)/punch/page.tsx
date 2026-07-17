'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { XCircle, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import QrScanner from './components/qr-scanner'
import { fmtTime, fmtDateTime } from '@/lib/hk-date'
import { useFaceCapture } from '@/lib/use-face-capture'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

/** Play a short confirmation beep via Web Audio API */
function playBeep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.value = 0.3
    osc.start()
    osc.stop(ctx.currentTime + 0.18)
  } catch {
    /* 靜音環境忽略 */
  }
}

export default function PunchPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [records, setRecords] = useState<any[]>([])

  // ★ Full-screen punch result state
  const [punchResult, setPunchResult] = useState<{
    type: string
    time: string
    clinicName?: string
  } | null>(null)

  // ★ Countdown for auto-redirect
  const [countdown, setCountdown] = useState(3)

  // Face verification state
  const [faceHint, setFaceHint] = useState<string | null>(null)
  const faceVideoRef = useRef<HTMLVideoElement>(null)
  const { captureQualified } = useFaceCapture()

  // Error banner (inline, not full-screen)
  const [error, setError] = useState<string | null>(null)

  // ★ Scanner restart key
  const [scannerKey, setScannerKey] = useState(0)

  // ★ Scanner stop ref — release rear camera before starting front camera
  const scannerStopRef = useRef<(() => void) | null>(null)

  const handleScannerReady = useCallback((stop: () => void) => {
    scannerStopRef.current = stop
  }, [])

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

  // ★ Punch handler — returns boolean for success/failure feedback
  const handleScan = useCallback(async (token: string): Promise<boolean> => {
    setError(null)

    try {
      const res = await fetch('/api/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          token,
          deviceInfo: navigator.userAgent,
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '打卡失敗')

      // ★ 三重回饋：震動 + 嗶聲 + 全螢幕
      navigator.vibrate?.([80, 40, 80])
      playBeep()

      setPunchResult({
        type: data.punchType === 'CLOCK_IN' ? '上工' : '落班',
        time: fmtTime(data.punchTime),
      })
      setCountdown(3)
      fetchRecords()
      // 停止 QR 掃描器，釋放相機（iOS 同頁只能一條串流）
      scannerStopRef.current?.()
      // Fire-and-forget face verification
      if (data.recordId) runFaceVerify(data.recordId)
      return true
    } catch (e: any) {
      setError(e.message)
      return false
    }
  }, [fetchRecords])

  // Keep ref stable for scanner
  const handleScanRef = useRef(handleScan)
  useEffect(() => { handleScanRef.current = handleScan }, [handleScan])

  // Wrap in a stable function for scanner prop
  const stableOnScan = useCallback(async (token: string): Promise<boolean> => {
    return handleScanRef.current(token)
  }, [])

  // Fire-and-forget face verification after punch
  const runFaceVerify = async (punchId: string) => {
    try {
      setFaceHint('請看鏡頭')
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
      if (faceVideoRef.current) {
        faceVideoRef.current.srcObject = stream
        await faceVideoRef.current.play()
      }
      const blob = await captureQualified(faceVideoRef.current!, 3000)
      stream.getTracks().forEach(t => t.stop())
      const fd = new FormData()
      fd.append('punchId', punchId)
      if (blob) fd.append('frame', blob, 'punch.jpg')
      fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd })
    } catch {
      setFaceHint('臉部驗證略過')
      setTimeout(() => setFaceHint(null), 1500)
      const fd = new FormData()
      fd.append('punchId', punchId)
      fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd })
    } finally {
      setFaceHint(null)
    }
  }

  // ★ Countdown: auto-redirect to dashboard after success
  useEffect(() => {
    if (!punchResult) return
    const t = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(t)
          router.push('/dashboard')
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [punchResult, router])

  if (loading) return <div className="flex justify-center items-center min-h-[200px] text-muted-foreground">載入中...</div>
  if (!user) return null

  return (
    <div className="p-4 space-y-4 max-w-lg mx-auto">
      {/* Page Header */}
      <div>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Smartphone size={22} /> 掃碼打卡</h1>
        <p className="text-sm text-muted-foreground mt-1">對準診所螢幕 QR 碼，自動完成打卡</p>
      </div>

      {/* QR Scanner — compact card, hidden when showing full-screen result */}
      {!punchResult && (
        <div className="bg-card border rounded-xl p-3 max-w-sm mx-auto">
          <QrScanner key={scannerKey} onScan={stableOnScan} onScannerReady={handleScannerReady} />
        </div>
      )}

      {/* Error banner (inline, auto-clears on next scan) */}
      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>失敗</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Recent records */}
      {!punchResult && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">最近記錄</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {records.length === 0 ? (
              <div className="text-muted-foreground text-center py-6">暫無記錄</div>
            ) : (
              <div className="divide-y divide-border">
                {records.slice(0, 10).map((r) => (
                  <div
                    key={r.id}
                    className="flex justify-between items-center py-3 px-4 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={r.punchType === 'CLOCK_IN' ? 'default' : 'secondary'}
                      >
                        {r.punchType === 'CLOCK_IN' ? '上工' : '落班'}
                      </Badge>
                      <span className="text-foreground">{r.clinic?.name || '診所'}</span>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {fmtDateTime(r.punchTime)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Full-screen success overlay ── */}
      {punchResult && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center"
          style={{ background: '#059669' }}
        >
          <div style={{ fontSize: 96, color: '#fff' }}>✓</div>
          <div className="text-white text-3xl font-bold mt-4">
            {punchResult.type}打卡成功
          </div>
          <div className="text-emerald-100 text-xl mt-2 font-mono">
            {punchResult.time}
          </div>

          <button
            onClick={() => router.push('/dashboard')}
            className="mt-10 px-8 py-3 rounded-xl bg-white/20 text-white text-lg"
          >
            返回首頁（{countdown}）
          </button>

          {/* Face verification overlay */}
          {faceHint && (
            <div style={{ position: 'absolute', top: 12, right: 12, width: 120, borderRadius: 12, overflow: 'hidden', background: '#000' }}>
              <video ref={faceVideoRef} muted playsInline style={{ width: '100%' }} />
              <div style={{ fontSize: 11, textAlign: 'center', color: '#fff', padding: 2 }}>{faceHint}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
