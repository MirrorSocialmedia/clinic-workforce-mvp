'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Wallet, Plus, Eye, EyeOff } from 'lucide-react'
import { RuleComposerModal } from '@/components/RuleComposerModal'
import { fmtDate } from '@/lib/hk-date'
import { PERMISSIONS, ROLE_DEFAULTS } from '@/lib/permissions'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

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
  clinics: Clinic[]
}

const STATUS_LABELS: Record<string, string> = { ACTIVE: '啟用', INACTIVE: '停用' }
const ROLE_LABELS: Record<string, string> = { OWNER: 'Owner', MANAGER: 'Manager', ACCOUNTANT: 'Accountant', EMPLOYEE: 'Employee' }

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
  const [form, setForm] = useState({
    name: '', phone: '', email: '', password: '', role: 'EMPLOYEE' as Role,
    clinicIds: [] as string[], joinDate: '',
    payType: 'HOURLY', baseAmount: '',
    assignEmployee: true,
    payConfidential: false,
    annualLeave: '12',  // string — parse on submit
    sickLeave: '12',     // string — parse on submit
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

  // Auto-select homeClinicId = first assigned clinic when none set yet
  useEffect(() => {
    if (form.assignEmployee && form.clinicIds.length > 0 && !form.homeClinicId) {
      setForm(f => ({ ...f, homeClinicId: f.clinicIds[0] }))
    }
  }, [form.clinicIds, form.assignEmployee])

  const filteredAccounts = accounts.filter(acc => {
    if (search && !acc.name.toLowerCase().includes(search.toLowerCase()) && !acc.phone.includes(search)) return false
    if (roleFilter !== 'all' && acc.role !== roleFilter) return false
    if (clinicFilter !== 'all' && !acc.clinics?.some(c => c.id === clinicFilter)) return false
    if (statusFilter !== 'all' && acc.status !== statusFilter.toUpperCase()) return false
    return true
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

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
        joinDate: form.joinDate || undefined,
        payType: form.payType,
        baseAmount: form.baseAmount ? parseFloat(form.baseAmount) : null,
        assignEmployee: form.assignEmployee,
        payConfidential: form.payConfidential,
        annualLeave: form.assignEmployee ? (parseFloat(form.annualLeave) || 0) : undefined,
        sickLeave: form.assignEmployee ? (parseFloat(form.sickLeave) || 0) : undefined,
        homeClinicId: form.assignEmployee ? form.homeClinicId || null : undefined,
      }
      // Permissions: compute grant/deny diff from ROLE_DEFAULTS
      if (form.role && form.role !== 'OWNER') {
        const defaults = ROLE_DEFAULTS[form.role] || []
        body.permissionsJson = { grant: form.permGrant, deny: form.permDeny }
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
      payConfidential: false, annualLeave: '12', sickLeave: '12', employeeId: null, homeClinicId: '',
      permGrant: [], permDeny: [] })
    setShowForm(false); setEditingId(null); setShowPwd(false)
  }

  const handleEdit = (acc: Account) => {
    setForm({ name: acc.name, phone: acc.phone, email: acc.email || '',
      password: '', role: acc.role, clinicIds: acc.clinics?.map(c => c.id) || [],
      joinDate: acc.joinDate || '', payType: acc.payType || 'HOURLY',
      baseAmount: acc.baseAmount?.toString() || '', assignEmployee: !!acc.employeeId,
      payConfidential: acc.payConfidential || false,
      annualLeave: '12', sickLeave: '12', employeeId: acc.employeeId,
      homeClinicId: acc.homeClinicId || '', permGrant: [], permDeny: [] })
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
  // 週年發放制：年假只顯示當年
  const currentYear = new Date().getFullYear()

  if (loading) return <div className="main-content" style={{ padding: 24 }}>載入中...</div>

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', margin: 0 }} className="flex items-center gap-2"><Plus size={16} /> 帳號管理</h1>
        {isOwner && (
          <button className="btn btn-primary" onClick={() => { resetForm(); setForm(f => ({ ...f, assignEmployee: true })); setShowForm(true) }}>+ 新增帳號</button>
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
                </select>
              </div>

              {/* Permissions checkboxes (expand after role selection) */}
              {form.role && form.role !== 'OWNER' && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#555' }}>🔑 角色權限（預設勾選 = 角色默認權限，可手動調整）</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {Object.entries(PERMISSIONS).map(([key, label]) => {
                      const defaults = ROLE_DEFAULTS[form.role] || []
                      const isChecked = defaults.includes(key as any) || form.permGrant.includes(key)
                      const isDenied = form.permDeny.includes(key)
                      const effective = isChecked && !isDenied
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
                              const defaults = ROLE_DEFAULTS[form.role] || []
                              const inDefault = defaults.includes(key as any)
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
                  <div className="form-group">
                    <label>病假額度（天）</label>
                    <input type="number" value={form.sickLeave} min="0" step="0.5" inputMode="decimal"
                      onChange={e => setForm({ ...form, sickLeave: e.target.value })} />
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

              {/* 診所指派 chip 流式排列 */}
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>診所指派</div>
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
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <input placeholder="搜尋姓名/電話" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, width: 200 }} />
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
          <option value="all">全部角色</option>
          <option value="OWNER">Owner</option>
          <option value="MANAGER">Manager</option>
          <option value="ACCOUNTANT">Accountant</option>
          <option value="EMPLOYEE">Employee</option>
        </select>
        <select value={clinicFilter} onChange={e => setClinicFilter(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
          <option value="all">全部診所</option>
          {clinics.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
          <option value="all">全部狀態</option>
          <option value="active">啟用</option>
          <option value="inactive">停用</option>
        </select>
      </div>

      {/* Table */}
      <div className="card">
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
                    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12,
                      background: acc.status === 'ACTIVE' ? '#4CAF5020' : '#dc354520',
                      color: acc.status === 'ACTIVE' ? '#4CAF50' : '#dc3545' }}>
                      {acc.status === 'ACTIVE' ? '✅' : '❌'} {STATUS_LABELS[acc.status] || acc.status}
                    </span>
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => handleEdit(acc)}>編輯</button>
                      {acc.employeeId && (
                        <button className="btn btn-sm" style={{ background: '#e8f5e9', color: '#2e7d32' }} onClick={() => { setPayRuleEmployeeId(acc.employeeId); setShowPayRuleModal(true) }}>
                        <span className="flex items-center gap-1"><Wallet size={16} /> 薪酬規則</span>
                      </button>
                      )}
                      {isOwner && userRole !== acc.role && (
                        <button className="btn btn-sm" style={{ background: '#fde8e8', color: '#dc3545' }} onClick={() => handleDelete(acc)}>刪除</button>
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
        {filteredAccounts.length === 0 && (
          <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>沒有帳號</div>
        )}
      </div>
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
    </div>
  )
}
