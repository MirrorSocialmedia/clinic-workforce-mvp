'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Html5Qrcode } from 'html5-qrcode'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

export default function PunchPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('準備中...')
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)
  const [records, setRecords] = useState<any[]>([])
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const scanningRef = useRef(false)

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

  // Punch function wrapped in useCallback + ref to avoid stale closure in scanner
  const doPunch = useCallback(async (token: string) => {
    setStatus('打卡中...')
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
      setResult({ success: true, message: `✅ ${type}打卡成功 ${new Date(data.punchTime).toLocaleTimeString('zh-HK')}` })
      fetchRecords()

      // Resume scanning after success
      setTimeout(() => {
        try { scannerRef.current?.resume() } catch { /* ignore */ }
        scanningRef.current = true
        setStatus('請對準診所 QR 碼')
      }, 1500)
    } catch (e: any) {
      setResult({ success: false, message: `❌ ${e.message}` })
      // Resume scanning after error
      setTimeout(() => {
        try { scannerRef.current?.resume() } catch { /* ignore */ }
        scanningRef.current = true
        setStatus('請對準診所 QR 碼')
      }, 2000)
    }
  }, [fetchRecords])

  // Keep ref updated so scanner callback always uses latest doPunch
  const doPunchRef = useRef(doPunch)
  useEffect(() => { doPunchRef.current = doPunch }, [doPunch])

  // QR Scanner
  useEffect(() => {
    if (!user) return

    setStatus('開啟鏡頭中...')
    const scanner = new Html5Qrcode('qr-reader')
    scannerRef.current = scanner
    let started = false

    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 250 },
      async (decodedText) => {
        // Success callback - auto punch via ref
        if (scanningRef.current && doPunchRef.current) {
          await scanner.pause()
          scanningRef.current = false
          await doPunchRef.current(decodedText)
        }
      },
      () => {} // ignore scan errors
    ).then(() => {
      started = true
      scanningRef.current = true
      setStatus('請對準診所 QR 碼')
    }).catch(() => {
      setStatus('無法開啟鏡頭，請檢查權限')
    })

    return () => {
      if (started) {
        try { scanner.stop() } catch { /* ignore */ }
      }
      try { scanner.clear() } catch { /* ignore */ }
    }
  }, [user])

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

      {/* Info */}
      <div className="bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-800 rounded-lg p-4 mb-6 text-sm text-teal-700 dark:text-teal-300">
        <strong>📋 方式：</strong> 打開頁面 → 鏡頭自動開啟 → 對準診所 QR 碼 → 自動打卡
      </div>

      {/* QR Scanner */}
      <div className="card mb-4">
        <div id="qr-reader" className="w-full rounded-lg overflow-hidden" />
        <p className="text-center mt-3 text-sm text-gray-500">{status}</p>
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
