'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, XCircle, Smartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import QrScanner from './components/qr-scanner'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

export default function PunchPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)
  const [records, setRecords] = useState<any[]>([])

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

  // Punch handler — called by scanner after QR decode
  const handleScan = useCallback(async (token: string) => {
    setResult(null)

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

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '打卡失敗')

      const type = data.punchType === 'CLOCK_IN' ? '上工' : '落班'
      setResult({
        success: true,
        message: `${type}打卡成功 ${new Date(data.punchTime).toLocaleTimeString('zh-HK')}`,
      })
      fetchRecords()
    } catch (e: any) {
      setResult({ success: false, message: e.message })
    }
  }, [fetchRecords])

  // Keep ref stable for scanner
  const handleScanRef = useRef(handleScan)
  useEffect(() => { handleScanRef.current = handleScan }, [handleScan])

  // Wrap in a stable function for scanner prop
  const stableOnScan = useCallback(async (token: string) => {
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

      {/* QR Scanner */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">掃描 QR 碼</CardTitle>
        </CardHeader>
        <CardContent>
          <QrScanner onScan={stableOnScan} />
        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <Alert variant={result.success ? 'default' : 'destructive'}>
          {result.success ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          <AlertTitle>{result.success ? '成功' : '失敗'}</AlertTitle>
          <AlertDescription>{result.message}</AlertDescription>
        </Alert>
      )}

      {/* Recent records */}
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
    </div>
  )
}
