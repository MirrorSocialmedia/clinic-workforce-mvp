'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Pencil, Plus, Smartphone, Wrench, Search, Clock } from 'lucide-react'
import { toHKDateStr } from '@/lib/hk-date'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'
type TabKey = 'records' | 'exceptions' | 'hash'

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
  void: {
    id: string
    punchRecordId: string
    voidedBy: string
    reason: string
    createdAt: string
  } | null
}

interface ExceptionRecord {
  employeeId: string
  employeeName: string
  clinicName: string
  date: string
  type: 'LATE' | 'EARLY_LEAVE' | 'ABSENT' | 'CORRECTION' | 'OT'
  detail: string
  punchTime?: string
  correctionTime?: string
  lateMinutes?: number
  earlyMinutes?: number
  otMinutes?: number
  madeUp?: boolean
  payType?: 'HOURLY' | 'MONTHLY'
  // ABSENT-specific
  otDeducted?: boolean
  shiftMinutes?: number
}

export default function AttendancePage() {
  const router = useRouter()
  const [user, setUser] = useState<{ role: Role; clinics: string[] } | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('records')

  // Records tab state
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

  // Standalone 補登 state
  const [showAddPunchModal, setShowAddPunchModal] = useState(false)
  const [addPunchForm, setAddPunchForm] = useState({
    employeeId: '', clinicId: '', date: '', time: '09:00', punchType: 'CLOCK_IN', reason: '',
  })
  const [submittingAddPunch, setSubmittingAddPunch] = useState(false)
  const [clinicFilter, setClinicFilter] = useState('')
  const [employeeFilter, setEmployeeFilter] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // Records tab: exceptions lookup for color-coding
  const [recordsExceptions, setRecordsExceptions] = useState<ExceptionRecord[]>([])
  const [loadedMonths, setLoadedMonths] = useState<Set<string>>(new Set())

  // Void modal state
  const [showVoidModal, setShowVoidModal] = useState(false)
  const [voidRecord, setVoidRecord] = useState<PunchRecord | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [submittingVoid, setSubmittingVoid] = useState(false)

  // Exceptions tab state
  const [exClinicId, setExClinicId] = useState('')
  const [exEmployeeId, setExEmployeeId] = useState('')
  const [periodMonth, setPeriodMonth] = useState(() => {
    const now = new Date()
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return toHKDateStr(lastMonth).slice(0, 7)
  })
  const [exceptions, setExceptions] = useState<ExceptionRecord[]>([])
  const [exLoading, setExLoading] = useState(false)
  const [exClinics, setExClinics] = useState<Array<{ id: string; name: string }>>([])
  const [exEmployees, setExEmployees] = useState<Array<{ id: string; name: string }>>([])

  // Hash tab state
  const [selectedClinic, setSelectedClinic] = useState('')
  const [hashes, setHashes] = useState<any[]>([])
  const [hashLoading, setHashLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [hashError, setHashError] = useState('')
  const [verifyResult, setVerifyResult] = useState<any>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [dateRange, setDateRange] = useState({ start: '', end: '' })

  // Helper: get effective time (latest approved correction or original punch time)
  function effectiveTime(record: PunchRecord): { display: string; hasCorrection: boolean } {
    if (!record.corrections || record.corrections.length === 0) {
      return { display: new Date(record.punchTime).toLocaleString('zh-HK'), hasCorrection: false }
    }
    const approved = record.corrections
      .filter((c: any) => c.status === 'APPROVED')
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    if (approved.length === 0) {
      return { display: new Date(record.punchTime).toLocaleString('zh-HK'), hasCorrection: false }
    }
    const latest = approved[0]
    const correctedStr = new Date(latest.correctedTime).toLocaleString('zh-HK')
    const originalStr = new Date(record.punchTime).toLocaleString('zh-HK')
    return { display: `${correctedStr}（原 ${originalStr}）`, hasCorrection: true }
  }

  // Helper: build exception lookup using HK timezone dates
  const getRecordException = useCallback((record: PunchRecord): {
    late: ExceptionRecord | null;
    earlyLeave: ExceptionRecord | null;
    ot: ExceptionRecord | null;
  } => {
    const recordDate = toHKDateStr(new Date(record.punchTime))
    const late = recordsExceptions.find(
      e => e.employeeId === record.employeeId && e.date === recordDate && e.type === 'LATE'
    )
    const earlyLeave = recordsExceptions.find(
      e => e.employeeId === record.employeeId && e.date === recordDate && e.type === 'EARLY_LEAVE'
    )
    const ot = recordsExceptions.find(
      e => e.employeeId === record.employeeId && e.date === recordDate && e.type === 'OT'
    )
    return {
      late: late || null,
      earlyLeave: earlyLeave || null,
      ot: ot || null,
    }
  }, [recordsExceptions])

  // Shared data loading
  const fetchUserData = async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) { router.push('/login'); return }
      const data = await res.json()
      setUser({ role: data.user.role, clinics: data.user.clinicIds || [] })
    } catch { router.push('/login') }
  }

  const fetchClinicsAndEmployees = async () => {
    try {
      const [cRes, eRes] = await Promise.all([
        fetch('/api/clinics', { credentials: 'include' }),
        fetch('/api/employees', { credentials: 'include' }),
      ])
      if (cRes.ok) { const d = await cRes.json(); setClinics(d.clinics || []); setExClinics(d.clinics || []) }
      if (eRes.ok) {
        const d = await eRes.json()
        const emps = (d.employees || []).map((e: any) => ({ id: e.id, name: e.user?.name || e.id }))
        setEmployees(emps); setExEmployees(emps)
      }
    } catch {}
  }

  useEffect(() => { fetchUserData() }, [])
  useEffect(() => { if (user) fetchClinicsAndEmployees() }, [user])
  useEffect(() => { if (user) setLoading(false) }, [user])

  // Records
  const fetchRecords = async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ page: page.toString(), pageSize: pageSize.toString() })
      if (clinicFilter) params.set('clinicId', clinicFilter)
      if (employeeFilter) params.set('employeeId', employeeFilter)
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)
      const res = await fetch(`/api/punches?${params}`, { credentials: 'include' })
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || `伺服器錯誤 (${res.status})`) }
      const data = await res.json()
      setRecords(data.records || []); setTotal(data.total || 0)
    } catch (err: any) { setError(err.message || '載入失敗') }
    finally { setLoading(false) }
  }

  // Records tab: fetch exceptions for color-coding & status display
  // Fix #3a: Cross-month — collect months from visible records
  const fetchRecordExceptions = useCallback(async () => {
    try {
      const months = new Set<string>()
      if (startDate) months.add(startDate.slice(0, 7))
      if (endDate) months.add(endDate.slice(0, 7))
      if (months.size === 0) months.add(toHKDateStr(new Date()).slice(0, 7))

      // Also add months from records that are visible
      for (const r of records) {
        months.add(toHKDateStr(new Date(r.punchTime)).slice(0, 7))
      }

      const all: ExceptionRecord[] = []
      for (const m of months) {
        const res = await fetch(`/api/payroll-runs/exceptions?periodMonth=${m}`, {
          credentials: 'include',
        })
        if (res.ok) {
          const d = await res.json()
          all.push(...(d.exceptions || []))
        }
      }
      setRecordsExceptions(all)
      setLoadedMonths(months)
    } catch {}
  }, [startDate, endDate, records])

  useEffect(() => {
    if (user && activeTab === 'records') fetchRecordExceptions()
  }, [user, activeTab, fetchRecordExceptions])

  useEffect(() => { if (user) fetchRecords() }, [user, page, clinicFilter, employeeFilter, startDate, endDate])

  // Exceptions
  const fetchExceptions = useCallback(async () => {
    setExLoading(true)
    try {
      const params = new URLSearchParams({ periodMonth })
      if (exClinicId) params.set('clinicId', exClinicId)
      if (exEmployeeId) params.set('employeeId', exEmployeeId)
      const res = await fetch(`/api/payroll-runs/exceptions?${params}`, { credentials: 'include' })
      if (res.ok) { const data = await res.json(); setExceptions(data.exceptions || []) }
      else { setExceptions([]) }
    } catch { setExceptions([]) }
    finally { setExLoading(false) }
  }, [exClinicId, exEmployeeId, periodMonth])

  const handleMakeup = async (record: ExceptionRecord) => {
    const minutes = record.lateMinutes || record.earlyMinutes || 0
    if (!minutes || minutes <= 0) { alert('無法確定補鐘分鐘數'); return }
    if (!confirm(`確定為 ${record.employeeName} 補鐘 ${minutes} 分鐘？將扣其 OT 時間。`)) return
    try {
      const res = await fetch('/api/timebank/makeup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: record.employeeId,
          date: record.date,
          minutes,
          targetType: record.type,
          reason: `${record.type === 'LATE' ? '遲到' : '早退'}補鐘`,
        }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error || '補鐘失敗'); return }
      alert('✅ 補鐘成功')
      fetchExceptions()
    } catch {
      alert('網絡錯誤')
    }
  }

  // 缺勤扣OT鐘
  const handleAbsentDeduct = async (employeeId: string, date: string) => {
    if (!confirm(`確定扣OT鐘買回 ${date} 的缺勤？將扣時間帳戶（排班時數）`)) return
    try {
      const res = await fetch('/api/timebank/absent-deduct', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, date }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error || '扣OT鐘失敗'); return }
      alert('✅ 扣OT鐘成功')
      fetchExceptions()
      fetchRecordExceptions()
    } catch { alert('網絡錯誤') }
  }

  const handleCancelAbsentDeduct = async (employeeId: string, date: string) => {
    if (!confirm(`確定取消 ${date} 的缺勤扣OT鐘？將恢復缺勤狀態。`)) return
    try {
      const res = await fetch('/api/timebank/absent-deduct/cancel', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, date }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error || '取消失敗'); return }
      alert('✅ 取消成功')
      fetchExceptions()
      fetchRecordExceptions()
    } catch { alert('網絡錯誤') }
  }

  const typeLabel = (type: string) => {
    switch (type) { case 'LATE': return '遲到'; case 'EARLY_LEAVE': return '早退'; case 'ABSENT': return '缺勤'; case 'CORRECTION': return '補登'; case 'OT': return 'OT'; default: return type }
  }
  const typeColor = (type: string) => {
    switch (type) { case 'LATE': return '#ffc107'; case 'EARLY_LEAVE': return '#fd7e14'; case 'ABSENT': return '#dc3545'; case 'CORRECTION': return '#0dcaf0'; case 'OT': return '#059669'; default: return '#888' }
  }
  const nonOtExceptions = exceptions.filter(e => e.type !== 'OT')
  const summary = {
    total: nonOtExceptions.length, late: nonOtExceptions.filter(e => e.type === 'LATE').length,
    absent: nonOtExceptions.filter(e => e.type === 'ABSENT').length, correction: nonOtExceptions.filter(e => e.type === 'CORRECTION').length,
    earlyLeave: nonOtExceptions.filter(e => e.type === 'EARLY_LEAVE').length,
  }

  // Hash
  const fetchHashClinics = useCallback(async () => {
    try {
      const res = await fetch('/api/clinics', { credentials: 'include' })
      if (res.ok) { const data = await res.json(); setClinics(data.clinics || []) }
    } catch {}
  }, [])

  const fetchHashes = useCallback(async () => {
    if (!selectedClinic) return
    setHashLoading(true); setHashError('')
    try {
      const params = new URLSearchParams({ clinicId: selectedClinic })
      if (dateRange.start) params.set('startDate', dateRange.start)
      if (dateRange.end) params.set('endDate', dateRange.end)
      const res = await fetch(`/api/daily-hash?${params}`, { credentials: 'include' })
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || `伺服器錯誤 (${res.status})`) }
      const data = await res.json()
      setHashes(data.hashes || [])
    } catch (err: any) { setHashError(err.message || '載入失敗') }
    finally { setHashLoading(false) }
  }, [selectedClinic, dateRange])

  const generateHash = useCallback(async () => {
    if (!selectedClinic || !selectedDate) return
    setGenerating(true)
    try {
      const res = await fetch('/api/daily-hash', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ clinicId: selectedClinic, date: selectedDate }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error || '生成完整性指紋失敗'); return }
      alert(`完整性指紋生成成功！記錄數：${data.recordCount}`)
      fetchHashes()
    } finally { setGenerating(false) }
  }, [selectedClinic, selectedDate, fetchHashes])

  const verifyHash = useCallback(async () => {
    if (!selectedClinic || !selectedDate) return
    try {
      const res = await fetch(`/api/daily-hash/${selectedDate}?clinicId=${selectedClinic}&verify=true`, { credentials: 'include' })
      if (res.ok) { const data = await res.json(); setVerifyResult(data) }
    } catch { alert('驗證失敗') }
  }, [selectedClinic, selectedDate])

  useEffect(() => { if (user) fetchHashClinics() }, [user, fetchHashClinics])
  useEffect(() => { if (selectedClinic) fetchHashes() }, [selectedClinic, fetchHashes])

  // Exceptions tab — auto-fetch when switching to tab or filters change
  useEffect(() => {
    if (user && activeTab === 'exceptions') {
      fetchExceptions()
    }
  }, [user, activeTab, exClinicId, exEmployeeId, periodMonth, fetchExceptions])

  if (!user) return <div style={{ padding: 20 }}>Loading...</div>
  const isManagerOrAbove = user.role === 'OWNER' || user.role === 'MANAGER'
  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="p-6" style={{ maxWidth: '1200px' }}>
      <h1 className="text-2xl font-bold text-foreground tracking-tight mb-6">考勤管理</h1>

      {/* Tabs */}
      <div className="flex gap-4 mb-6 border-b-2 border-gray-200" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {([
          { key: 'records' as TabKey, label: '全部記錄' },
          { key: 'exceptions' as TabKey, label: '異常（遲到/缺卡/補登）' },
          { key: 'hash' as TabKey, label: '完整性驗證' },
        ]).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 -mb-px ${activeTab === tab.key ? 'border-brand text-brand' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {tab.label}
          </button>
        ))}
        {isManagerOrAbove && (
          <button
            onClick={() => {
              setAddPunchForm({ employeeId: '', clinicId: clinics[0]?.id || '', date: '', time: '09:00', punchType: 'CLOCK_IN', reason: '' })
              setShowAddPunchModal(true)
            }}
            className="px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors ml-auto"
            style={{ background: '#0d6efd' }}
          >
            <span className="flex items-center gap-1"><Plus size={16} /> 補登打卡</span>
          </button>
        )}
      </div>

      {/* Records Tab */}
      {activeTab === 'records' && (
        <>
          {/* Filters */}
          <div className="flex gap-3 mb-5 flex-wrap items-end">
            <div>
              <label className="block text-xs text-muted-foreground mb-1 font-medium">診所</label>
              <select value={clinicFilter} onChange={(e) => { setClinicFilter(e.target.value); setPage(1) }}
                className="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="">全部</option>
                {clinics.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1 font-medium">員工</label>
              <select value={employeeFilter} onChange={(e) => { setEmployeeFilter(e.target.value); setPage(1) }}
                className="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="">全部</option>
                {employees.map((e) => (<option key={e.id} value={e.id}>{e.name}</option>))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1 font-medium">起始日期</label>
              <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setPage(1) }}
                className="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1 font-medium">結束日期</label>
              <input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setPage(1) }}
                className="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <button onClick={() => { setClinicFilter(''); setEmployeeFilter(''); setStartDate(''); setEndDate(''); setPage(1) }}
              className="px-3 py-2 rounded-md border bg-slate-100 hover:bg-slate-200 text-sm transition-colors">
              清除篩查
            </button>
          </div>

          {/* Records Table */}
          <div className="overflow-x-auto rounded-xl border shadow-card">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">員工</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">診所</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">時間</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">類型</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">狀態</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">來源</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">Token</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">修正</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">補鐘</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className="text-center py-5 text-muted-foreground">載入中...</td></tr>
                ) : records.length === 0 ? (
                  <tr><td colSpan={10} className="text-center py-5 text-muted-foreground">沒有考勤記錄</td></tr>
                ) : (
                  records.map((record) => {
                    // Get exception data for this record
                    const { late: lateEx, earlyLeave: earlyEx, ot: otEx } = getRecordException(record)

                    // Fix #1: Status by punchType — 上班列只顯示遲到，落班列只顯示OT/早退
                    const isClockIn = record.punchType === 'CLOCK_IN'
                    const showLate = isClockIn ? lateEx : undefined
                    const showEarly = !isClockIn ? earlyEx : undefined
                    const showOt = !isClockIn ? otEx : undefined

                    // Fix #3a: Check if this month has exception data loaded
                    const recordDateStr = toHKDateStr(new Date(record.punchTime))
                    const monthLoaded = loadedMonths.has(recordDateStr.slice(0, 7))

                    // Fix #2d: Void styling
                    const isVoided = !!(record.void as any)
                    const rowBg = isVoided
                      ? '#f3f4f6'
                      : showLate ? '#fff7ed' : showEarly ? '#fef2f2' : showOt ? '#f0fdf4' : undefined

                    return (
                    <tr key={record.id} className={`border-b hover:bg-gray-50 ${isVoided ? 'opacity-50' : ''}`}
                      style={rowBg ? { backgroundColor: rowBg } : {}}>
                      <td className="p-3">{record.employee?.user?.name || record.employeeId}</td>
                      <td className="p-3">{record.clinic?.name || record.clinicId}</td>
                      <td className="p-3">
                        {(() => {
                          const et = effectiveTime(record);
                          if (et.hasCorrection) {
                            const [corrected, original] = et.display.split('（原');
                            return (
                              <span>
                                <span style={{ color: '#d97706', fontWeight: 500 }}>{corrected}</span>
                                <span style={{ marginLeft: 4, fontSize: 10, color: '#f59e0b', background: '#fef3c7', padding: '1px 5px', borderRadius: 4 }}>已修正</span>
                                <details style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                                  <summary style={{ cursor: 'pointer' }}>原始記錄</summary>
                                  <span>{original}</span>
                                  {record.corrections?.[0]?.reason && (
                                    <div style={{ marginTop: 2 }}>原因：{record.corrections[0].reason}</div>
                                  )}
                                </details>
                              </span>
                            );
                          }
                          return <span>{et.display}</span>;
                        })()}
                      </td>
                      <td className="p-3">
                        {record.punchType === 'CLOCK_IN' ? (
                          <span className="px-2 py-1 text-[11px] rounded border border-emerald-300 bg-emerald-50 text-emerald-700 font-medium">
                            上工
                          </span>
                        ) : (
                          <span className="px-2 py-1 text-[11px] rounded border border-orange-300 bg-orange-50 text-orange-700 font-medium">
                            落班
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        {/* Fix #1: Status by punchType */}
                        {/* Fix #3a: Show '—' if month not loaded */}
                        {!monthLoaded ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <>
                            {showLate && <span style={{ color: '#d97706', fontWeight: 600 }}>遲到 {showLate.lateMinutes || 0} 分</span>}
                            {showEarly && <span style={{ color: '#dc2626', fontWeight: 600 }}>早退 {showEarly.earlyMinutes || 0} 分</span>}
                            {showOt && <span style={{ color: '#059669', fontWeight: 600 }}>OT {showOt.otMinutes || 0} 分</span>}
                            {!showLate && !showEarly && !showOt && <span style={{ color: '#16a34a' }}>正常</span>}
                          </>
                        )}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {record.source === 'QR_DYNAMIC' ? <><Smartphone size={14} style={{ marginRight: 4 }} /> 動態碼</> : record.source === 'QR_STATIC' ? <><Smartphone size={14} style={{ marginRight: 4 }} /> 固定碼</> : record.source === 'MANUAL_CORRECTION' ? <><Pencil size={14} style={{ marginRight: 4 }} /> 補打卡</> : <><Wrench size={14} style={{ marginRight: 4 }} /> 系統</>}
                      </td>
                      <td className="p-3">{record.tokenValid === true ? '✅' : record.tokenValid === false ? '❌' : '—'}</td>
                      <td className="p-3">
                        {record.corrections && record.corrections.length > 0 ? (
                          <span className="text-amber-600 text-xs">
                            {record.corrections.length} 筆修正
                            {record.corrections.some((c: any) => c.status === 'APPROVED') && (
                              <span style={{ marginLeft: 4, color: '#10b981' }}>✓ 已生效</span>
                            )}
                          </span>
                        ) : (<span className="text-emerald-600 text-xs">✓ 無修正</span>)}
                      </td>
                      <td className="p-3">
                        {/* Fix #1: Makeup only for relevant punch types */}
                        {/* HOURLY employees don't have makeup (no time account) */}
                        {((isClockIn && showLate) || (!isClockIn && showEarly)) && user.role === 'OWNER' && (
                          (isClockIn ? (showLate?.payType !== 'HOURLY') : (showEarly?.payType !== 'HOURLY')) && (
                          ((isClockIn && showLate?.madeUp) || (!isClockIn && showEarly?.madeUp)) ? (
                            <span className="px-2 py-1 text-xs rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                              ✓ 已補鐘
                            </span>
                          ) : (
                            <button
                              onClick={() => { const ex = isClockIn ? (lateEx || undefined) : (earlyEx || undefined); if (ex) handleMakeup(ex) }}
                              className="text-xs px-2 py-1 rounded-md font-medium flex items-center gap-1"
                              style={{ background: '#fff3cd', color: '#856404', border: '1px solid #ffc107' }}
                              title="補鐘：用OT補這次遲到/早退，免扣勤工"
                            >
                              <Clock size={12} /> 補鐘
                            </button>
                          )
                          )
                        )}
                      </td>
                      <td className="p-3">
                        {/* Fix #2d: Void badge + button */}
                        {isVoided ? (
                          <span className="px-2 py-1 text-xs rounded bg-gray-200 text-gray-600 border border-gray-300"
                            title={(record.void as any)?.reason || ''}>已作廢</span>
                        ) : null}
                        <button onClick={() => { setCorrectionRecord(record); setCorrectionForm({ time: '', reason: '' }); setShowCorrectionModal(true) }}
                          className="text-amber-600 text-sm mr-2 hover:underline flex items-center gap-1" title="修正此記錄">
                          <Pencil size={14} /> 修正
                        </button>
                        {/* Fix #2d: Void button for MANUAL_CORRECTION records (OWNER only) */}
                        {!isVoided && record.source === 'MANUAL_CORRECTION' && user?.role === 'OWNER' && (
                          <button onClick={() => { setVoidRecord(record); setVoidReason(''); setShowVoidModal(true) }}
                            className="text-red-600 text-sm mr-2 hover:underline" title="作廢此補登記錄">
                            作廢
                          </button>
                        )}
                        <Link href={`/attendance/${record.id}`} className="text-brand hover:underline text-xs">詳情</Link>
                      </td>
                    </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-5">
              {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
                <button key={p} onClick={() => setPage(p)}
                  className={`px-2.5 py-1 rounded-md border text-sm transition-colors ${p === page ? 'bg-brand text-white border-brand' : 'border hover:bg-slate-100'}`}>
                  {p}
                </button>
              ))}
            </div>
          )}
          <div className="mt-2.5 text-xs text-muted-foreground text-center">共 {total} 筆記錄</div>
        </>
      )}

      {/* Exceptions Tab */}
      {activeTab === 'exceptions' && (
        <>
          {/* Filters */}
          <div className="flex gap-3 mb-5 flex-wrap items-end">
            <div>
              <label className="block text-xs text-muted-foreground mb-1 font-medium">月份</label>
              <input type="month" value={periodMonth} onChange={e => setPeriodMonth(e.target.value)}
                className="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1 font-medium">診所</label>
              <select value={exClinicId} onChange={e => setExClinicId(e.target.value)}
                className="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="">全部</option>
                {exClinics.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1 font-medium">員工</label>
              <select value={exEmployeeId} onChange={e => setExEmployeeId(e.target.value)}
                className="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="">全部</option>
                {exEmployees.map(e => (<option key={e.id} value={e.id}>{e.name}</option>))}
              </select>
            </div>
            <button onClick={fetchExceptions} disabled={exLoading}
              className="px-4 py-2 rounded-md border-none bg-brand text-white text-sm font-semibold hover:bg-brand-dark disabled:bg-gray-400">
              {exLoading ? '查詢中...' : '查詢'}
            </button>
          </div>

          {/* Summary */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            {[
              { label: '異常總數', value: summary.total, color: '#495057' },
              { label: '遲到', value: summary.late, color: '#ffc107' },
              { label: '早退', value: summary.earlyLeave, color: '#fd7e14' },
              { label: '缺勤', value: summary.absent, color: '#dc3545' },
              { label: '補登', value: summary.correction, color: '#0dcaf0' },
            ].map(card => (
              <div key={card.label} className="rounded-lg p-4" style={{ background: card.color + '10', borderLeft: `3px solid ${card.color}` }}>
                <div className="text-xs text-muted-foreground">{card.label}</div>
                <div className="text-2xl font-bold" style={{ color: card.color }}>{card.value}</div>
              </div>
            ))}
          </div>

          {/* Table */}
          {exLoading ? (
            <div className="text-center py-10 text-muted-foreground">查詢中...</div>
          ) : nonOtExceptions.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">沒有找到異常記錄 🎉</div>
          ) : (
            <div className="overflow-x-auto rounded-xl border shadow-card">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-3 text-sm font-medium text-muted-foreground">員工</th>
                    <th className="text-left p-3 text-sm font-medium text-muted-foreground">診所</th>
                    <th className="text-left p-3 text-sm font-medium text-muted-foreground">日期</th>
                    <th className="text-left p-3 text-sm font-medium text-muted-foreground">類型</th>
                    <th className="text-left p-3 text-sm font-medium text-muted-foreground">詳情</th>
                    <th className="text-left p-3 text-sm font-medium text-muted-foreground">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {nonOtExceptions.map((ex, i) => (
                    <tr key={i} className="border-b hover:bg-gray-50">
                      <td className="p-3 font-medium">{ex.employeeName}</td>
                      <td className="p-3">{ex.clinicName}</td>
                      <td className="p-3">{ex.date}</td>
                      <td className="p-3">
                        <span className="rounded px-2 py-0.5 text-xs font-semibold"
                          style={{ background: typeColor(ex.type), color: (ex.type === 'LATE' || ex.type === 'EARLY_LEAVE') ? '#333' : '#fff' }}>
                          {typeLabel(ex.type)}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">{ex.detail}</td>
                      <td className="p-3">
                        {(ex.type === 'LATE' || ex.type === 'EARLY_LEAVE') && user.role === 'OWNER' && ex.payType !== 'HOURLY' && (
                          ex.madeUp ? (
                            <span className="px-2 py-1 text-xs rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                              ✓ 已補鐘
                            </span>
                          ) : (
                            <button
                              onClick={() => handleMakeup(ex)}
                              className="text-xs px-2 py-1 rounded-md font-medium flex items-center gap-1"
                              style={{ background: '#fff3cd', color: '#856404', border: '1px solid #ffc107' }}
                              title="補鐘：用OT補這次遲到/早退，免扣勤工"
                            >
                              <Clock size={12} /> 補鐘
                            </button>
                          )
                        )}
                        {/* ABSENT 三態：扣OT鐘 */}
                        {ex.type === 'ABSENT' && user.role === 'OWNER' && ex.payType !== 'HOURLY' && (
                          ex.otDeducted ? (
                            <span className="flex items-center gap-1">
                              <span className="text-blue-700 text-xs">
                                ✓已扣OT鐘（−{ex.shiftMinutes}分）
                              </span>
                              <button
                                onClick={() => handleCancelAbsentDeduct(ex.employeeId, ex.date)}
                                className="text-xs text-red-500 hover:underline ml-1"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => handleAbsentDeduct(ex.employeeId, ex.date)}
                              className="text-xs px-2 py-1 rounded-md font-medium"
                              style={{ background: '#dbeafe', color: '#1d4ed8', border: '1px solid #93c5fd' }}
                              title="扣OT鐘：用時間帳戶買回缺勤工資扣款，仍取消勤工獎"
                            >
                              扣OT鐘
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Hash Tab */}
      {activeTab === 'hash' && (
        <>
          <p className="text-sm text-muted-foreground mb-6">
            考勤完整性驗證確保打卡記錄完整性 — 所有記錄的 SHA-256 指紋，改動後可重算比對
          </p>

          {/* Clinic selector */}
          <div className="mb-5">
            <label className="block text-sm font-medium mb-2">選擇診所</label>
            <select value={selectedClinic} onChange={(e) => setSelectedClinic(e.target.value)}
              className="px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="">請選擇診所...</option>
              {clinics.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </select>
          </div>

          {/* Generate hash */}
          {isManagerOrAbove && (
            <div className="rounded-lg p-4 mb-5 border bg-gray-50">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-1"><Wrench size={16} /> 生成完整性指紋</h3>
              <div className="flex gap-3 items-end">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">日期</label>
                  <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}
                    className="px-3 py-2 rounded-md border text-sm" />
                </div>
                <button onClick={generateHash} disabled={generating || !selectedDate}
                  className="px-4 py-2 rounded-md border-none text-white text-sm font-semibold disabled:bg-gray-400"
                  style={{ background: selectedDate ? '#3498db' : '#ccc' }}>
                  {generating ? '生成中...' : '生成完整性指紋'}
                </button>
              </div>
            </div>
          )}

          {/* Verify hash */}
          <div className="rounded-lg p-4 mb-5 border" style={{ background: '#fef9e7', borderColor: '#f9e79f' }}>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-1"><Search size={16} /> 驗證完整性指紋</h3>
            <div className="flex gap-3 items-end">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">日期</label>
                <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}
                  className="px-3 py-2 rounded-md border text-sm" />
              </div>
              <button onClick={verifyHash} disabled={!selectedDate}
                className="px-4 py-2 rounded-md border-none text-white text-sm font-semibold disabled:bg-gray-400"
                style={{ background: selectedDate ? '#27ae60' : '#ccc' }}>
                驗證
              </button>
            </div>

            {verifyResult && (
              <div className="mt-3 p-3 rounded-md"
                style={{ background: verifyResult.valid ? '#eafaf1' : '#fdedec',
                  border: `1px solid ${verifyResult.valid ? '#a9dfbf' : '#f5b7b1'}` }}>
                <div className="font-semibold text-sm mb-1">
                  {verifyResult.valid ? '✅ 完整性指紋一致 — 記錄完整' : '❌ 完整性指紋不一致 — 記錄可能被改動'}
                </div>
                {verifyResult.storedHash && <div className="text-[11px] text-muted-foreground break-all">儲存：{verifyResult.storedHash}</div>}
                {verifyResult.computedHash && <div className="text-[11px] text-muted-foreground break-all">計算：{verifyResult.computedHash}</div>}
                {verifyResult.recordCount && <div className="text-xs mt-1">記錄數：{verifyResult.recordCount}</div>}
              </div>
            )}
          </div>

          {/* Hash list */}
          <div>
            <h3 className="text-sm font-semibold mb-3">完整性指紋記錄</h3>

            {/* Date range filter */}
            <div className="flex gap-3 mb-3 items-end">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">起始日期</label>
                <input type="date" value={dateRange.start}
                  onChange={(e) => setDateRange((prev) => ({ ...prev, start: e.target.value }))}
                  className="px-3 py-2 rounded-md border text-sm" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">結束日期</label>
                <input type="date" value={dateRange.end}
                  onChange={(e) => setDateRange((prev) => ({ ...prev, end: e.target.value }))}
                  className="px-3 py-2 rounded-md border text-sm" />
              </div>
              <button onClick={() => { setDateRange({ start: '', end: '' }); fetchHashes() }}
                className="px-3 py-2 rounded-md border bg-gray-100 text-sm hover:bg-gray-200">
                清除
              </button>
            </div>

            {hashError ? (
              <div className="text-red-500 py-4 text-sm">⚠️ {hashError}</div>
            ) : hashLoading ? (
              <div className="text-muted-foreground py-4 text-sm">載入中...</div>
            ) : hashes.length === 0 ? (
              <div className="text-muted-foreground py-4 text-sm">沒有完整性指紋記錄。需要先生成。</div>
            ) : (
              <div className="overflow-x-auto rounded-xl border shadow-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="text-left p-3 font-medium text-muted-foreground">日期</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">診所</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">完整性指紋</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">記錄數</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">生成時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hashes.map((h) => (
                      <tr key={h.id} className="border-b hover:bg-gray-50">
                        <td className="p-3">{new Date(h.date).toLocaleDateString('zh-HK')}</td>
                        <td className="p-3">{h.clinic?.name || h.clinicId}</td>
                        <td className="p-3 font-mono text-xs">{h.hash.slice(0, 24)}...</td>
                        <td className="p-3">{h.recordCount} 筆</td>
                        <td className="p-3 text-xs text-muted-foreground">{new Date(h.createdAt).toLocaleString('zh-HK')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Correction Modal */}
      {showCorrectionModal && correctionRecord && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
          onClick={() => setShowCorrectionModal(false)}>
          <div className="bg-white border rounded-xl shadow-lg w-full mx-4 p-6 relative" style={{ maxWidth: '440px' }}
            onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowCorrectionModal(false)}
              className="absolute top-3 right-3 text-lg text-muted-foreground hover:text-foreground bg-none border-none cursor-pointer">✕</button>
            <h2 className="text-base font-semibold text-foreground mt-0 mb-4">修正考勤記錄</h2>
            <div className="mb-3 text-sm text-muted-foreground">
              <div>員工: {correctionRecord.employee?.user?.name || correctionRecord.employeeId}</div>
              <div>診所: {correctionRecord.clinic?.name || correctionRecord.clinicId}</div>
              <div>原時間: {new Date(correctionRecord.punchTime).toLocaleString('zh-HK')}</div>
              <div>類型: {correctionRecord.punchType === 'CLOCK_IN' ? '上工' : '落班'}</div>
            </div>
            <div className="mb-3">
              <label className="block text-xs text-muted-foreground mb-1 font-medium">正確時間</label>
              <input type="datetime-local" value={correctionForm.time}
                onChange={e => setCorrectionForm({ ...correctionForm, time: e.target.value })}
                className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-1 font-medium">修正原因</label>
              <textarea value={correctionForm.reason}
                onChange={e => setCorrectionForm({ ...correctionForm, reason: e.target.value })}
                placeholder="請說明修正原因" rows={3}
                className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 resize-vertical" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowCorrectionModal(false)}
                className="px-4 py-2 rounded-md border bg-slate-100 hover:bg-slate-200 text-sm transition-colors">取消</button>
              <button onClick={async () => {
                if (!correctionForm.time) { alert('請填寫正確時間'); return }
                setSubmittingCorrection(true)
                try {
                  const res = await fetch('/api/punch-corrections', {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      date: correctionForm.time, punchType: correctionRecord.punchType,
                      reason: correctionForm.reason, clinicId: correctionRecord.clinicId,
                      employeeId: correctionRecord.employeeId,
                    }),
                  })
                  if (res.ok) { alert('修正申請已提交'); setShowCorrectionModal(false); setCorrectionForm({ time: '', reason: '' }); fetchRecords() }
                  else { const err = await res.json(); alert(err.error || '提交失敗') }
                } catch { alert('網路錯誤') }
                finally { setSubmittingCorrection(false) }
              }} disabled={submittingCorrection}
                className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors ${submittingCorrection ? 'bg-gray-400 cursor-default' : 'bg-brand hover:bg-brand-dark cursor-pointer'}`}>
                {submittingCorrection ? '提交中...' : '提交修正'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Standalone 補登 Modal (新增缺失記錄) */}
      {showAddPunchModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
          onClick={() => setShowAddPunchModal(false)}>
          <div className="bg-white border rounded-xl shadow-lg w-full mx-4 p-6 relative" style={{ maxWidth: '480px' }}
            onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowAddPunchModal(false)}
              className="absolute top-3 right-3 text-lg text-muted-foreground hover:text-foreground bg-none border-none cursor-pointer">✕</button>
            <h2 className="text-base font-semibold text-foreground mt-0 mb-4">補登打卡（新增缺失記錄）</h2>
            <div className="mb-3">
              <label className="block text-xs text-muted-foreground mb-1 font-medium">員工 *</label>
              <select value={addPunchForm.employeeId}
                onChange={e => setAddPunchForm({ ...addPunchForm, employeeId: e.target.value })}
                className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="">選擇員工</option>
                {employees.map((emp) => (<option key={emp.id} value={emp.id}>{emp.name}</option>))}
              </select>
            </div>
            <div className="mb-3">
              <label className="block text-xs text-muted-foreground mb-1 font-medium">診所 *</label>
              <select value={addPunchForm.clinicId}
                onChange={e => setAddPunchForm({ ...addPunchForm, clinicId: e.target.value })}
                className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="">選擇診所</option>
                {clinics.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </div>
            <div className="mb-3">
              <label className="block text-xs text-muted-foreground mb-1 font-medium">日期 *</label>
              <input type="date" value={addPunchForm.date}
                max={new Date().toLocaleDateString('en-CA')}
                onChange={e => setAddPunchForm({ ...addPunchForm, date: e.target.value })}
                className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div className="flex gap-3 mb-3">
              <div style={{ flex: 1 }}>
                <label className="block text-xs text-muted-foreground mb-1 font-medium">上工 / 落班 *</label>
                <select value={addPunchForm.punchType}
                  onChange={e => setAddPunchForm({ ...addPunchForm, punchType: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="CLOCK_IN">上工</option>
                  <option value="CLOCK_OUT">落班</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="block text-xs text-muted-foreground mb-1 font-medium">正確時間 *</label>
                <input type="time" value={addPunchForm.time}
                  onChange={e => {
                    const dt = new Date(`${addPunchForm.date}T${e.target.value}:00+08:00`)
                    if (dt > new Date()) { alert('不能補未來時間的打卡'); return }
                    setAddPunchForm({ ...addPunchForm, time: e.target.value })
                  }}
                  className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-1 font-medium">原因 *</label>
              <textarea value={addPunchForm.reason}
                onChange={e => setAddPunchForm({ ...addPunchForm, reason: e.target.value })}
                placeholder="請說明補登原因（必填）" rows={3}
                className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 resize-vertical" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowAddPunchModal(false)}
                className="px-4 py-2 rounded-md border bg-slate-100 hover:bg-slate-200 text-sm transition-colors">取消</button>
              <button onClick={async () => {
                const { employeeId, clinicId, date, time, punchType, reason } = addPunchForm
                if (!employeeId || !clinicId || !date || !reason) { alert('請填寫所有必填欄位'); return }
                // Double-check: reject future time at submit (Fix #2b)
                const submitDtime = new Date(`${date}T${time}:00+08:00`)
                if (submitDtime > new Date()) { alert('不能補未來時間的打卡'); return }
                setSubmittingAddPunch(true)
                try {
                  const datetime = `${date}T${time}:00`
                  const res = await fetch('/api/punch-corrections', {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date: datetime, punchType, reason, clinicId, employeeId }),
                  })
                  if (res.ok) { alert('補登申請已提交'); setShowAddPunchModal(false); setAddPunchForm({ employeeId: '', clinicId: clinics[0]?.id || '', date: '', time: '09:00', punchType: 'CLOCK_IN', reason: '' }); fetchRecords() }
                  else { const err = await res.json(); alert(err.error || '提交失敗') }
                } catch { alert('網路錯誤') }
                finally { setSubmittingAddPunch(false) }
              }} disabled={submittingAddPunch}
                className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors ${submittingAddPunch ? 'bg-gray-400 cursor-default' : 'bg-brand hover:bg-brand-dark cursor-pointer'}`}>
                {submittingAddPunch ? '提交中...' : '提交補登'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Void Modal — 作廢補登記錄 */}
      {showVoidModal && voidRecord && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
          onClick={() => setShowVoidModal(false)}>
          <div className="bg-white border rounded-xl shadow-lg w-full mx-4 p-6 relative" style={{ maxWidth: '440px' }}
            onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowVoidModal(false)}
              className="absolute top-3 right-3 text-lg text-muted-foreground hover:text-foreground bg-none border-none cursor-pointer">✕</button>
            <h2 className="text-base font-semibold text-foreground mt-0 mb-4">作廢補登記錄</h2>
            <div className="mb-3 text-sm text-muted-foreground">
              <div>員工: {voidRecord.employee?.user?.name || voidRecord.employeeId}</div>
              <div>診所: {voidRecord.clinic?.name || voidRecord.clinicId}</div>
              <div>時間: {new Date(voidRecord.punchTime).toLocaleString('zh-HK')}</div>
              <div>類型: {voidRecord.punchType === 'CLOCK_IN' ? '上工' : '落班'}</div>
              <div className="mt-1 text-xs text-red-500">⚠️ 作廢後此記錄將從所有計算中排除，無法復原。</div>
            </div>
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-1 font-medium">作廢原因 *</label>
              <textarea value={voidReason}
                onChange={e => setVoidReason(e.target.value)}
                placeholder="請說明作廢原因（必填）" rows={3}
                className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 resize-vertical" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowVoidModal(false)}
                className="px-4 py-2 rounded-md border bg-slate-100 hover:bg-slate-200 text-sm transition-colors">取消</button>
              <button onClick={async () => {
                if (!voidReason.trim()) { alert('請填寫作廢原因'); return }
                setSubmittingVoid(true)
                try {
                  const res = await fetch(`/api/punches/${voidRecord.id}/void`, {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason: voidReason }),
                  })
                  const data = await res.json()
                  if (!res.ok) { alert(data.error || '作廢失敗'); return }
                  alert('✅ 已作廢')
                  setShowVoidModal(false)
                  setVoidReason('')
                  setVoidRecord(null)
                  fetchRecords()
                  fetchRecordExceptions()
                } catch { alert('網路錯誤') }
                finally { setSubmittingVoid(false) }
              }} disabled={submittingVoid}
                className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors ${submittingVoid ? 'bg-gray-400 cursor-default' : 'bg-red-600 hover:bg-red-700 cursor-pointer'}`}>
                {submittingVoid ? '作廢中...' : '確認作廢'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
