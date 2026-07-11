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
  leaveType: { id: string; name: string; isPaid: boolean; annualQuota: number | null; color: string | null }
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

  // Leave Types management state
  const [activeTab, setActiveTab] = useState<TabKey>('balance')
  const [ltShowForm, setLtShowForm] = useState(false)
  const [ltForm, setLtForm] = useState({ name: '', isPaid: true, annualQuota: '', color: '#4CAF50' })
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

  const isManager = userRole === 'OWNER' || userRole === 'MANAGER'
  const isOwner = userRole === 'OWNER'

  const fetchData = useCallback(async () => {
    try {
      const meRes = await fetch('/api/me', { credentials: 'include' })
      const meData = await meRes.json()
      setUserRole(meData.user.role as Role)
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
      if (isManager) {
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
      const body: any = { name: ltForm.name, isPaid: ltForm.isPaid, color: ltForm.color }
      if (ltForm.annualQuota) body.annualQuota = parseFloat(ltForm.annualQuota)
      else body.annualQuota = null

      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
      if (res.ok) {
        setLtForm({ name: '', isPaid: true, annualQuota: '', color: '#4CAF50' })
        setLtShowForm(false); setLtEditingId(null); fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '操作失敗')
      }
    } catch (err) { console.error('Submit error:', err) }
  }

  const handleLtEdit = (t: LeaveType) => {
    setLtForm({ name: t.name, isPaid: t.isPaid, annualQuota: t.annualQuota?.toString() || '', color: t.color || '#4CAF50' })
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
      })
      const data = await res.json()
      if (res.ok) {
        setRefreshResult(`✅ 完成！更新 ${data.updatedCount || 0} 筆記錄`)
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
      } else {
        setConvertResult(`❌ ${data.error || '兌換失敗'}`)
      }
    } catch (err) {
      setConvertResult('❌ 網絡錯誤')
    } finally {
      setConverting(false)
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
          {isManager && (
            <>
              {/* 初始化假期額度 */}
              <div className="card p-4 border border-slate-200 rounded-lg mb-4">
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
              </div>

              {/* 清除假期資料 */}
              <div className="card p-4 border border-red-200 rounded-lg mb-4">
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
              </div>
            </>
          )}

          {isManager && (
            <>
              {/* 自動計算年假額度 */}
              <div className="card p-4 border border-blue-200 rounded-lg mb-4" style={{ background: '#f0f7ff' }}>
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
                  <span className="text-xs text-muted-foreground" id="refreshResult"></span>
                </div>
                {refreshResult && (
                  <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 13,
                    background: refreshResult.startsWith('✅') ? '#f0fff4' : '#fff5f5',
                    color: refreshResult.startsWith('✅') ? '#22543d' : '#c53030',
                    border: `1px solid ${refreshResult.startsWith('✅') ? '#c6f6d5' : '#fed7d7'}` }}>
                    {refreshResult}
                  </div>
                )}
              </div>

              {/* 離職結算 */}
              <div className="card p-4 border border-orange-200 rounded-lg mb-4">
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
                {settlementResult && (
                  <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a' }}>
                    <div className="grid grid-cols-4 gap-4" style={{ fontSize: 13 }}>
                      <div><span className="text-muted-foreground">累計應得：</span><strong>{settlementResult.accrued.toFixed(2)} 天</strong></div>
                      <div><span className="text-muted-foreground">已放：</span><strong>{settlementResult.used.toFixed(2)} 天</strong></div>
                      <div><span className="text-muted-foreground">未放：</span><strong>{settlementResult.unused.toFixed(2)} 天</strong></div>
                      <div><span className="text-muted-foreground">折算金額：</span><strong style={{ color: '#c53030' }}>${settlementResult.payout.toLocaleString()}</strong></div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* OT 假期兌換（OWNER only） */}
          {isManager && (
            <div className="card p-4 border border-purple-200 rounded-lg mb-4" style={{ background: '#faf5ff' }}>
              <h3 className="font-semibold mb-2">🔄 OT 假期兌換</h3>
              <p className="text-sm text-muted-foreground mb-3">
                OT → 換假：9小時 OT 時間換 1 天假 | OT假 → 換回OT：把 OT 換的假換回 OT 時間
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
                  <input type="number" value={convertForm.days} onChange={e => setConvertForm({ ...convertForm, days: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm w-20" min="0.5" step="0.5" placeholder="天" />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">方向</label>
                  <select value={convertForm.direction} onChange={e => setConvertForm({ ...convertForm, direction: e.target.value })}
                    className="px-3 py-2 rounded-md border text-sm">
                    <option value="to_leave">OT → 換假</option>
                    <option value="to_ot">OT假 → 換回OT</option>
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
              {convertResult && (
                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 13,
                  background: convertResult.startsWith('✅') ? '#f0fff4' : '#fff5f5',
                  color: convertResult.startsWith('✅') ? '#22543d' : '#c53030',
                  border: `1px solid ${convertResult.startsWith('✅') ? '#c6f6d5' : '#fed7d7'}` }}>
                  {convertResult}
                </div>
              )}
            </div>
          )}

          {balances.length > 0 ? (
            <div className="card">
              <h2>假期餘額</h2>
              <div className="grid-4" style={{ marginBottom: 0 }}>
                {balances.map(b => (
                  <div key={b.id} style={{
                    padding: 16, borderRadius: 8,
                    background: `${b.leaveType.color || '#1a1a2e'}10`,
                    borderLeft: `4px solid ${b.leaveType.color || '#1a1a2e'}`,
                  }}>
                    <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>{b.leaveType.name} ({b.year})</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{b.remaining.toFixed(1)}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>
                      剩餘 / 已用 {b.used.toFixed(1)} / 共 {b.entitled.toFixed(1)} 天
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', padding: 40, color: '#888' }}>尚無假期餘額記錄</div>
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
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn" style={{ background: '#eee', color: '#333' }} onClick={() => { setLtShowForm(false); setLtEditingId(null); }}>取消</button>
                  <button type="submit" className="btn btn-primary">{ltEditingId ? '保存' : '新增'}</button>
                </div>
              </form>
            </div>
          )}

          {/* Leave Types Table */}
          <div className="card">
            <table>
              <thead>
                <tr><th>顏色</th><th>名稱</th><th>有薪</th><th>年度額度</th><th>狀態</th><th>操作</th></tr>
              </thead>
              <tbody>
                {leaveTypes.map(t => (
                  <tr key={t.id}>
                    <td><div style={{ width: 20, height: 20, borderRadius: 4, background: t.color || '#ccc' }} /></td>
                    <td style={{ fontWeight: 500 }}>{t.name}</td>
                    <td>{t.isPaid ? '✅ 有薪' : '❌ 無薪'}</td>
                    <td>{t.annualQuota ? `${t.annualQuota} 天` : '無限制'}</td>
                    <td>
                      <label style={{ fontSize: 13, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!t.isActive} onChange={() => handleLtToggleActive(t.id, !!t.isActive)} />
                        {' '}{t.isActive ? '啟用' : '停用'}
                      </label>
                    </td>
                    <td>
                      <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => handleLtEdit(t)}>編輯</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
