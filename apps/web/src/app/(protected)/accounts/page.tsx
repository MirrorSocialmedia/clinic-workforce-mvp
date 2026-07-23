'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Wallet, Plus, Eye, EyeOff } from 'lucide-react'
import { RuleComposerModal } from '@/components/RuleComposerModal'
import { fmtDate } from '@/lib/hk-date'
import { PERMISSIONS, ROLE_DEFAULTS, hasPermission } from '@/lib/permissions'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE' | 'KIOSK'

interface Clinic { id: string; name: string }
interface Account {
  id: string; name: string; phone: string; email?: string | null
  role: Role; status: string; createdAt: string
  employeeId: string | null
  employeeStatus: string | null
  joinDate: string | null
  payType: string | null
  baseAmount: number | null
  payConfidential: boolean
  homeClinicId: string | null
  resignedAt: string | null
  permissionsJson: string | null
  clinics: Clinic[]
}

const STATUS_LABELS: Record<string, string> = { ACTIVE: '啟用', INACTIVE: '停用', RESIGNED: '已離職' }
const ROLE_LABELS: Record<string, string> = { OWNER: 'Owner', MANAGER: 'Manager', ACCOUNTANT: 'Accountant', EMPLOYEE: 'Employee', KIOSK: '打卡屏' }

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [userRole, setUserRole] = useState<Role | ''>('')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [clinicFilter, setClinicFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [showForm, setShowForm] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showPayRuleModal, setShowPayRuleModal] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const [payRuleEmployeeId, setPayRuleEmployeeId] = useState<string | null>(null)
  const [leaveBalances, setLeaveBalances] = useState<Record<string, any[]>>({})
  const [payRules, setPayRules] = useState<Record<string, any>>({})
  const [enrollCode, setEnrollCode] = useState<{ code: string; name: string } | null>(null)

  // Resign / Rehire state
  const [showResigned, setShowResigned] = useState(false)
  const [showResignModal, setShowResignModal] = useState(false)
  const [resignEmployee, setResignEmployee] = useState<Account | null>(null)
  const [lastDay, setLastDay] = useState(new Date().toISOString().split('T')[0])
  const [resignPreview, setResignPreview] = useState<{ futureShifts: number; futureApprovedLeaves: number } | null>(null)
  const [resignLoading, setResignLoading] = useState(false)

  // KIOSK account creation state
  const [showKioskForm, setShowKioskForm] = useState(false)
  const [kioskForm, setKioskForm] = useState({
    clinicId: '',
    phone: '',
    password: '',
    ipAllowlist: '',
  })
  const [kioskLoading, setKioskLoading] = useState(false)
  const [kioskCreatedPassword, setKioskCreatedPassword] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '', phone: '', email: '', password: '', role: 'EMPLOYEE' as Role,
    clinicIds: [] as string[], joinDate: '',
    payType: 'HOURLY', baseAmount: '',
    assignEmployee: true,
    payConfidential: false,
    annualLeave: '12',  // string — parse on submit
    employeeId: null as string | null,
    homeClinicId: '',
    permGrant: [] as string[], // permissions granted beyond role default
    permDeny: [] as string[],  // permissions denied despite role default
  })

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [meRes, accRes, clinicRes] = await Promise.all([
        fetch('/api/me', { credentials: 'include' }),
        fetch('/api/accounts', { credentials: 'include' }),
        fetch('/api/clinics', { credentials: 'include' }),
      ])
      if (meRes.ok) { const d = await meRes.json(); setUserRole(d.user.role) }
      if (accRes.ok) { const d = await accRes.json(); setAccounts(d.accounts || []) }
      if (clinicRes.ok) { const d = await clinicRes.json(); setClinics(d.clinics || []) }
    } catch (err) { console.error('Failed to load accounts:', err) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Fetch resign preview when modal is open and lastDay changes
  useEffect(() => {
    if (!showResignModal || !resignEmployee?.employeeId) return
    const fetchPreview = async () => {
      try {
        const res = await fetch(
          `/api/employees/${resignEmployee.employeeId}/resign-preview?lastDay=${lastDay}`,
          { credentials: 'include' }
        )
        if (res.ok) {
          const data = await res.json()
          setResignPreview({ futureShifts: data.futureShifts, futureApprovedLeaves: data.futureApprovedLeaves })
        }
      } catch {}
    }
    fetchPreview()
  }, [showResignModal, resignEmployee, lastDay])

  // Auto-select homeClinicId = first assigned clinic when none set yet
  useEffect(() => {
    if (form.assignEmployee && form.clinicIds.length > 0 && !form.homeClinicId) {
      setForm(f => ({ ...f, homeClinicId: f.clinicIds[0] }))
    }
  }, [form.clinicIds, form.assignEmployee])

  const filteredAccounts = accounts.filter(acc => {
    // Hide resigned employees by default
    if (!showResigned && acc.employeeStatus === 'RESIGNED') return false
    if (search && !acc.name.toLowerCase().includes(search.toLowerCase()) && !acc.phone.includes(search)) return false
    if (roleFilter !== 'all' && acc.role !== roleFilter) return false
    if (clinicFilter !== 'all' && !acc.clinics?.some(c => c.id === clinicFilter)) return false
    if (statusFilter !== 'all' && acc.status !== statusFilter.toUpperCase()) return false
    return true
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validate: KIOSK must bind exactly one clinic
    if (!editingId && form.role === 'KIOSK' && form.clinicIds.length !== 1) {
      alert('打卡屏必須綁定一間診所')
      return
    }

    // Validate: at least one clinic required when creating employee
    if (!editingId && form.assignEmployee && form.clinicIds.length === 0) {
      alert('請至少選擇一個診所')
      return
    }

    try {
      const method = editingId ? 'PUT' : 'POST'
      const url = editingId ? `/api/accounts/${editingId}` : '/api/accounts'
      const body: any = {
        name: form.name, phone: form.phone, email: form.email || undefined,
        role: form.role, clinicIds: form.clinicIds,
      }

      // KIOSK: no employee data, no permissions
      if (form.role !== 'KIOSK') {
        body.joinDate = form.joinDate || undefined
        body.payType = form.payType
        body.baseAmount = form.baseAmount ? parseFloat(form.baseAmount) : null
        body.assignEmployee = form.assignEmployee
        body.payConfidential = form.payConfidential
        body.annualLeave = form.assignEmployee ? (parseFloat(form.annualLeave) || 0) : undefined
        body.homeClinicId = form.assignEmployee ? form.homeClinicId || null : undefined

        // Permissions: compute grant/deny diff from ROLE_DEFAULTS
        if (form.role && form.role !== 'OWNER') {
          const defaults = ROLE_DEFAULTS[form.role] || []
          body.permissionsJson = { grant: form.permGrant, deny: form.permDeny }
        }
      }

      if (!editingId && form.password) body.password = form.password
      if (editingId && form.password) body.newPassword = form.password

      const res = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (res.ok) { resetForm(); fetchData() }
      else { const err = await res.json(); alert(err.error || '操作失敗') }
    } catch (err) { console.error('Submit error:', err) }
  }

  const resetForm = () => {
    setForm({ name: '', phone: '', email: '', password: '', role: 'EMPLOYEE',
      clinicIds: [], joinDate: '', payType: 'HOURLY', baseAmount: '', assignEmployee: true,
      payConfidential: false, annualLeave: '12', employeeId: null, homeClinicId: '',
      permGrant: [], permDeny: [] })
    setShowForm(false); setEditingId(null); setShowPwd(false)
  }

  const handleEdit = (acc: Account) => {
    // 解析既有 permissionsJson
    let grant: string[] = []
    let deny: string[] = []
    try {
      const pj = typeof acc.permissionsJson === 'string'
        ? JSON.parse(acc.permissionsJson)
        : acc.permissionsJson
      grant = pj?.grant ?? []
      deny = pj?.deny ?? []
    } catch { /* 舊資料格式異常 → 視為空 */ }

    setForm({ name: acc.name, phone: acc.phone, email: acc.email || '',
      password: '', role: acc.role, clinicIds: acc.clinics?.map(c => c.id) || [],
      joinDate: acc.joinDate || '', payType: acc.payType || 'HOURLY',
      baseAmount: acc.baseAmount?.toString() || '', assignEmployee: !!acc.employeeId,
      payConfidential: acc.payConfidential || false,
      annualLeave: '12', employeeId: acc.employeeId,
      homeClinicId: acc.homeClinicId || '', permGrant: grant, permDeny: deny })
    setEditingId(acc.id); setShowForm(true)
  }

  const handleResetPassword = async (acc: Account) => {
    const newPwd = prompt('輸入新密碼：')
    if (!newPwd) return
    try {
      const res = await fetch(`/api/accounts/${acc.id}`, { method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: newPwd }) })
      if (res.ok) { alert('密碼已重設'); fetchData() }
      else { const err = await res.json(); alert(err.error || '重設失敗') }
    } catch {}
  }

  const handleToggleStatus = async (acc: Account) => {
    const newStatus = acc.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
    try {
      const res = await fetch(`/api/accounts/${acc.id}`, { method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }) })
      if (res.ok) fetchData()
      else { const err = await res.json(); alert(err.error || '操作失敗') }
    } catch {}
  }

  const handleDelete = async (acc: Account) => {
    if (!confirm(`確定刪除帳號「${acc.name}」？此操作不可復原。`)) return
    try {
      const res = await fetch(`/api/accounts/${acc.id}`, { method: 'DELETE', credentials: 'include' })
      if (res.ok) { fetchData() }
      else { const err = await res.json(); alert(err.error || '刪除失敗') }
    } catch { alert('刪除失敗') }
  }

  // ─── Resign / Rehire ───
  const openResign = (acc: Account) => {
    setResignEmployee(acc)
    setLastDay(new Date().toISOString().split('T')[0])
    setResignPreview(null)
    setShowResignModal(true)
  }

  const handleResign = async () => {
    if (!resignEmployee?.employeeId || !lastDay) return
    if (!confirm(`確定為「${resignEmployee.name}」辦理離職？最後工作日：${lastDay}`)) return
    setResignLoading(true)
    try {
      const res = await fetch(`/api/employees/${resignEmployee.employeeId}/resign`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastDay }),
      })
      if (res.ok) {
        setShowResignModal(false)
        setResignEmployee(null)
        fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '離職操作失敗')
      }
    } catch { alert('網絡錯誤') }
    finally { setResignLoading(false) }
  }

  const handleRehire = async (acc: Account) => {
    if (!confirm(`確定為「${acc.name}」辦理復職？`)) return
    try {
      const res = await fetch(`/api/employees/${acc.employeeId}/rehire`, {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok) { fetchData() }
      else { const err = await res.json(); alert(err.error || '復職失敗') }
    } catch { alert('網絡錯誤') }
  }

  const loadLeaveBalances = async (employeeId: string) => {
    if (leaveBalances[employeeId]) return // already loaded
    try {
      const res = await fetch(`/api/leave-balance?employeeId=${employeeId}`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setLeaveBalances(prev => ({ ...prev, [employeeId]: data.leaveBalances || [] }))
      }
    } catch (err) { console.error('Failed to load leave balances:', err) }
  }

  const updateLeaveBalance = async (balanceId: string, field: 'entitled' | 'remaining', value: number) => {
    try {
      const res = await fetch('/api/leave-balance', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balanceId, [field]: value }),
      })
      if (res.ok) {
        const data = await res.json()
        const updated = data.leaveBalance
        setLeaveBalances(prev => {
          const newBalances = { ...prev }
          for (const empId of Object.keys(newBalances)) {
            newBalances[empId] = newBalances[empId].map(b =>
              b.id === balanceId ? updated : b
            )
          }
          return newBalances
        })
      } else {
        const err = await res.json()
        alert(err.error || '更新失敗')
      }
    } catch {}
  }

  const loadPayRules = async (employeeId: string) => {
    if (payRules[employeeId] !== undefined) return // already loaded
    try {
      const res = await fetch(`/api/employees/${employeeId}/pay-rules`, { credentials: 'include' })
      if (res.ok) {
        const rules = await res.json()
        const activeRule = (Array.isArray(rules) ? rules : []).find((r: any) => r.isActive)
        setPayRules(prev => ({ ...prev, [employeeId]: activeRule || null }))
      }
    } catch (err) { console.error('Failed to load pay rules:', err) }
  }

  const getPayInfo = (acc: Account) => {
    const rule = payRules[acc.employeeId!]
    if (rule && rule.configJson) {
      const config = typeof rule.configJson === 'string' ? JSON.parse(rule.configJson) : rule.configJson
      const baseType = config.base_type || ''
      const labels: Record<string, string> = { monthly: '月薪', hourly: '時薪', daily: '日薪', split: '拆帳' }
      let amount = ''
      switch (baseType) {
        case 'monthly': amount = `HK$${config.monthly_salary ?? '-'}`; break
        case 'hourly': amount = `HK$${config.hourly_rate ?? '-'}/時`; break
        case 'daily': amount = `HK$${config.daily_rate ?? '-'}/日`; break
        case 'split': amount = `${config.split_ratio ?? '-'}% (${config.base_guarantee ? `保底 HK$${config.base_guarantee}` : ''})`; break
      }
      return { label: labels[baseType] || (rule.payType || '-'), amount }
    }
    // Fallback to account-level data
    const typeLabel = acc.payType === 'HOURLY' ? '時薪' : acc.payType === 'MONTHLY' ? '月薪' : '-'
    const amount = acc.payType ? `${acc.payType === 'HOURLY' ? '時薪' : '月薪'}: ${acc.baseAmount || 0}` : '-'
    return { label: typeLabel, amount }
  }

  const isOwner = userRole === 'OWNER'

  // KIOSK account creation
  const generateRandomPassword = () => {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    let result = ''
    for (let i = 0; i < 10; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  const openKioskForm = () => {
    const pw = generateRandomPassword()
    setKioskForm({ clinicId: '', phone: '', password: pw, ipAllowlist: '' })
    setShowKioskForm(true)
  }

  const onKioskClinicChange = (clinicId: string) => {
    const clinic = clinics.find(c => c.id === clinicId)
    setKioskForm(f => ({
      ...f,
      clinicId,
      phone: clinic ? `${clinic.name}打卡機` : f.phone,
    }))
  }

  const handleKioskSubmit = async () => {
    if (!kioskForm.clinicId || !kioskForm.phone) {
      alert('請填寫診所和登入號碼')
      return
    }
    setKioskLoading(true)
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: kioskForm.phone,
          phone: kioskForm.phone,
          password: kioskForm.password,
          role: 'KIOSK',
          clinicIds: [kioskForm.clinicId],
          ipAllowlist: kioskForm.ipAllowlist.trim() || undefined,
        }),
      })
      if (res.ok) {
        setKioskCreatedPassword(kioskForm.password)
        setKioskForm({ clinicId: '', phone: '', password: '', ipAllowlist: '' })
        fetchData()
      } else {
        const err = await res.json()
        alert(err.error || '建立失敗')
      }
    } catch (err) {
      alert('網絡錯誤')
    } finally {
      setKioskLoading(false)
    }
  }

  // 週年發放制：年假只顯示當年
  const currentYear = new Date().getFullYear()

  if (loading) return <div className="main-content" style={{ padding: 24 }}>載入中...</div>

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', margin: 0 }} className="flex items-center gap-2"><Plus size={16} /> 帳號管理</h1>
        {isOwner && (
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => { resetForm(); setForm(f => ({ ...f, assignEmployee: true })); setShowForm(true) }}>+ 新增帳號</button>
            <button className="btn" style={{ background: '#6366f1', color: 'white' }} onClick={openKioskForm}>📱 建立打卡螢幕帳號</button>
          </div>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2>{editingId ? '編輯帳號' : '新增帳號'}</h2>
          <form onSubmit={handleSubmit}>
            <div className="grid-3" style={{ marginBottom: 0 }}>
              <div className="form-group">
                <label>姓名</label>
                <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="姓名" />
              </div>
              <div className="form-group">
                <label>電話</label>
                <input type="text" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} required placeholder="電話" />
              </div>
              <div className="form-group">
                <label>電郵（可選）</label>
                <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
              </div>
              <div className="form-group">
                <label>{editingId ? '新密碼（留空=不變）' : '初始密碼'}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPwd ? 'text' : 'password'}
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                    required={!editingId} placeholder="密碼"
                    style={{ paddingRight: 36, width: '100%' }}
                  />
                  <button type="button" onClick={() => setShowPwd(v => !v)}
                    aria-label={showPwd ? '隱藏密碼' : '顯示密碼'}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}>
                    {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label>角色</label>
                <select value={form.role} onChange={e => {
                  const newRole = e.target.value as Role
                  // Reset permissions to role defaults when role changes
                  setForm({ ...form, role: newRole, permGrant: [], permDeny: [] })
                }}>
                  {isOwner && <option value="OWNER">Owner</option>}
                  <option value="MANAGER">Manager</option>
                  <option value="ACCOUNTANT">Accountant</option>
                  <option value="EMPLOYEE">Employee</option>
                  {isOwner && <option value="KIOSK">打卡屏（共享 iPad）</option>}
                </select>
              </div>

              {/* Permissions checkboxes (expand after role selection) */}
              {form.role && form.role !== 'OWNER' && form.role !== 'KIOSK' && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#555' }}>🔑 角色權限（預設勾選 = 角色默認權限，可手動調整）</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {Object.entries(PERMISSIONS).map(([key, label]) => {
                      const defaults = ROLE_DEFAULTS[form.role] || []
                      const inDefault = defaults.includes(key as any)
                      const effective = hasPermission(form.role, key as any, form.permGrant, form.permDeny)
                      return (
                        <label key={key} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                          border: effective ? '1.5px solid #0f766e' : '1px solid #e5e7eb',
                          background: effective ? '#f0fdfa' : '#f9fafb',
                          fontSize: 12, whiteSpace: 'nowrap', color: effective ? '#0f766e' : '#aaa',
                        }}>
                          <input type="checkbox" checked={effective}
                            onChange={e => {
                              const checked = e.target.checked
                              if (checked) {
                                // Enable: remove from deny, add to grant if not in default
                                setForm(f => ({
                                  ...f,
                                  permDeny: f.permDeny.filter(p => p !== key),
                                  permGrant: inDefault ? f.permGrant : [...f.permGrant, key],
                                }))
                              } else {
                                // Disable: remove from grant, add to deny if in default
                                setForm(f => ({
                                  ...f,
                                  permGrant: f.permGrant.filter(p => p !== key),
                                  permDeny: inDefault ? [...f.permDeny, key] : f.permDeny,
                                }))
                              }
                            }} />
                          {label}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}

              {form.role === 'OWNER' && (
                <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#888', padding: '4px 0' }}>
                  🔒 Owner 擁有所有權限，不可調整
                </div>
              )}
              {form.role !== 'KIOSK' && (
                <>
                  <div className="form-group">
                    <label>到職日（員工）</label>
                    <input type="date" value={form.joinDate} onChange={e => setForm({ ...form, joinDate: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>計薪方式</label>
                    <select value={form.payType} onChange={e => setForm({ ...form, payType: e.target.value })}>
                      <option value="HOURLY">時薪</option>
                      <option value="MONTHLY">月薪</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>{form.payType === 'HOURLY' ? '時薪' : '月薪'}</label>
                    <input type="number" step="0.01" value={form.baseAmount}
                      onChange={e => setForm({ ...form, baseAmount: e.target.value })} />
                  </div>
                  {form.assignEmployee && (
                    <>
                      <div className="form-group">
                        <label>年假額度（天）</label>
                        <input type="number" value={form.annualLeave} min="0" step="0.5" inputMode="decimal"
                          onChange={e => setForm({ ...form, annualLeave: e.target.value })} />
                      </div>
                    </>
                  )}
                  {/* 同時創建員工記錄 — 整行、checkbox+文字一體 */}
                  <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.assignEmployee}
                      onChange={e => setForm({ ...form, assignEmployee: e.target.checked })} />
                    同時創建員工記錄（用於排班和計薪）
                  </label>

                  {/* 薪資保密 checkbox */}
                  <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.payConfidential}
                      onChange={e => setForm({ ...form, payConfidential: e.target.checked })} />
                    🔒 薪資保密（經理在計糧中看不到此員工的金額）
                  </label>
                </>
              )}

              {/* 診所指派 — KIOSK 單選，其他角色多選 chip */}
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>診所指派</div>
                {form.role === 'KIOSK' ? (
                  <select value={form.clinicIds[0] || ''} onChange={e => setForm({ ...form, clinicIds: e.target.value ? [e.target.value] : [] })}>
                    <option value="">選擇打卡屏所屬診所</option>
                    {clinics.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {clinics.map(c => (
                      <label key={c.id} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                        border: form.clinicIds.includes(c.id) ? '1.5px solid #0f766e' : '1px solid #e5e7eb',
                        background: form.clinicIds.includes(c.id) ? '#f0fdfa' : '#fff',
                        fontSize: 13, whiteSpace: 'nowrap',
                      }}>
                        <input type="checkbox" checked={form.clinicIds.includes(c.id)}
                          onChange={e => {
                            const ids = e.target.checked ? [...form.clinicIds, c.id] : form.clinicIds.filter(id => id !== c.id)
                            // If unchecking current homeClinic, clear it
                            const newIds = ids
                            setForm({ ...form, clinicIds: ids, homeClinicId: (!ids.includes(form.homeClinicId) && form.homeClinicId) ? '' : form.homeClinicId })
                          }} />
                        {c.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* 長駐店鋪 — only show when employee has assigned clinics */}
              {form.assignEmployee && form.clinicIds.length > 0 && (
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>長駐店鋪（計糧歸屬店）</label>
                  <select
                    value={form.homeClinicId}
                    onChange={e => setForm({ ...form, homeClinicId: e.target.value })}
                    className="w-64 px-3 py-2 rounded-md border text-sm"
                  >
                    <option value="">選擇長駐店鋪...</option>
                    {form.clinicIds.map(cid => {
                      const clinic = clinics.find(c => c.id === cid)
                      return <option key={cid} value={cid}>{clinic?.name || cid}</option>
                    })}
                  </select>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    員工只會出現在長駐店鋪的計糧中；借調到其他店打卡，糧單永遠在家店。
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
              {editingId && form.employeeId && (
                <button type="button" className="btn btn-sm" style={{ background: '#e8f5e9', color: '#2e7d32' }}
                  onClick={() => {
                    if (!form.employeeId) { alert('請先儲存帳號，再設定薪酬規則'); return }
                    setPayRuleEmployeeId(form.employeeId)
                    setShowPayRuleModal(true)
                  }}>
                  <span className="flex items-center gap-1"><Wallet size={14} /> 薪酬規則</span>
                </button>
              )}
              <div style={{ marginLeft: 'auto' }}>
                <button type="button" className="btn" style={{ background: '#eee', color: '#333', marginRight: 8 }} onClick={resetForm}>取消</button>
                <button type="submit" className="btn btn-primary">{editingId ? '保存' : '新增'}</button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <input placeholder="搜尋姓名/電話" value={search} onChange={e => setSearch(e.target.value)}
          className="px-3 py-1.5 rounded-md border text-sm w-full md:w-auto" />
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
          className="px-3 py-1.5 rounded-md border text-sm w-full md:w-auto">
          <option value="all">全部角色</option>
          <option value="OWNER">Owner</option>
          <option value="MANAGER">Manager</option>
          <option value="ACCOUNTANT">Accountant</option>
          <option value="EMPLOYEE">Employee</option>
          <option value="KIOSK">打卡屏</option>
        </select>
        <select value={clinicFilter} onChange={e => setClinicFilter(e.target.value)}
          className="px-3 py-1.5 rounded-md border text-sm w-full md:w-auto">
          <option value="all">全部診所</option>
          {clinics.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-md border text-sm w-full md:w-auto">
          <option value="all">全部狀態</option>
          <option value="active">啟用</option>
          <option value="inactive">停用</option>
        </select>
        {isOwner && (
          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="checkbox" checked={showResigned} onChange={e => setShowResigned(e.target.checked)} />
            顯示已離職
          </label>
        )}
      </div>

      {/* Table / Cards */}
      {filteredAccounts.length === 0 ? (
        <div className="text-center text-muted-foreground py-10">沒有帳號</div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block card overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>姓名</th><th>電話</th><th>角色</th><th>到職日</th><th>診所</th><th className="whitespace-nowrap">狀態</th><th className="whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map(acc => (
                  <React.Fragment key={acc.id}>
                    <tr onClick={() => {
                      if (expandedRow === acc.id) {
                        setExpandedRow(null)
                      } else {
                        setExpandedRow(acc.id)
                        if (acc.employeeId) {
                          loadPayRules(acc.employeeId)
                        }
                      }
                    }} style={{ cursor: 'pointer' }}>
                      <td style={{ fontWeight: 500 }}>{acc.name}</td>
                      <td>{acc.phone}</td>
                      <td>
                        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12,
                          background: acc.role === 'OWNER' ? '#1a1a2e20' : '#88820', color: acc.role === 'OWNER' ? '#1a1a2e' : '#888' }}>
                          {ROLE_LABELS[acc.role] || acc.role}
                        </span>
                      </td>
                      <td>{acc.joinDate || '-'}</td>
                      <td>{(acc.clinics || []).map(c => c.name).join(', ') || '-'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {(() => {
                          const displayStatus = acc.employeeStatus === 'RESIGNED' ? 'RESIGNED' : acc.status
                          const statusColor = displayStatus === 'ACTIVE' ? '#4CAF50' : displayStatus === 'RESIGNED' ? '#9333ea' : '#dc3545'
                          const statusBg = displayStatus === 'ACTIVE' ? '#4CAF5020' : displayStatus === 'RESIGNED' ? '#9333ea20' : '#dc354520'
                          const statusIcon = displayStatus === 'ACTIVE' ? '✅' : displayStatus === 'RESIGNED' ? '👋' : '❌'
                          return (
                            <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12, background: statusBg, color: statusColor }}>
                              {statusIcon} {STATUS_LABELS[displayStatus] || displayStatus}
                            </span>
                          )
                        })()}
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => handleEdit(acc)}>編輯</button>
                          {acc.employeeId && (
                            <button className="btn btn-sm" style={{ background: '#e8f5e9', color: '#2e7d32' }} onClick={() => { setPayRuleEmployeeId(acc.employeeId); setShowPayRuleModal(true) }}>
                            <span className="flex items-center gap-1"><Wallet size={16} /> 薪酬規則</span>
                          </button>
                          )}
                          <button className="text-xs underline" onClick={async () => {
                            const res = await fetch('/api/face/enroll-code', {
                              method: 'POST', credentials: 'include',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ employeeId: acc.employeeId })
                            })
                            const d = await res.json()
                            if (res.ok) setEnrollCode({ code: d.code, name: acc.name })
                          }}>登記臉部</button>
                          {isOwner && userRole !== acc.role && (
                            <button className="btn btn-sm" style={{ background: '#fde8e8', color: '#dc3545' }} onClick={() => handleDelete(acc)}>刪除</button>
                          )}
                          {isOwner && acc.employeeId && acc.employeeStatus !== 'RESIGNED' && (
                            <button className="btn btn-sm" style={{ background: '#fef2f2', color: '#dc2626' }} onClick={() => openResign(acc)}>離職</button>
                          )}
                          {isOwner && acc.employeeStatus === 'RESIGNED' && (
                            <button className="btn btn-sm" style={{ background: '#f0fdf4', color: '#16a34a' }} onClick={() => handleRehire(acc)}>復職</button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expandedRow === acc.id && (
                      <tr>
                        <td colSpan={7} style={{ background: '#f9fafb', padding: 16 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
                            <div>
                              <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>登入資訊</h4>
                              <div style={{ fontSize: 12, color: '#888' }}>電郵: {acc.email || '未設定'}</div>
                              <div style={{ fontSize: 12, color: '#888' }}>建立於: {fmtDate(acc.createdAt)}</div>
                              <div style={{ marginTop: 8 }}>
                                <button className="btn btn-sm" style={{ background: '#f0f0f0', marginRight: 4 }} onClick={() => handleResetPassword(acc)}>重設密碼</button>
                                <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => handleToggleStatus(acc)}>
                                  {acc.status === 'ACTIVE' ? '停用' : '啟用'}
                                </button>
                              </div>
                            </div>
                            <div>
                              <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>診所指派</h4>
                              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                {(acc.clinics || []).map(c => (
                                  <span key={c.id} style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12, background: '#1a1a2e10', color: '#1a1a2e' }}>{c.name}</span>
                                ))}
                                {(!acc.clinics || acc.clinics.length === 0) && <span style={{ fontSize: 12, color: '#aaa' }}>未指派</span>}
                              </div>
                            </div>
                            <div>
                              <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>薪酬資訊</h4>
                              {(() => {
                                const payInfo = getPayInfo(acc)
                                return (
                                  <>
                                    <div style={{ fontSize: 12, color: '#888' }}>方式: {payInfo.label}</div>
                                    <div style={{ fontSize: 12, color: '#888' }}>金額: {payInfo.amount}</div>
                                  </>
                                )
                              })()}
                            </div>
                            <div>
                              <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>入職資料</h4>
                              <div style={{ fontSize: 12, color: '#888' }}>到職日: {acc.joinDate || '未設定'}</div>
                            </div>
                            {acc.employeeId && (
                              <div>
                                <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                                  假期額度
                                  <button
                                    className="btn btn-sm"
                                    style={{ float: 'right', background: '#f0f0f0', fontSize: 11, padding: '2px 8px' }}
                                    onClick={() => loadLeaveBalances(acc.employeeId!)}
                                  >載入</button>
                                </h4>
                                {leaveBalances[acc.employeeId!] && leaveBalances[acc.employeeId!].length > 0 ? (
                                  leaveBalances[acc.employeeId!]
                                    // 週年發放制：年假只顯示當年
                                    .filter(b => {
                                      if (b.leaveType?.systemKey === 'ANNUAL_LEAVE' && b.year !== currentYear) return false
                                      return true
                                    })
                                    .map(b => (
                                    <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 12 }}>
                                      <span style={{ minWidth: 60, color: '#555' }}>{b.leaveType?.name}</span>
                                      <input
                                        type="number"
                                        defaultValue={b.entitled}
                                        min="0"
                                        step="0.5"
                                        style={{ width: 70, padding: '2px 4px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12 }}
                                        onBlur={e => {
                                          const v = parseFloat(e.target.value)
                                          if (isFinite(v) && v !== b.entitled) updateLeaveBalance(b.id, 'entitled', v)
                                          else e.target.value = String(b.entitled)
                                        }}
                                      />
                                      <span style={{ color: '#aaa' }}>已用: {b.used}</span>
                                      <span style={{ color: b.remaining >= 0 ? '#4CAF50' : '#dc3545' }}>餘: {b.remaining}</span>
                                    </div>
                                  ))
                                ) : (
                                  <span style={{ fontSize: 12, color: '#aaa' }}>點擊「載入」查看假期額度</span>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {filteredAccounts.map(acc => {
              const displayStatus = acc.employeeStatus === 'RESIGNED' ? 'RESIGNED' : acc.status
              const statusColor = displayStatus === 'ACTIVE' ? '#4CAF50' : displayStatus === 'RESIGNED' ? '#9333ea' : '#dc3545'
              const statusBg = displayStatus === 'ACTIVE' ? '#4CAF5020' : displayStatus === 'RESIGNED' ? '#9333ea20' : '#dc354520'
              const statusIcon = displayStatus === 'ACTIVE' ? '✅' : displayStatus === 'RESIGNED' ? '👋' : '❌'
              return (
                <div key={acc.id} className="rounded-xl border shadow-card p-3">
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-semibold">{acc.name}</span>
                    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12, background: statusBg, color: statusColor }}>
                      {statusIcon} {STATUS_LABELS[displayStatus] || displayStatus}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-sm mb-1">
                    <span>{acc.phone}</span>
                    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12,
                      background: acc.role === 'OWNER' ? '#1a1a2e20' : '#88820', color: acc.role === 'OWNER' ? '#1a1a2e' : '#888' }}>
                      {ROLE_LABELS[acc.role] || acc.role}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    {(acc.clinics || []).map(c => c.name).join(', ') || '未指派診所'}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="px-3 py-1.5 rounded-md border text-xs bg-slate-50 hover:bg-slate-100" onClick={() => handleEdit(acc)}>編輯</button>
                    {acc.employeeId && (
                      <button className="px-3 py-1.5 rounded-md text-xs border text-emerald-700 border-emerald-200 bg-emerald-50" onClick={() => { setPayRuleEmployeeId(acc.employeeId); setShowPayRuleModal(true) }}>
                        <Wallet size={12} className="inline mr-1" /> 薪酬規則
                      </button>
                    )}
                    <button className="px-3 py-1.5 rounded-md border text-xs bg-slate-50 hover:bg-slate-100" onClick={async () => {
                      const res = await fetch('/api/face/enroll-code', {
                        method: 'POST', credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ employeeId: acc.employeeId })
                      })
                      const d = await res.json()
                      if (res.ok) setEnrollCode({ code: d.code, name: acc.name })
                    }}>登記臉部</button>
                    {isOwner && userRole !== acc.role && (
                      <button className="px-3 py-1.5 rounded-md text-xs text-red-600 border border-red-200 bg-red-50" onClick={() => handleDelete(acc)}>刪除</button>
                    )}
                    {isOwner && acc.employeeId && acc.employeeStatus !== 'RESIGNED' && (
                      <button className="px-3 py-1.5 rounded-md text-xs text-red-600 border border-red-200 bg-red-50" onClick={() => openResign(acc)}>離職</button>
                    )}
                    {isOwner && acc.employeeStatus === 'RESIGNED' && (
                      <button className="px-3 py-1.5 rounded-md text-xs text-green-600 border border-green-200 bg-green-50" onClick={() => handleRehire(acc)}>復職</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
      {/* Pay Rule Modal */}
      {showPayRuleModal && payRuleEmployeeId && (
        <RuleComposerModal
          employeeId={payRuleEmployeeId}
          onClose={() => setShowPayRuleModal(false)}
          onSuccess={() => {
            setShowPayRuleModal(false);
            setPayRules({}); // Clear all cache — next expand/load fetches fresh
            fetchData();
          }}
        />
      )}

      {/* KIOSK Creation Form */}
      {showKioskForm && (
        <div className="card" style={{ marginBottom: 24, background: '#f0f4ff', border: '1px solid #c7d2fe' }}>
          <h2 style={{ marginBottom: 16 }}>📱 建立打卡螢幕帳號（KIOSK）</h2>
          <div className="grid-3" style={{ marginBottom: 0 }}>
            <div className="form-group">
              <label>診所（必選）</label>
              <select value={kioskForm.clinicId} onChange={e => onKioskClinicChange(e.target.value)}
                className="px-3 py-2 rounded-md border text-sm w-full" required>
                <option value="">-- 選擇診所 --</option>
                {clinics.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>登入號碼（預填，可修改）</label>
              <input type="text" value={kioskForm.phone}
                onChange={e => setKioskForm(f => ({ ...f, phone: e.target.value }))}
                className="px-3 py-2 rounded-md border text-sm w-full" placeholder="診所名稱 + 打卡機" />
            </div>
            <div className="form-group">
              <label>密碼（自動產生，提交後僅顯示一次）</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="text" value={kioskForm.password}
                  onChange={e => setKioskForm(f => ({ ...f, password: e.target.value }))}
                  className="px-3 py-2 rounded-md border text-sm font-mono" readOnly />
                <button type="button" className="btn btn-sm" style={{ background: '#eee' }}
                  onClick={() => setKioskForm(f => ({ ...f, password: generateRandomPassword() }))}
                  title="重新產生">🔄</button>
              </div>
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label>IP 白名單（選填，一行一個 IP 或前綴，用逗號分隔）</label>
              <textarea value={kioskForm.ipAllowlist}
                onChange={e => setKioskForm(f => ({ ...f, ipAllowlist: e.target.value }))}
                className="px-3 py-2 rounded-md border text-sm w-full" rows={2}
                placeholder="如：192.168.1.100, 10.0.0." />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn" style={{ background: '#eee', color: '#333' }}
              onClick={() => setShowKioskForm(false)}>取消</button>
            <button type="button" className="btn" style={{ background: '#6366f1', color: 'white' }}
              onClick={handleKioskSubmit} disabled={kioskLoading}>
              {kioskLoading ? '建立中...' : '建立 KIOSK 帳號'}
            </button>
          </div>
        </div>
      )}

      {/* KIOSK Password Reveal Modal */}
      {kioskCreatedPassword && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setKioskCreatedPassword(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-8 max-w-md w-full mx-4 text-center"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold mb-2">⚠️ 請抄錄密碼</h3>
            <p className="text-sm text-gray-500 mb-4">此密碼僅顯示一次，請妥善保存</p>
            <div className="text-center mb-4">
              <span style={{ fontSize: 36, letterSpacing: 6, fontFamily: 'monospace', fontWeight: 'bold', color: '#1a1a2e' }}>
                {kioskCreatedPassword}
              </span>
            </div>
            <button className="w-full py-3 bg-blue-600 text-white rounded-lg text-lg font-semibold"
              onClick={() => setKioskCreatedPassword(null)}>
              我記下了
            </button>
          </div>
        </div>
      )}

      {/* Enroll Code Modal */}
      {enrollCode && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setEnrollCode(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-2">{enrollCode.name} 的登記碼</h3>
            <p className="text-sm text-gray-500 mb-4">10 分鐘內有效</p>
            <div className="text-center mb-4">
              <span style={{ fontSize: 48, letterSpacing: 12, fontFamily: 'monospace', fontWeight: 'bold' }}>
                {enrollCode.code}
              </span>
            </div>
            <p className="text-sm text-gray-600 mb-4">請員工在自己手機開「臉部登記」頁輸入此碼</p>
            <button className="w-full py-2 bg-blue-600 text-white rounded-lg" onClick={() => setEnrollCode(null)}>
              關閉
            </button>
          </div>
        </div>
      )}

      {/* Resign Modal */}
      {showResignModal && resignEmployee && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowResignModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-8 max-w-md w-full mx-4"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold mb-4 text-red-700">👋 辦理離職</h3>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{resignEmployee.name}</div>
              <div style={{ fontSize: 12, color: '#888' }}>{resignEmployee.phone} · {ROLE_LABELS[resignEmployee.role] || resignEmployee.role}</div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>最後工作日</label>
              <input
                type="date"
                value={lastDay}
                onChange={e => setLastDay(e.target.value)}
                className="px-3 py-2 rounded-md border text-sm w-full"
              />
            </div>

            {resignPreview && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#dc2626', marginBottom: 4 }}>⚠️ 離職後將自動取消：</div>
                <div style={{ fontSize: 12, color: '#7f1d1d' }}>班次：{resignPreview.futureShifts} 個</div>
                <div style={{ fontSize: 12, color: '#7f1d1d' }}>已批假期：{resignPreview.futureApprovedLeaves} 筆</div>
                <div style={{ fontSize: 11, color: '#991b1b', marginTop: 4 }}>（僅取消最後工作日之後的記錄）</div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" style={{ background: '#eee', color: '#333' }}
                onClick={() => setShowResignModal(false)}>取消</button>
              <button className="btn" style={{ background: '#dc2626', color: 'white' }}
                onClick={handleResign} disabled={resignLoading || !lastDay}>
                {resignLoading ? '處理中...' : '確認離職'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
