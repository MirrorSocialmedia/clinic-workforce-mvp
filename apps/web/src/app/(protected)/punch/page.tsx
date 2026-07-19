'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { XCircle, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import QrScanner from './components/qr-scanner'
import { fmtTime, fmtDateTime } from '@/lib/hk-date'
import { useFaceCapture } from '@/lib/use-face-capture'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

/** Get GPS coords for punch location verification (shadow mode — never blocks punch) */
async function getPunchLocation(): Promise<{ lat?: number; lng?: number; flag?: string }> {
  if (!navigator.geolocation) return { flag: 'NO_GPS' }
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => resolve({ flag: err.code === 1 ? 'DENIED' : 'NO_GPS' }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    )
  })
}

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
  const [faceDone, setFaceDone] = useState(true) // 驗證是否已了結(扣倒數用;預設true)
  const faceVideoRef = useRef<HTMLVideoElement>(null)
  const { captureQualified, captureRaw, warmup } = useFaceCapture()

  // Error banner (inline, not full-screen)
  const [error, setError] = useState<string | null>(null)

  // ★ Scanner restart key
  const [scannerKey, setScannerKey] = useState(0)

  // ★ Scanner stop ref — release rear camera before starting front camera
  const scannerStopRef = useRef<(() => void) | null>(null)

  // ★ Face enrollment status
  const [faceEnrollStatus, setFaceEnrollStatus] = useState<string | null>(null)
  const faceStatusRef = useRef<string | null>(null)
  useEffect(() => {
    fetch('/api/face/my-status', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setFaceEnrollStatus(d.status); faceStatusRef.current = d.status })
      .catch(() => {})
  }, [])

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

  // ★ 背景預熱偵測器(wasm+模型)，打卡時已是熱的
  useEffect(() => { warmup().catch(() => {}) }, [warmup])

  // ★ Punch handler — returns boolean for success/failure feedback
  const handleScan = useCallback(async (token: string): Promise<boolean> => {
    setError(null)

    try {
      // ★ GPS location (shadow mode — never blocks punch)
      const loc = await getPunchLocation()

      const res = await fetch('/api/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          token,
          deviceInfo: navigator.userAgent,
          lat: loc.lat,
          lng: loc.lng,
          geoFlag: loc.flag,
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

      // ★ 判斷是否要驗證臉部(只ACTIVE才開鏡頭)
      // 用 ref 讀當下值 + 現場兜底，防狀態競速
      let fs = faceStatusRef.current
      if (!fs) {
        try {
          const r = await fetch('/api/face/my-status', { credentials: 'include' })
          fs = (await r.json()).status
          faceStatusRef.current = fs
        } catch {}
      }
      const willVerify = !!data.recordId && fs === 'ACTIVE'
      setFaceDone(!willVerify) // 要驗證 → 扣住倒數
      if (data.recordId) {
        if (willVerify) {
          runFaceVerify(data.recordId)
        } else {
          // 未登記/審核中:不開鏡頭、零等待,送無幀請求讓 server 標 NOT_ENROLLED/PENDING_ENROLL
          const fd = new FormData(); fd.append('punchId', data.recordId)
          fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd })
        }
      }
      return true
    } catch (e: any) {
      setError(e.message)
      return false
    }
  }, [fetchRecords, faceEnrollStatus])

  // Keep ref stable for scanner
  const handleScanRef = useRef(handleScan)
  useEffect(() => { handleScanRef.current = handleScan }, [handleScan])

  // Wrap in a stable function for scanner prop
  const stableOnScan = useCallback(async (token: string): Promise<boolean> => {
    return handleScanRef.current(token)
  }, [])

  // ★ Android 相機釋放延遲 — 重試開鏡 (NotReadableError)
  async function openFrontCamera(tries = 4): Promise<MediaStream> {
    let lastErr: any
    for (let i = 0; i < tries; i++) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
      } catch (e: any) {
        lastErr = e
        if (e?.name !== 'NotReadableError' && e?.name !== 'AbortError') throw e // 權限拒絕等不重試
        await new Promise(r => setTimeout(r, 350)) // 等釋放,最多 ~1 秒
      }
    }
    throw lastErr
  }

  // ★ runFaceVerify 全身替換: 8秒死線 + 三種了結(sent / no_face / skipped)
  const runFaceVerify = async (punchId: string) => {
    let outcome: 'sent' | 'no_face' | 'skipped' = 'skipped'
    let fd_reason: string = ''
    let noFaceEvidence: Blob | null = null
    try {
      if (!faceVideoRef.current) throw new Error('face video not mounted')
      setFaceHint('請看鏡頭')
      const stream = await openFrontCamera()
      try {
        faceVideoRef.current.srcObject = stream
        await faceVideoRef.current.play()
        const blob = await captureQualified(faceVideoRef.current, 8000, setFaceHint) // ★ 8 秒死線 + frame guide
        if (blob) {
          setFaceHint('分析中…')
          const fd = new FormData()
          fd.append('punchId', punchId)
          fd.append('frame', blob, 'punch.jpg')
          const r = await fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd, keepalive: true })
          if (r.ok) {
            const j = await r.json()
            setFaceHint(j.status === 'PASS' ? '✅ 驗證通過' : null)
          }
          outcome = 'sent'
        } else {
          outcome = 'no_face' // ★ 相機正常、8秒無合格人臉 = 迴避嫌疑
          fd_reason = 'no_face_8s'
        }
        // ★ 關鏡頭前拍證據幀
        if (outcome === 'no_face' && faceVideoRef.current?.readyState) {
          try { noFaceEvidence = await captureRaw(faceVideoRef.current) } catch {}
        }
      } finally {
        stream.getTracks().forEach(t => t.stop())
      }
    } catch (e: any) {
      outcome = 'skipped'
      if (e?.name === 'NotAllowedError') fd_reason = 'camera_denied'
      else if (e?.name === 'NotReadableError' || e?.name === 'AbortError') fd_reason = 'camera_busy'
      else if (e?.message?.includes('not mounted')) fd_reason = 'ui_not_mounted'
      else fd_reason = 'camera_error'
    }

    if (outcome === 'sent') {
      setFaceHint(null)
    } else {
      if (outcome === 'no_face') {
        const fd = new FormData()
        fd.append('punchId', punchId)
        if (noFaceEvidence) fd.append('frame', noFaceEvidence, 'noface.jpg')
        fd.append('reason', fd_reason || 'no_face_8s')
        fd.append('result', 'NO_FACE')
        await fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd, keepalive: true })
      } else {
        const fd = new FormData()
        fd.append('punchId', punchId)
        fd.append('result', 'SKIPPED')
        if (fd_reason) fd.append('reason', fd_reason)
        await fetch('/api/face/verify-punch', { method: 'POST', credentials: 'include', body: fd, keepalive: true })
      }
      setFaceHint(outcome === 'no_face' ? '未拍攝到人臉' : '臉部驗證略過')
      setTimeout(() => setFaceHint(null), 1500)
    }
    setFaceDone(true) // ★ 任何了結都放行倒數
  }

  // ★ Countdown: auto-redirect to dashboard after success
  // 扣住條件: 有 punchResult AND faceDone(驗證已了結)
  useEffect(() => {
    if (!punchResult || !faceDone) return
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
  }, [punchResult, faceDone, router])

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

      {/* ── Face enrollment status ── */}
      {!punchResult && (
        <div style={{ marginTop: 24, textAlign: 'center', fontSize: 13, paddingBottom: 16 }}>
          {faceEnrollStatus === 'NOT_ENROLLED' && (
            <Link href="/my/face-enroll" className="underline text-primary">🪪 登記臉部識別</Link>
          )}
          {faceEnrollStatus === 'PENDING' && (
            <span className="text-muted-foreground">🕐 臉部登記審核中，核准後自動生效</span>
          )}
          {faceEnrollStatus === 'ACTIVE' && (
            <span className="text-muted-foreground">
              ✅ 臉部識別已啟用 · <Link href="/my/face-enroll" className="underline">重新登記</Link>
            </span>
          )}
        </div>
      )}

      {/* ── Face verification window: always-mounted, display toggled ── */}
      <div style={{
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
        width: 'min(78vw, 320px)', zIndex: 60,
        borderRadius: 16, overflow: 'hidden', background: '#000',
        boxShadow: '0 8px 30px rgba(0,0,0,.45)',
        display: faceHint ? 'block' : 'none',
      }}>
        <div style={{ position: 'relative' }}>
          <video ref={faceVideoRef} muted playsInline style={{ width: '100%', transform: 'scaleX(-1)', display: 'block' }} />
          {/* 人形框:橢圓透明窗 + 四周壓暗 */}
          <div style={{
            position: 'absolute', left: '50%', top: '48%', transform: 'translate(-50%, -50%)',
            width: '62%', height: '78%', borderRadius: '50%',
            border: '2.5px dashed rgba(255,255,255,.85)',
            boxShadow: '0 0 0 999px rgba(0,0,0,.45)',
            pointerEvents: 'none',
          }} />
        </div>
        <div style={{ fontSize: 14, textAlign: 'center', color: '#fff', padding: '8px 0' }}>{faceHint}</div>
      </div>

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
        </div>
      )}
    </div>
  )
}
