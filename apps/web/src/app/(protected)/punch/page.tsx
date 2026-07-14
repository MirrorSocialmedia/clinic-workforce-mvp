'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, XCircle, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import QrScanner from './components/qr-scanner'

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

  // Error banner (inline, not full-screen)
  const [error, setError] = useState<string | null>(null)

  // ★ Scanner restart key
  const [scannerKey, setScannerKey] = useState(0)

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
        time: new Date(data.punchTime).toLocaleTimeString('zh-HK'),
      })
      fetchRecords()
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

  if (loading) return <div className="flex justify-center items-center min-h-[200px] text-muted-foreground">載入中...</div>
  if (!user) return null

  return (
    <div className="p-4 space-y-4 max-w-lg mx-auto">
      {/* Page Header */}
      <div>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Smartphone size={22} /> 掃碼打卡</h1>
        <p className="text-sm text-muted-foreground mt-1">對準診所螢幕 QR 碼，自動完成打卡</p>
      </div>

      {/* Instruction */}
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>提示</AlertTitle>
        <AlertDescription>
          請用手機對著診所櫃檯螢幕的 QR 碼掃描打卡。
        </AlertDescription>
      </Alert>

      {/* QR Scanner — hidden when showing full-screen result */}
      {!punchResult && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">掃描 QR 碼</CardTitle>
          </CardHeader>
          <CardContent>
            <QrScanner key={scannerKey} onScan={stableOnScan} />
          </CardContent>
        </Card>
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
                      {new Date(r.punchTime).toLocaleString('zh-HK')}
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
          <div style={{ fontSize: 96 }}>✓</div>
          <div className="text-white text-3xl font-bold mt-4">
            {punchResult.type}打卡成功
          </div>
          <div className="text-emerald-100 text-xl mt-2 font-mono">
            {punchResult.time}
          </div>

          <button
            onClick={() => {
              setPunchResult(null)
              setScannerKey(k => k + 1)
            }}
            className="mt-10 px-6 py-3 rounded-xl bg-white/20 text-white text-lg"
          >
            再掃一次
          </button>
          <button
            onClick={() => setPunchResult(null)}
            className="mt-3 text-emerald-200 underline"
          >
            完成
          </button>
        </div>
      )}
    </div>
  )
}
