'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Pencil, Plus } from 'lucide-react'

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
}

interface ExceptionRecord {
  employeeId: string
  employeeName: string
  clinicName: string
  date: string
  type: 'LATE' | 'ABSENT' | 'CORRECTION'
  detail: string
  punchTime?: string
  correctionTime?: string
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

  // Exceptions tab state
  const [exClinicId, setExClinicId] = useState('')
  const [exEmployeeId, setExEmployeeId] = useState('')
  const [periodMonth, setPeriodMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7)
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

  useEffect(() => { if (user) fetchRecords() }, [user, page, clinicFilter, employeeFilter, startDate, endDate])

  // Exceptions
  const fetchExceptions = useCallback(async () => {
    setExLoading(true)
    try {
      const params = new URLSearchParams({ periodMonth })
      if (exClinicId) params.set('clinicId', exClinicId)
      if (exEmployeeId) params.set('employeeId', exEmployeeId)
      const res = await fetch(`/api/payroll-runs/_exceptions?${params}`, { credentials: 'include' })
      if (res.ok) { const data = await res.json(); setExceptions(data.exceptions || []) }
      else { setExceptions([]) }
    } catch { setExceptions([]) }
    finally { setExLoading(false) }
  }, [exClinicId, exEmployeeId, periodMonth])

  const typeLabel = (type: string) => {
    switch (type) { case 'LATE': return '遲到'; case 'ABSENT': return '缺勤'; case 'CORRECTION': return '補登'; default: return type }
  }
  const typeColor = (type: string) => {
    switch (type) { case 'LATE': return '#ffc107'; case 'ABSENT': return '#dc3545'; case 'CORRECTION': return '#0dcaf0'; default: return '#888' }
  }
  const summary = {
    total: exceptions.length, late: exceptions.filter(e => e.type === 'LATE').length,
    absent: exceptions.filter(e => e.type === 'ABSENT').length, correction: exceptions.filter(e => e.type === 'CORRECTION').length,
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
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">來源</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">Token</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">修正</th>
                  <th className="text-left p-3 text-sm font-medium text-muted-foreground">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="text-center py-5 text-muted-foreground">載入中...</td></tr>
                ) : records.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-5 text-muted-foreground">沒有考勤記錄</td></tr>
                ) : (
                  records.map((record) => (
                    <tr key={record.id} className="border-b hover:bg-gray-50">
                      <td className="p-3">{record.employee?.user?.name || record.employeeId}</td>
                      <td className="p-3">{record.clinic?.name || record.clinicId}</td>
                      <td className="p-3">{new Date(record.punchTime).toLocaleString('zh-HK')}</td>
                      <td className="p-3">
                        <Badge variant={record.punchType === 'CLOCK_IN' ? 'default' : 'secondary'} className="text-[11px]">
                          {record.punchType === 'CLOCK_IN' ? '上班' : '下班'}
                        </Badge>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {record.source === 'QR_DYNAMIC' ? '📱 動態碼' : record.source === 'QR_STATIC' ? '📱 固定碼' : record.source === 'MANUAL_CORRECTION' ? '✏️ 補打卡' : '⚙️ 系統'}
                      </td>
                      <td className="p-3">{record.tokenValid === true ? '✅' : record.tokenValid === false ? '❌' : '—'}</td>
                      <td className="p-3">
                        {record.corrections && record.corrections.length > 0 ? (
                          <span className="text-amber-600 text-xs">{record.corrections.length} 筆修正</span>
                        ) : (<span className="text-emerald-600 text-xs">✓ 無修正</span>)}
                        <button
                          className="ml-2 px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                          onClick={() => { setCorrectionRecord(record); setCorrectionForm({ time: '', reason: '' }); setShowCorrectionModal(true) }}
                        >
                          <span className="flex items-center gap-1"><Pencil size={16} /> 補登/修正</span>
                        </button>
                      </td>
                      <td className="p-3">
                        <button onClick={() => { setCorrectionRecord(record); setCorrectionForm({ time: '', reason: '' }); setShowCorrectionModal(true) }}
                          className="bg-none border-none cursor-pointer text-amber-600 text-sm px-1 py-0.5 rounded mr-2 hover:underline" title="修正此記錄">
                          ✏️ 修正
                        </button>
                        <Link href={`/attendance/${record.id}`} className="text-brand hover:underline text-xs">詳情</Link>
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {[
              { label: '異常總數', value: summary.total, color: '#495057' },
              { label: '遲到', value: summary.late, color: '#ffc107' },
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
          ) : exceptions.length === 0 ? (
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
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((ex, i) => (
                    <tr key={i} className="border-b hover:bg-gray-50">
                      <td className="p-3 font-medium">{ex.employeeName}</td>
                      <td className="p-3">{ex.clinicName}</td>
                      <td className="p-3">{ex.date}</td>
                      <td className="p-3">
                        <span className="rounded px-2 py-0.5 text-xs font-semibold"
                          style={{ background: typeColor(ex.type), color: ex.type === 'LATE' ? '#333' : '#fff' }}>
                          {typeLabel(ex.type)}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">{ex.detail}</td>
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
              <h3 className="text-sm font-semibold mb-3">🔧 生成完整性指紋</h3>
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
            <h3 className="text-sm font-semibold mb-3">🔍 驗證完整性指紋</h3>
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
              <div>類型: {correctionRecord.punchType === 'CLOCK_IN' ? '上班' : '下班'}</div>
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
                onChange={e => setAddPunchForm({ ...addPunchForm, date: e.target.value })}
                className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div className="flex gap-3 mb-3">
              <div style={{ flex: 1 }}>
                <label className="block text-xs text-muted-foreground mb-1 font-medium">上班 / 下班 *</label>
                <select value={addPunchForm.punchType}
                  onChange={e => setAddPunchForm({ ...addPunchForm, punchType: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="CLOCK_IN">上班</option>
                  <option value="CLOCK_OUT">下班</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="block text-xs text-muted-foreground mb-1 font-medium">正確時間 *</label>
                <input type="time" value={addPunchForm.time}
                  onChange={e => setAddPunchForm({ ...addPunchForm, time: e.target.value })}
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
    </div>
  )
}
