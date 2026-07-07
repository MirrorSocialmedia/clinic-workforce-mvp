'use client'

import { useEffect, useState, useCallback } from 'react'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

export default function PunchPage() {
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [records, setRecords] = useState<any[]>([])

  const fetchUserData = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setUser({ role: data.user.role, clinics: data.user.clinicIds || [] })
    } catch {
      // ignore
    }
  }, [])

  const fetchRecords = useCallback(async () => {
    try {
      const res = await fetch('/api/punch/my-records', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setRecords(data.records || [])
      }
    } catch {
      // ignore
    }
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

      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4 text-sm text-blue-700 dark:text-blue-300">
        💡 請用手機對著診所櫃檯螢幕的 QR 碼掃描打卡。
      </div>

      <div className="card mb-4 text-center py-12">
        <p className="text-gray-500">QR 掃描器開發中，預計下一版上線</p>
      </div>

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
