'use client'

import { useEffect, useState, useCallback } from 'react'
import { toHKDateStr } from '@/lib/hk-date'
import { Plus } from 'lucide-react'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'
type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
type TabKey = 'balance' | 'types'

interface LeaveType {
  id: string
  name: string
  isPaid: boolean
  annualQuota: number | null
  color: string | null
  isActive: boolean | null
  systemKey: string | null
  cancelsBonus: boolean | null
}

interface LeaveRequestItem {
  id: string
  employeeId: string
  leaveTypeId: string
  leaveType: { id: string; name: string; isPaid: boolean; color: string | null }
  startDate: string
  endDate: string
  days: number
  reason: string | null
  status: LeaveStatus
  approverId: string | null
  approvedAt: string | null
  createdAt: string
  employee?: {
    user: { id: string; name: string }
  }
}

interface LeaveBalanceItem {
  id: string
  employeeId: string
  leaveTypeId: string
  leaveType: { id: string; name: string; isPaid: boolean; annualQuota: number | null; color: string | null; systemKey: string | null }
  year: number
  entitled: number
  used: number
  remaining: number
  employee?: {
    user: { id: string; name: string }
  }
}

const STATUS_LABELS: Record<LeaveStatus, string> = {
  PENDING: '待審批',
  APPROVED: '已批準',
  REJECTED: '已拒絕',
}

const STATUS_COLORS: Record<LeaveStatus, string> = {
  PENDING: '#FF9800',
  APPROVED: '#4CAF50',
  REJECTED: '#dc3545',
}

