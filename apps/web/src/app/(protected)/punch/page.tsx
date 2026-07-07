'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
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

      const type = data.punchType === 'CLOCK_IN' ? '上班' : '下班'
      setResult({
        success: true,
        message: `✅ ${type}打卡成功 ${new Date(data.punchTime).toLocaleTimeString('zh-HK')}`,
      })
      fetchRecords()
    } catch (e: any) {
      setResult({ success: false, message: `❌ ${e.message}` })
    }
  }, [fetchRecords])

  // Keep ref stable for scanner
  const handleScanRef = useRef(handleScan)
  useEffect(() => { handleScanRef.current = handleScan }, [handleScan])

  // Wrap in a stable function for scanner prop
  const stableOnScan = useCallback(async (token: string) => {
    return handleScanRef.current(token)
  }, [])

  if (loading) return <div className="flex justify-center items-center min-h-[200px]">載入中...</div>
  if (!user) return null

  return (
    <div className="main-content max-w-lg mx-auto">
      <div className="page-header">
        <div>
          <h1 className="text-xl font-bold">📱 掃碼打卡</h1>
          <div className="subtitle">對準診所螢幕 QR 碼，自動完成打卡</div>
        </div>
      </div>

      {/* Instruction */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4 text-sm text-blue-700 dark:text-blue-300">
        💡 請用手機對著診所櫃檯螢幕的 QR 碼掃描打卡。
      </div>

      {/* QR Scanner */}
      <div className="card mb-4">
        <QrScanner onScan={stableOnScan} />
      </div>

      {/* Result */}
      {result && (
        <div className={result.success ? 'success-box' : 'error-box'}>
          {result.message}
        </div>
      )}

      {/* Recent records */}
      <div className="card">
        <h2>最近記錄</h2>
        {records.length === 0 ? (
          <div className="text-muted text-center py-5">暫無記錄</div>
        ) : (
          records.slice(0, 10).map((r) => (
            <div
              key={r.id}
              className="flex justify-between items-center py-2.5 border-b border-gray-100 dark:border-gray-700 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className={`badge ${r.punchType === 'CLOCK_IN' ? 'badge-success' : 'badge-warning'}`}>
                  {r.punchType === 'CLOCK_IN' ? '上班' : '下班'}
                </span>
                <span>{r.clinic?.name || '診所'}</span>
              </div>
              <span className="text-muted text-xs">
                {new Date(r.punchTime).toLocaleString('zh-HK')}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
