'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

interface PunchRecord {
  id: string
  employeeId: string
  clinicId: string
  punchTime: string
  punchType: string
  source: string
  tokenValid: boolean | null
  deviceInfo: string | null
  notes: string | null
  createdAt: string
  employee: {
    user: { name: string; phone: string }
  }
  clinic: { id: string; name: string }
  corrections: any[]
}

export default function AttendancePage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [records, setRecords] = useState<PunchRecord[]>([])
  const [clinics, setClinics] = useState<{ id: string; name: string }[]>([])
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [error, setError] = useState('')
  const [showCorrectionModal, setShowCorrectionModal] = useState(false)
  const [correctionRecord, setCorrectionRecord] = useState<PunchRecord | null>(null)
  const [correctionForm, setCorrectionForm] = useState({ time: '', reason: '' })
  const [submittingCorrection, setSubmittingCorrection] = useState(false)

  // Filters
  const [clinicFilter, setClinicFilter] = useState('')
  const [employeeFilter, setEmployeeFilter] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const fetchUserData = async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) { router.push('/login'); return }
      const data = await res.json()
      setUser({ role: data.user.role, clinics: data.user.clinicIds || [] })
    } catch { router.push('/login') }
  }

  const fetchClinics = async () => {
    try {
      const res = await fetch('/api/clinics', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setClinics(data.clinics || [])
      }
    } catch {}
  }

  const fetchEmployees = async () => {
    try {
      const res = await fetch('/api/employees', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setEmployees((data.employees || []).map((e: any) => ({
          id: e.id,
          name: e.user?.name || e.id,
        })))
      }
    } catch {}
  }

  const fetchRecords = async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
      })
      if (clinicFilter) params.set('clinicId', clinicFilter)
      if (employeeFilter) params.set('employeeId', employeeFilter)
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)

      const res = await fetch(`/api/punches?${params}`, { credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `伺服器錯誤 (${res.status})`)
      }
      const data = await res.json()
      setRecords(data.records || [])
      setTotal(data.total || 0)
    } catch (err: any) {
      setError(err.message || '載入失敗')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUserData()
  }, [])

  useEffect(() => {
    if (user) {
      fetchClinics()
      fetchEmployees()
    }
  }, [user])

  useEffect(() => {
    if (user) fetchRecords()
  }, [user, page, clinicFilter, employeeFilter, startDate, endDate])

  if (!user) return <div style={{ padding: 20 }}>Loading...</div>
  if (error) return <div style={{ padding: 24, color: '#c00' }}>⚠️ {error}</div>

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="p-6" style={{ maxWidth: '1200px' }}>
      <h1 className="text-2xl font-bold text-foreground tracking-tight mb-6">📋 考勤記錄</h1>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap items-end">
        <div>
          <label className="block text-xs g text-muted-foreground mb-1 font-medium">診所</label>
          <select
            value={clinicFilter}
            onChange={(e) => { setClinicFilter(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          >
            <option value="">全部</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs g text-muted-foreground mb-1 font-medium">員工</label>
          <select
            value={employeeFilter}
            onChange={(e) => { setEmployeeFilter(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          >
            <option value="">全部</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs g text-muted-foreground mb-1 font-medium">起始日期</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => { setStartDate(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>

        <div>
          <label className="block text-xs g text-muted-foreground mb-1 font-medium">結束日期</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => { setEndDate(e.target.value); setPage(1) }}
            className="px-3 py-2 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>

        <button
          onClick={() => { setClinicFilter(''); setEmployeeFilter(''); setStartDate(''); setEndDate(''); setPage(1) }}
          className="px-3 py-2 rounded-md g border bg-slate-100 hover:bg-slate-200 text-sm transition-colors"
        >
          清除篩查
        </button>
      </div>

      {/* Records Table */}
      <div className="overflow-x-auto rounded-xl g border shadow-card">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>員工</th>
              <th>診所</th>
              <th>時間</th>
              <th>類型</th>
              <th>來源</th>
              <th>Token</th>
              <th>修正</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="text-center py-5 g text-muted-foreground">載入中...</td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-5 g text-muted-foreground">沒有考勤記錄</td></tr>
            ) : (
              records.map((record) => (
                <tr key={record.id}>
                  <td>
                    {record.employee?.user?.name || record.employeeId}
                  </td>
                  <td>
                    {record.clinic?.name || record.clinicId}
                  </td>
                  <td>
                    {new Date(record.punchTime).toLocaleString('zh-HK')}
                  </td>
                  <td>
                    <Badge variant={record.punchType === 'CLOCK_IN' ? 'default' : 'secondary'} className="text-[11px]">
                      {record.punchType === 'CLOCK_IN' ? '上班' : '下班'}
                    </Badge>
                  </td>
                  <td>
                    <span className="text-xs g text-muted-foreground">
                      {record.source === 'QR_DYNAMIC' ? '📱 動態碼' :
                       record.source === 'QR_STATIC' ? '📱 固定碼' :
                       record.source === 'MANUAL_CORRECTION' ? '✏️ 補打卡' :
                       '⚙️ 系統'}
                    </span>
                  </td>
                  <td>
                    {record.tokenValid === true ? '✅' :
                     record.tokenValid === false ? '❌' :
                     record.tokenValid === null ? '—' : '?'}
                  </td>
                  <td>
                    {record.corrections?.length > 0 ? (
                      <span className="text-amber-600 text-xs">
                        {record.corrections.length} 筆修正
                      </span>
                    ) : (
                      <span className="text-emerald-600 text-xs">✓ 無修正</span>
                    )}
                  </td>
                  <td>
                    <button
                      onClick={() => {
                        setCorrectionRecord(record)
                        setCorrectionForm({ time: '', reason: '' })
                        setShowCorrectionModal(true)
                      }}
                      className="bg-none border-none cursor-pointer text-amber-600 text-sm px-1 py-0.5 rounded mr-2 hover:underline"
                      title="修正此記錄"
                    >
                      ✏️ 修正
                    </button>
                    <Link href={`/attendance/${record.id}`} className="text-brand hover:underline text-xs">
                      詳情
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-5">
          {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={`px-2.5 py-1 rounded-md border text-sm transition-colors ${p === page ? 'bg-brand text-white g border-brand' : 'g border hover:bg-slate-100'}`}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2.5 text-xs g text-muted-foreground text-center">
        共 {total} 筆記錄
      </div>

      {/* Correction Modal */}
      {showCorrectionModal && correctionRecord && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
          onClick={() => setShowCorrectionModal(false)}
        >
          <div
            className="g bg-card g border rounded-xl shadow-lg w-full mx-4 p-6 relative"
            style={{ maxWidth: '440px' }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setShowCorrectionModal(false)}
              className="absolute top-3 right-3 text-lg g text-muted-foreground hover:text-foreground bg-none border-none cursor-pointer"
            >
              ✕
            </button>
            <h2 className="text-base font-semibold text-foreground mt-0 mb-4">
              ✏️ 修正考勤記錄
            </h2>
            <div className="mb-3 text-sm g text-muted-foreground">
              <div>員工: {correctionRecord.employee?.user?.name || correctionRecord.employeeId}</div>
              <div>診所: {correctionRecord.clinic?.name || correctionRecord.clinicId}</div>
              <div>原時間: {new Date(correctionRecord.punchTime).toLocaleString('zh-HK')}</div>
              <div>類型: {correctionRecord.punchType === 'CLOCK_IN' ? '上班' : '下班'}</div>
            </div>
            <div className="mb-3">
              <label className="block text-xs g text-muted-foreground mb-1 font-medium">
                正確時間
              </label>
              <input
                type="datetime-local"
                value={correctionForm.time}
                onChange={e => setCorrectionForm({ ...correctionForm, time: e.target.value })}
                className="w-full px-3 py-2 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
            <div className="mb-4">
              <label className="block text-xs g text-muted-foreground mb-1 font-medium">
                修正原因
              </label>
              <textarea
                value={correctionForm.reason}
                onChange={e => setCorrectionForm({ ...correctionForm, reason: e.target.value })}
                placeholder="請說明修正原因"
                rows={3}
                className="w-full px-3 py-2 rounded-md g border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 resize-vertical"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCorrectionModal(false)}
                className="px-4 py-2 rounded-md g border bg-slate-100 hover:bg-slate-200 text-sm transition-colors"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  if (!correctionForm.time) {
                    alert('請填寫正確時間')
                    return
                  }
                  setSubmittingCorrection(true)
                  try {
                    const res = await fetch('/api/punch-corrections', {
                      method: 'POST',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        date: correctionForm.time,
                        punchType: correctionRecord.punchType,
                        reason: correctionForm.reason,
                        clinicId: correctionRecord.clinicId,
                        employeeId: correctionRecord.employeeId,
                      }),
                    })
                    if (res.ok) {
                      alert('修正申請已提交')
                      setShowCorrectionModal(false)
                      setCorrectionForm({ time: '', reason: '' })
                      fetchRecords()
                    } else {
                      const err = await res.json()
                      alert(err.error || '提交失敗')
                    }
                  } catch (err) {
                    alert('網路錯誤')
                  } finally {
                    setSubmittingCorrection(false)
                  }
                }}
                disabled={submittingCorrection}
                className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors ${submittingCorrection ? 'bg-gray-400 cursor-default' : 'bg-brand hover:bg-brand-dark cursor-pointer'}`}
              >
                {submittingCorrection ? '提交中...' : '提交修正'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