export default function LeavePage() {
  const [userRole, setUserRole] = useState<Role | null>(null)
  const [userId, setUserId] = useState<string>('')
  const [requests, setRequests] = useState<LeaveRequestItem[]>([])
  const [balances, setBalances] = useState<LeaveBalanceItem[]>([])
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([])
  const [employees, setEmployees] = useState<Array<{ id: string; user: { name: string } }>>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<LeaveStatus | ''>('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', days: '', reason: '' })

  // Leave init/clear state
  const [initForm, setInitForm] = useState({ employeeId: 'all', leaveTypeId: '', days: 14, year: 2026 })
  const [clearEmployeeId, setClearEmployeeId] = useState('all')
  const [clearYear, setClearYear] = useState(2026)

  // Auto-calculate & Settlement state
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState('')
  const [settlementForm, setSettlementForm] = useState({ employeeId: '', resignDate: '', monthlySalary: '' })
  const [settlementLoading, setSettlementLoading] = useState(false)
  const [settlementResult, setSettlementResult] = useState<any>(null)

  // OT 兌換 state
  const [convertForm, setConvertForm] = useState({ employeeId: '', days: '', direction: 'to_leave' })
  const [converting, setConverting] = useState(false)
  const [convertResult, setConvertResult] = useState('')
  const [convertEmpInfo, setConvertEmpInfo] = useState<any>(null)
  const [restDayBalance, setRestDayBalance] = useState<number | null>(null)

  // 初始化時間帳戶 state (OWNER only)
  const [initAccountForm, setInitAccountForm] = useState({ employeeId: '', days: '', minutes: '', direction: 'debt', effectiveMonth: toHKDateStr(new Date()).slice(0, 7), reason: '' })
  const [initAccountLoading, setInitAccountLoading] = useState(false)
  const [initAccountResult, setInitAccountResult] = useState('')

  // Time Account Overview state
  const [tbOverview, setTbOverview] = useState<any[]>([])
  const [tbLoading, setTbLoading] = useState(true)

  // Balance employee filter
  const [balanceEmployeeId, setBalanceEmployeeId] = useState('all')

  // Leave Types management state
  const [activeTab, setActiveTab] = useState<TabKey>('balance')
  const [ltShowForm, setLtShowForm] = useState(false)
  const [ltForm, setLtForm] = useState({ name: '', isPaid: true, annualQuota: '', color: '#4CAF50', cancelsBonus: false })
  const [ltEditingId, setLtEditingId] = useState<string | null>(null)

  // Auto-calculate days when start/end dates change
  useEffect(() => {
    if (form.startDate && form.endDate) {
      const start = new Date(form.startDate)
      const end = new Date(form.endDate)
      const diffDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1
      if (diffDays > 0) {
        setForm(f => ({ ...f, days: String(diffDays) }))
      }
    }
  }, [form.startDate, form.endDate])

  // Fix #3: 選員工後抓 timebank summary
  useEffect(() => {
    if (!convertForm.employeeId) { setConvertEmpInfo(null); return }
    const month = toHKDateStr(new Date()).slice(0, 7)
    fetch(`/api/payroll-runs/exceptions?periodMonth=${month}&employeeId=${convertForm.employeeId}`, {
      credentials: 'include',
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const s = d?.summaries?.find((x: any) => x.employeeId === convertForm.employeeId)
        setConvertEmpInfo(s)
      })
      .catch(() => setConvertEmpInfo(null))
  }, [convertForm.employeeId])

  // 抓休息日餘額（rest_to_account 方向時）
  useEffect(() => {
    if (!convertForm.employeeId || convertForm.direction !== 'rest_to_account') { setRestDayBalance(null); return }
    const year = new Date().getFullYear()  // tz-ok: frontend browser
    fetch(`/api/leave-balance`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(async (d) => {
        if (!d?.leaveBalances?.length) return setRestDayBalance(null)
        // 找 REST_DAY 類型 id
        const typesRes = await fetch('/api/leave-types', { credentials: 'include' })
        const typesData = await typesRes.json()
        const restType = typesData?.leaveTypes?.find((t: any) => t.systemKey === 'REST_DAY')
        if (!restType) return setRestDayBalance(null)
        const bal = d.leaveBalances.find((b: any) => b.employeeId === convertForm.employeeId && b.leaveTypeId === restType.id && b.year === year)
        setRestDayBalance(bal?.remaining ?? null)
      })
      .catch(() => setRestDayBalance(null))
  }, [convertForm.employeeId, convertForm.direction])

  const isManager = userRole === 'OWNER' || userRole === 'MANAGER'
  const isOwner = userRole === 'OWNER'

  // 週年發放制：找 ANNUAL_LEAVE 類型 id 與當前公曆年，用於 UI 過濾
  const annualLeaveTypeId = leaveTypes.find(t => t.systemKey === 'ANNUAL_LEAVE')?.id
  const currentYear = new Date().getFullYear()

  const fetchData = useCallback(async () => {
    try {
      const meRes = await fetch('/api/me', { credentials: 'include' })
      const meData = await meRes.json()
      const role = meData.user.role as Role // ← local var, fresh value
      setUserRole(role)
      setUserId(meData.user.id)

      const params = new URLSearchParams()
      if (filter) params.set('status', filter)
      const reqRes = await fetch(`/api/leave-requests?${params}`, { credentials: 'include' })
      const reqData = await reqRes.json()
      setRequests(reqData.leaveRequests || [])

      const balRes = await fetch('/api/leave-balance', { credentials: 'include' })
      const balData = await balRes.json()
      setBalances(balData.leaveBalances || [])

      const typesRes = await fetch('/api/leave-types', { credentials: 'include' })
      const typesData = await typesRes.json()
      setLeaveTypes(typesData.leaveTypes || [])

      // Fetch employees for init/clear dropdowns
      // ✅ Use local role instead of stale-closure isManager
      if (role === 'OWNER' || role === 'MANAGER') {
        const empRes = await fetch('/api/employees', { credentials: 'include' })
        if (empRes.ok) {
          const empData = await empRes.json()
          // 兼容兩種格式：直接陣列 或 { employees: [...] }
          const empList = Array.isArray(empData) ? empData : (empData.employees || [])
          console.log('[LeavePage] 載入員工數:', empList.length)
          setEmployees(empList)
        }
      }
    } catch (err) {
      console.error('Failed to fetch leave data:', err)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { fetchData() }, [fetchData])

  // Time Account Overview — same source as dashboard
  useEffect(() => {
    const load = async () => {
      try {
        const ym = toHKDateStr(new Date()).slice(0, 7) // YYYY-MM HK perspective
        const res = await fetch(`/api/payroll-runs/exceptions?periodMonth=${ym}`, { credentials: 'include' })
        if (!res.ok) return
        const data = await res.json()
        setTbOverview((data.summaries || []).filter((e: any) => e.timeAccountMinutes != null))
      } finally { setTbLoading(false) }
    }
    load()
  }, [])

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.leaveTypeId || !form.startDate || !form.endDate || !form.days) return

    try {
      const res = await fetch('/api/leave-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          leaveTypeId: form.leaveTypeId,
          startDate: form.startDate,
          endDate: form.endDate,
          days: parseFloat(form.days),
          reason: form.reason || undefined,
        }),
      })

      if (res.ok) {
        setForm({ leaveTypeId: '', startDate: '', endDate: '', days: '', reason: '' })
        setShowForm(false)
        fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '申請失敗')
      }
    } catch (err) {
      console.error('Leave request error:', err)
    }
  }

  const handleApproveReject = async (id: string, action: 'APPROVE' | 'REJECT') => {
    if (!isManager) return
    try {
      const res = await fetch(`/api/leave-requests/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action }),
      })

      if (res.ok) {
        fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '操作失敗')
      }
    } catch (err) {
      console.error('Approval error:', err)
    }
  }

  // Leave Types handlers
  const handleLtSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const method = ltEditingId ? 'PUT' : 'POST'
      const url = ltEditingId ? `/api/leave-types/${ltEditingId}` : '/api/leave-types'
      const body: any = { name: ltForm.name, isPaid: ltForm.isPaid, color: ltForm.color, cancelsBonus: ltForm.cancelsBonus }
      if (ltForm.annualQuota) body.annualQuota = parseFloat(ltForm.annualQuota)
      else body.annualQuota = null

      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
      if (res.ok) {
        setLtForm({ name: '', isPaid: true, annualQuota: '', color: '#4CAF50', cancelsBonus: false })
        setLtShowForm(false); setLtEditingId(null); fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '操作失敗')
      }
    } catch (err) { console.error('Submit error:', err) }
  }

  const handleLtEdit = (t: LeaveType) => {
    setLtForm({ name: t.name, isPaid: t.isPaid, annualQuota: t.annualQuota?.toString() || '', color: t.color || '#4CAF50', cancelsBonus: !!t.cancelsBonus })
    setLtEditingId(t.id); setLtShowForm(true)
  }

  const handleLtToggleActive = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/leave-types/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ isActive: !isActive }),
      })
      if (res.ok) fetchData()
    } catch (err) { console.error('Toggle error:', err) }
  }

  // Leave init/clear handlers
  const fetchBalances = useCallback(async () => {
    try {
      const balRes = await fetch('/api/leave-balance', { credentials: 'include' })
      const balData = await balRes.json()
      setBalances(balData.leaveBalances || [])
    } catch {}
  }, [])

  const handleInitLeave = async () => {
    if (!confirm(`確定初始化 ${initForm.year} 年${initForm.employeeId === 'all' ? '全部員工' : ''}的假期額度？`)) return
    try {
      const res = await fetch('/api/leave-balance/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(initForm),
      })
      const data = await res.json()
      if (res.ok) { alert(`成功初始化 ${data.count} 筆記錄`); fetchBalances() }
      else alert(data.error || '初始化失敗')
    } catch (err) { alert('初始化失敗') }
  }

  const handleClearLeave = async () => {
    if (!confirm(`⚠️ 確定清除 ${clearYear} 年${clearEmployeeId === 'all' ? '全部員工' : ''}的假期資料？此操作無法復原！`)) return
    if (!confirm('再次確認：真的要清除嗎？')) return
    try {
      const res = await fetch(`/api/leave-balance?employeeId=${clearEmployeeId}&year=${clearYear}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const data = await res.json()
      if (res.ok) { alert(`成功清除 ${data.count} 筆記錄`); fetchBalances() }
      else alert(data.error || '清除失敗')
    } catch (err) { alert('清除失敗') }
  }

  // Auto-calculate entitlements handler
  const handleRefreshEntitlements = async () => {
    if (!confirm('確定自動計算所有在職員工的年假額度？')) return
    setRefreshing(true)
    setRefreshResult('')
    try {
      const res = await fetch('/api/leave-balance/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // 全員；將來單人重算送 { employeeId }
      })
      const data = await res.json()
      if (res.ok) {
        setRefreshResult(`✅ 完成！更新 ${data.refreshedCount || data.updatedCount || 0} 筆記錄`)
        fetchBalances()
      } else {
        setRefreshResult(`❌ ${data.error || '計算失敗'}`)
      }
    } catch (err) {
      setRefreshResult('❌ 網絡錯誤')
    } finally {
      setRefreshing(false)
    }
  }

  // Settlement handler
  const handleSettlement = async () => {
    if (!settlementForm.employeeId || !settlementForm.resignDate || !settlementForm.monthlySalary) {
      alert('請填寫所有欄位')
      return
    }
    setSettlementLoading(true)
    setSettlementResult(null)
    try {
      const res = await fetch('/api/leave-settlement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          employeeId: settlementForm.employeeId,
          resignDate: settlementForm.resignDate,
          monthlySalary: parseFloat(settlementForm.monthlySalary),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setSettlementResult(data)
      } else {
        alert(data.error || '結算失敗')
      }
    } catch (err) {
      alert('網絡錯誤')
    } finally {
      setSettlementLoading(false)
    }
  }

  // OT 兌換 handler
  const handleConvert = async () => {
    if (!convertForm.employeeId || !convertForm.days) { alert('請填寫所有欄位'); return }
    setConverting(true)
    setConvertResult('')
    try {
      const res = await fetch('/api/timebank/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          employeeId: convertForm.employeeId,
          direction: convertForm.direction,
          days: parseFloat(convertForm.days),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setConvertResult('✅ 兌換成功')
        setConvertForm({ employeeId: '', days: '', direction: 'to_leave' })
        fetchBalances()
        // Refresh time account overview
        const ym = toHKDateStr(new Date()).slice(0, 7)
        fetch(`/api/payroll-runs/exceptions?periodMonth=${ym}`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then(d => d && setTbOverview((d.summaries || []).filter((e: any) => e.timeAccountMinutes != null)))
      } else {
        setConvertResult(`❌ ${data.error || '兌換失敗'}`)
      }
    } catch (err) {
      setConvertResult('❌ 網絡錯誤')
    } finally {
      setConverting(false)
    }
  }

  // 初始化時間帳戶 handler
  const handleInitAccount = async () => {
    if (!initAccountForm.employeeId || !initAccountForm.reason?.trim()) {
      alert('請填寫員工和原因')
      return
    }
    // Calculate total minutes from days + minutes + direction
    const daysVal = parseFloat(initAccountForm.days) || 0
    const minutesVal = parseInt(initAccountForm.minutes) || 0
    const totalMin = daysVal * 540 + minutesVal
    if (totalMin === 0) { alert('天數和分鐘數合計需非零'); return }
    const signed = initAccountForm.direction === 'debt' ? -Math.round(totalMin) : Math.round(totalMin)

    setInitAccountLoading(true)
    setInitAccountResult('')
    try {
      const res = await fetch('/api/timebank/init-adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          employeeId: initAccountForm.employeeId,
          minutes: signed,
          effectiveMonth: initAccountForm.effectiveMonth,
          reason: initAccountForm.reason,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setInitAccountResult(`✅ 初始化成功：帳戶 ${signed >= 0 ? '+' : ''}${signed} 分鐘`)
        setInitAccountForm({ employeeId: '', days: '', minutes: '', direction: 'debt', effectiveMonth: toHKDateStr(new Date()).slice(0, 7), reason: '' })
        // Refresh time account overview
        const ym = toHKDateStr(new Date()).slice(0, 7)
        fetch(`/api/payroll-runs/exceptions?periodMonth=${ym}`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then(d => d && setTbOverview((d.summaries || []).filter((e: any) => e.timeAccountMinutes != null)))
      } else {
        setInitAccountResult(`❌ ${data.error || '初始化失敗'}`)
      }
    } catch (err) {
      setInitAccountResult('❌ 網絡錯誤')
    } finally {
      setInitAccountLoading(false)
    }
  }

  if (loading) return <div className="main-content" style={{ padding: 24 }}>載入中...</div>

  const tabs = [
    { key: 'balance' as TabKey, label: '假期餘額' },
    ...(isOwner ? [{ key: 'types' as TabKey, label: '假期類型設定' }] : []),
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', margin: 0 }}>假期管理</h1>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '2px solid #eee', paddingBottom: 0 }}>
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '8px 16px', border: 'none', borderBottom: activeTab === tab.key ? '2px solid #1a1a2e' : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? '#1a1a2e' : '#888', transition: 'all 0.2s',
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Balance Tab */}
      {activeTab === 'balance' && (
        <>
          {/* 1. 假期餘額（含員工篩選） */}
          <section className="card p-4 border border-slate-200 rounded-lg mb-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold">假期餘額</h3>
              {isManager && (
                <select value={balanceEmployeeId} onChange={e => setBalanceEmployeeId(e.target.value)}
                  className="px-3 py-1.5 rounded-md border text-sm">
                  <option value="all">全部員工</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.user?.name || e.id}</option>)}
                </select>
              )}
            </div>
            {balances.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {balances
                  .filter(b => balanceEmployeeId === 'all' || b.employeeId === balanceEmployeeId)
                  // 週年發放制：年假只顯示當年
                  .filter(b => {
                    if (b.leaveTypeId === annualLeaveTypeId && b.year !== currentYear) return false
                    return true
                  })
                  .map(b => (
                    <div key={b.id} style={{
                      padding: 16, borderRadius: 8,
                      background: `${b.leaveType.color || '#1a1a2e'}10`,
                      borderLeft: `4px solid ${b.leaveType.color || '#1a1a2e'}`,
                    }}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                        {b.employee?.user?.name || b.employeeId}
                      </div>
                      <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>{b.leaveType.name} ({b.year})</div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{b.remaining.toFixed(1)}</div>
                      <div style={{ fontSize: 12, color: '#888' }}>
                        剩餘 / 已用 {b.used.toFixed(1)} / 共 {b.entitled.toFixed(1)} 天
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>尚無假期餘額記錄</div>
            )}
          </section>

          {/* 2. 時間帳戶總覽（累計） */}
          {isManager && (
            <div className="border rounded-xl p-4 mb-4">
              <h3 className="font-semibold mb-1">⏱ 時間帳戶總覽（累計）</h3>
              <p className="text-xs text-muted-foreground mb-3">正數 = 公司欠員工（可換假）；負數 = 員工拖欠（可用休息日還鐘）</p>
              {tbLoading ? (
                <div className="text-sm text-muted-foreground">載入中...</div>
              ) : tbOverview.length === 0 ? (
                <div className="text-sm text-muted-foreground">暫無資料（兼職不計時間帳戶）</div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground text-left">
                      <th className="py-1">員工</th>
                      <th className="py-1 text-right">時間帳戶</th>
                      <th className="py-1 text-right">≈ 天數</th>
                      <th className="py-1 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...tbOverview]
                      .sort((a, b) => (a.timeAccountMinutes ?? 0) - (b.timeAccountMinutes ?? 0))
                      .map(e => {
                        const m = e.timeAccountMinutes ?? 0
                        return (
                          <tr key={e.employeeId} className="border-t">
                            <td className="py-1.5">{e.employeeName}</td>
                            <td className={`py-1.5 text-right font-mono font-semibold ${m < 0 ? 'text-red-600' : m > 0 ? 'text-emerald-600' : ''}`}>
                              {m > 0 ? '+' : ''}{m.toLocaleString()} 分鐘
                            </td>
                            <td className="py-1.5 text-right text-muted-foreground">{(m / 540).toFixed(1)} 天</td>
                            <td className="py-1.5 text-right">
                              {m > 0 && (
                                <button className="text-xs underline text-primary mr-2"
                                  onClick={() => setConvertForm(f => ({ ...f, employeeId: e.employeeId, direction: 'to_leave' }))}>
                                  換假
                                </button>
                              )}
                              {m < 0 && (
                                <button className="text-xs underline text-primary mr-2"
                                  onClick={() => setConvertForm(f => ({ ...f, employeeId: e.employeeId, direction: 'rest_to_account' }))}>
                                  還鐘
                                </button>
                              )}
                              {isOwner && (
                                <button className="text-xs underline text-muted-foreground"
                                  onClick={() => setInitAccountForm(f => ({ ...f, employeeId: e.employeeId }))}>
                                  初始化
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          )}

          {/* 3. OT 假期兌換（OWNER+MANAGER） */}
          {isManager && (
            <section className="card p-4 border border-purple-200 rounded-lg mb-4" style={{ background: '#faf5ff' }}>
              <h3 className="font-semibold mb-2">🔄 OT 假期兌換</h3>
              <p className="text-sm text-muted-foreground mb-3">
                OT → 換假：9小時 OT 時間換 1 天假 | OT假 → 換回OT：把 OT 換的假換回 OT 時間 | 休息日 → 還時間帳戶：用休息日餘額償還拖欠
              </p>
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">員工</label>
                  <select value={convertForm.employeeId} onChange={e => setConvertForm({ ...convertForm, employeeId: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="">-- 選擇 --</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.user?.name || e.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">天數</label>
                  <input type="number" value={convertForm.days} onChange={e => {
                    if (convertForm.direction === 'rest_to_account') {
                      const v = parseFloat(e.target.value)
                      setConvertForm({ ...convertForm, days: isFinite(v) && v > 0 ? String(v) : '' })
                    } else {
                      const v = parseInt(e.target.value, 10)
                      setConvertForm({ ...convertForm, days: v > 0 ? String(v) : '' })
                    }
                  }}
                    className="px-3 py-2 rounded-md border text-sm w-20" min="0.5" step={convertForm.direction === 'rest_to_account' ? '0.5' : '1'} placeholder="天" />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">方向</label>
                  <select value={convertForm.direction} onChange={e => setConvertForm({ ...convertForm, direction: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="to_leave">OT → 換假</option>
                    <option value="to_ot">OT假 → 換回OT</option>
                    <option value="rest_to_account">休息日 → 還時間帳戶</option>
                  </select>
                </div>
                <button
                  className="px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors"
                  style={{ background: '#7c3aed' }}
                  onClick={handleConvert}
                  disabled={converting}
                >
                  {converting ? '兌換中...' : '兌換'}
                </button>
              </div>
              {/* Fix #3: 選員工後顯示 OT 資訊（非 rest_to_account 方向時） */}
              {convertEmpInfo && convertForm.direction !== 'rest_to_account' && (
                <div className="p-3 bg-blue-50 rounded-lg text-sm mb-4" style={{ marginTop: 8 }}>
                  <div>OT 時間：{(convertEmpInfo.otMinutes / 60).toFixed(1)} 小時（{convertEmpInfo.availableMinutes} 分鐘可用）</div>
                  <div>可換假期：<strong>{convertEmpInfo.convertibleLeaveDays} 天</strong></div>
                  {convertEmpInfo.owedMinutes > 0 && (
                    <div className="text-red-600">拖欠：{(convertEmpInfo.owedMinutes / 60).toFixed(1)} 小時</div>
                  )}
                </div>
              )}
              {/* rest_to_account 方向顯示休息日餘額 */}
              {convertForm.direction === 'rest_to_account' && restDayBalance !== null && (
                <div className="p-3 bg-green-50 rounded-lg text-sm mb-4" style={{ marginTop: 8 }}>
                  <div>可用休息日餘額：<strong>{restDayBalance?.toFixed(1) ?? 0} 天</strong></div>
                  {convertForm.days && isFinite(parseFloat(convertForm.days)) && parseFloat(convertForm.days) > 0 && (
                    <div>換算：{parseFloat(convertForm.days)} 天 = +{Math.round(parseFloat(convertForm.days) * 540)} 分鐘</div>
                  )}
                </div>
              )}
              {convertResult && (
                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 13,
                  background: convertResult.startsWith('✅') ? '#f0fff4' : '#fff5f5',
                  color: convertResult.startsWith('✅') ? '#22543d' : '#c53030',
                  border: `1px solid ${convertResult.startsWith('✅') ? '#c6f6d5' : '#fed7d7'}` }}>
                  {convertResult}
                </div>
              )}
            </section>
          )}

          {/* 2b. 初始化時間帳戶（OWNER only） */}
          {isOwner && (() => {
            const previewDays = parseFloat(initAccountForm.days) || 0
            const previewMins = parseInt(initAccountForm.minutes) || 0
            const previewTotal = previewDays * 540 + previewMins
            const previewSigned = initAccountForm.direction === 'debt' ? -Math.round(previewTotal) : Math.round(previewTotal)
            return (
            <section className="card p-4 border border-amber-200 rounded-lg mb-4" style={{ background: '#fffbeb' }}>
              <h3 className="font-semibold mb-2">⚙️ 初始化時間帳戶</h3>
              <p className="text-sm text-muted-foreground mb-3">
                入職/遷移用：直接設定員工時間帳戶（1日=540分鐘）。生效月起全鏈重算。
              </p>
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">員工</label>
                  <select value={initAccountForm.employeeId} onChange={e => setInitAccountForm({ ...initAccountForm, employeeId: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="">-- 選擇 --</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.user?.name || e.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">天數</label>
                  <input type="number" value={initAccountForm.days} onChange={e => setInitAccountForm({ ...initAccountForm, days: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm w-20" step="0.5" placeholder="0" />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">額外分鐘</label>
                  <input type="number" value={initAccountForm.minutes} onChange={e => setInitAccountForm({ ...initAccountForm, minutes: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm w-20" placeholder="0" />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">方向</label>
                  <select value={initAccountForm.direction} onChange={e => setInitAccountForm({ ...initAccountForm, direction: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="debt">拖欠（負）</option>
                    <option value="credit">進帳（正）</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">生效月份</label>
                  <input type="month" value={initAccountForm.effectiveMonth} onChange={e => setInitAccountForm({ ...initAccountForm, effectiveMonth: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm" />
                </div>
                <div className="flex-1 min-w-[160px]">
                  <label className="block text-xs text-muted-foreground mb-1">原因（必填）</label>
                  <input type="text" value={initAccountForm.reason} onChange={e => setInitAccountForm({ ...initAccountForm, reason: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm w-full" placeholder="如：入職初始設定" />
                </div>
                <button
                  className="px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors"
                  style={{ background: '#d97706' }}
                  onClick={handleInitAccount}
                  disabled={initAccountLoading}
                >
                  {initAccountLoading ? '處理中...' : '初始化'}
                </button>
              </div>
              {/* 即時預覽 */}
              {initAccountForm.employeeId && previewSigned !== 0 && (
                <div className="p-3 bg-amber-100 rounded-lg text-sm" style={{ marginTop: 8 }}>
                  預覽：{employees.find(e => e.id === initAccountForm.employeeId)?.user?.name || '未知'}：
                  合計：{initAccountForm.direction === 'debt' ? '拖欠' : '進帳'} {Math.abs(previewSigned).toLocaleString()} 分鐘
                  {' '}（{previewDays || 0} 天 × 540 {previewMins ? `+ ${previewMins} 分` : ''}）
                  ，自 {initAccountForm.effectiveMonth} 起生效 → 帳戶 {previewSigned >= 0 ? '+' : ''}{previewSigned}
                </div>
              )}
              {initAccountResult && (
                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 13,
                  background: initAccountResult.startsWith('✅') ? '#f0fff4' : '#fff5f5',
                  color: initAccountResult.startsWith('✅') ? '#22543d' : '#c53030',
                  border: `1px solid ${initAccountResult.startsWith('✅') ? '#c6f6d5' : '#fed7d7'}` }}>
                  {initAccountResult}
                </div>
              )}
            </section>
            )
          })()}
          

          {/* 3. 初始化假期額度（OWNER only） */}
          {isManager && (
            <section className="card p-4 border border-slate-200 rounded-lg mb-4">
              <h3 className="font-semibold mb-2">初始化假期額度</h3>
              <p className="text-sm text-muted-foreground mb-3">為員工設定本年度假期額度（若已存在則覆蓋）</p>
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">員工</label>
                  <select value={initForm.employeeId} onChange={e => setInitForm({ ...initForm, employeeId: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="all">全部員工</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.user?.name || e.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">假期類型</label>
                  <select value={initForm.leaveTypeId} onChange={e => setInitForm({ ...initForm, leaveTypeId: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="">-- 選擇 --</option>
                    {leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">額度（天）</label>
                  <input type="number" value={initForm.days} onChange={e => setInitForm({ ...initForm, days: parseInt(e.target.value) || 0 })}
                    className="px-3 py-2 rounded-md border text-sm w-20" min="0" />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">年份</label>
                  <input type="number" value={initForm.year} onChange={e => setInitForm({ ...initForm, year: parseInt(e.target.value) || 2026 })}
                    className="px-3 py-2 rounded-md border text-sm w-20" min="2020" max="2030" />
                </div>
                <button className="px-3 py-2 rounded-md text-sm font-semibold text-white transition-colors" style={{ background: '#0d6efd' }}
                  onClick={handleInitLeave} disabled={!initForm.leaveTypeId}>
                  <span className="flex items-center gap-1"><Plus size={14} /> 初始化</span>
                </button>
              </div>
            </section>
          )}

          {/* 4. 自動計算年假額度（OWNER only） */}
          {isManager && (
            <section className="card p-4 border border-blue-200 rounded-lg mb-4" style={{ background: '#f0f7ff' }}>
              <h3 className="font-semibold mb-2">📊 自動計算年假額度</h3>
              <p className="text-sm text-muted-foreground mb-3">
                按香港僱傭條例自動計算所有在職員工的年假額度（按年資 7→14 天、按比例天數版、跨年累積）。
                會保留已放的假期天數，只更新額度。
              </p>
              <div className="flex gap-3 items-center">
                <button
                  className="px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors"
                  style={{ background: '#0d6efd' }}
                  onClick={handleRefreshEntitlements}
                  disabled={refreshing}
                >
                  {refreshing ? '計算中...' : '🔄 自動計算全部'}
                </button>
              </div>
              {refreshResult && (
                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 13,
                  background: refreshResult.startsWith('✅') ? '#f0fff4' : '#fff5f5',
                  color: refreshResult.startsWith('✅') ? '#22543d' : '#c53030',
                  border: `1px solid ${refreshResult.startsWith('✅') ? '#c6f6d5' : '#fed7d7'}` }}>
                  {refreshResult}
                </div>
              )}
            </section>
          )}

          {/* 5. 離職結算（OWNER only） */}
          {isManager && (
            <section className="card p-4 border border-orange-200 rounded-lg mb-4">
              <h3 className="font-semibold mb-2">📋 離職結算（年假折算）</h3>
              <p className="text-sm text-muted-foreground mb-3">
                計算離職員工未放年假的折算工資 = 月薪 × 12/365 × 未放天數
              </p>
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">員工</label>
                  <select value={settlementForm.employeeId} onChange={e => setSettlementForm({ ...settlementForm, employeeId: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="">-- 選擇 --</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.user?.name || e.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">離職日期</label>
                  <input type="date" value={settlementForm.resignDate} onChange={e => setSettlementForm({ ...settlementForm, resignDate: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">月薪</label>
                  <input type="number" value={settlementForm.monthlySalary} onChange={e => setSettlementForm({ ...settlementForm, monthlySalary: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm w-24" min="0" />
                </div>
                <button
                  className="px-3 py-2 rounded-md text-sm font-semibold text-white transition-colors"
                  style={{ background: '#e67e22' }}
                  onClick={handleSettlement}
                  disabled={settlementLoading}
                >
                  {settlementLoading ? '計算中...' : '計算結算'}
                </button>
              </div>
              {settlementResult?.settlement && (
                <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a' }}>
                  <div className="grid grid-cols-4 gap-4" style={{ fontSize: 13 }}>
                    <div><span className="text-muted-foreground">累計應得：</span><strong>{settlementResult.settlement.accrued?.toFixed(2) ?? '0.00'} 天</strong></div>
                    <div><span className="text-muted-foreground">已放：</span><strong>{settlementResult.settlement.used?.toFixed(2) ?? '0.00'} 天</strong></div>
                    <div><span className="text-muted-foreground">未放：</span><strong>{settlementResult.settlement.unused?.toFixed(2) ?? '0.00'} 天</strong></div>
                    <div><span className="text-muted-foreground">折算金額：</span><strong style={{ color: '#c53030' }}>${settlementResult.settlement.payout?.toLocaleString() ?? '0'}</strong></div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 6. 清除假期資料（OWNER only，紅色警示） */}
          {isManager && (
            <section className="card p-4 border border-red-200 rounded-lg mb-4">
              <h3 className="text-red-600 font-semibold mb-2">清除假期資料</h3>
              <p className="text-sm text-muted-foreground mb-3">⚠️ 此操作會刪除選定範圍的假期餘額，無法復原</p>
              <div className="flex gap-3 items-end">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">範圍</label>
                  <select value={clearEmployeeId} onChange={e => setClearEmployeeId(e.target.value)}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="all">全部員工</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.user?.name || e.id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">年份</label>
                  <input type="number" value={clearYear} onChange={e => setClearYear(parseInt(e.target.value) || 2026)}
                    className="px-3 py-2 rounded-md border text-sm w-20" />
                </div>
                <button className="px-3 py-2 rounded-md text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors"
                  onClick={handleClearLeave}>
                  清除
                </button>
              </div>
            </section>
          )}
        </>
      )}

      {/* Leave Types Tab (OWNER only) */}
      {activeTab === 'types' && isOwner && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: '#1a1a2e', margin: 0 }}>假期類型管理</h2>
            <button className="btn btn-primary" onClick={() => { setLtShowForm(true); setLtEditingId(null); }}>
              <span className="flex items-center gap-1"><Plus size={16} /> 新增類型</span>
            </button>
          </div>

          {/* Leave Types Form */}
          {ltShowForm && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h2>{ltEditingId ? '編輯假期類型' : '新增假期類型'}</h2>
              <form onSubmit={handleLtSubmit}>
                <div className="grid-3" style={{ marginBottom: 0 }}>
                  <div className="form-group">
                    <label>名稱</label>
                    <input type="text" value={ltForm.name} onChange={e => setLtForm({ ...ltForm, name: e.target.value })} required placeholder="如：年假" />
                  </div>
                  <div className="form-group">
                    <label>年度額度（天，可選）</label>
                    <input type="number" step="0.5" value={ltForm.annualQuota} onChange={e => setLtForm({ ...ltForm, annualQuota: e.target.value })} placeholder="留空=無限制" />
                  </div>
                  <div className="form-group">
                    <label>顏色標記</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="color" value={ltForm.color} onChange={e => setLtForm({ ...ltForm, color: e.target.value })}
                        style={{ width: 40, height: 32, border: 'none', cursor: 'pointer' }} />
                      <span style={{ fontSize: 13, color: '#888' }}>{ltForm.color}</span>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>有薪</label>
                    <select value={ltForm.isPaid ? '1' : '0'} onChange={e => setLtForm({ ...ltForm, isPaid: e.target.value === '1' })}>
                      <option value="1">是</option>
                      <option value="0">否</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={ltForm.cancelsBonus}
                        disabled={!!(ltEditingId && leaveTypes.find(t => t.id === ltEditingId)?.systemKey)}
                        onChange={e => setLtForm({ ...ltForm, cancelsBonus: e.target.checked })}
                      />
                      請此假當月取消勤工獎
                    </label>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn" style={{ background: '#eee', color: '#333' }} onClick={() => { setLtShowForm(false); setLtEditingId(null); }}>取消</button>
                  <button type="submit" className="btn btn-primary">{ltEditingId ? '保存' : '新增'}</button>
                </div>
              </form>
            </div>
          )}

          {/* Leave Types Table */}
          <div className="card overflow-x-auto">
            <table>
              <thead>
                <tr><th>顏色</th><th>名稱</th><th>有薪</th><th>取消勤工</th><th>年度額度</th><th>狀態</th><th>操作</th></tr>
              </thead>
              <tbody>
                {leaveTypes.map(t => {
                  const isSystem = t.systemKey != null
                  return (
                    <tr key={t.id}>
                      <td><div style={{ width: 20, height: 20, borderRadius: 4, background: t.color || '#ccc' }} /></td>
                      <td style={{ fontWeight: 500 }}>
                        {t.name}
                        {isSystem && <span style={{ marginLeft: 6, fontSize: 11, color: '#888' }}>🔒 系統類型</span>}
                      </td>
                      <td>{t.isPaid ? '✅ 有薪' : '❌ 無薪'}</td>
                      <td>{t.cancelsBonus ? '⚠️ 是' : '—'}</td>
                      <td>{t.annualQuota ? `${t.annualQuota} 天` : '無限制'}</td>
                      <td>
                        <label style={{ fontSize: 13, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!t.isActive} onChange={() => !isSystem && handleLtToggleActive(t.id, !!t.isActive)} disabled={isSystem} />
                          {' '}{t.isActive ? '啟用' : '停用'}
                        </label>
                      </td>
                      <td>
                        {isSystem ? (
                          <span style={{ fontSize: 11, color: '#888' }}>計算核心，不可刪除</span>
                        ) : (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => handleLtEdit(t)}>編輯</button>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={async () => {
                                if (!confirm(`確定刪除「${t.name}」？`)) return
                                const res = await fetch(`/api/leave-types/${t.id}`, { method: 'DELETE', credentials: 'include' })
                                if (res.ok) fetchData()
                                else { const err = await res.json(); alert(err.error || '刪除失敗') }
                              }}
                            >刪除</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
