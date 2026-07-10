'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Wallet, Plus } from 'lucide-react'
import { RuleComposerModal } from '@/components/RuleComposerModal'

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
  const [payRuleEmployeeId, setPayRuleEmployeeId] = useState<string | null>(null)
  const [leaveBalances, setLeaveBalances] = useState<Record<string, any[]>>({})
  const [form, setForm] = useState({
    name: '', phone: '', email: '', password: '', role: 'EMPLOYEE' as Role,
    clinicIds: [] as string[], joinDate: '',
    payType: 'HOURLY', baseAmount: '',
    assignEmployee: true,
    annualLeave: 12,  // 預設年假額度
    sickLeave: 12,     // 預設病假額度
    employeeId: null as string | null,
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
        annualLeave: form.assignEmployee ? form.annualLeave : undefined,
        sickLeave: form.assignEmployee ? form.sickLeave : undefined,
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
      annualLeave: 12, sickLeave: 12, employeeId: null })
    setShowForm(false); setEditingId(null)
  }

  const handleEdit = (acc: Account) => {
    setForm({ name: acc.name, phone: acc.phone, email: acc.email || '',
      password: '', role: acc.role, clinicIds: acc.clinics?.map(c => c.id) || [],
      joinDate: acc.joinDate || '', payType: acc.payType || 'HOURLY',
      baseAmount: acc.baseAmount?.toString() || '', assignEmployee: !!acc.employeeId,
      annualLeave: 12, sickLeave: 12, employeeId: acc.employeeId })
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

  const isOwner = userRole === 'OWNER'

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
                <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required={!editingId} placeholder="密碼" />
              </div>
              <div className="form-group">
                <label>角色</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Role })}>
                  {isOwner && <option value="OWNER">Owner</option>}
                  <option value="MANAGER">Manager</option>
                  <option value="ACCOUNTANT">Accountant</option>
                  <option value="EMPLOYEE">Employee</option>
                </select>
              </div>
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
                    <input type="number" value={form.annualLeave} min="0" step="0.5"
                      onChange={e => setForm({ ...form, annualLeave: parseFloat(e.target.value) || 0 })} />
                  </div>
                  <div className="form-group">
                    <label>病假額度（天）</label>
                    <input type="number" value={form.sickLeave} min="0" step="0.5"
                      onChange={e => setForm({ ...form, sickLeave: parseFloat(e.target.value) || 0 })} />
                  </div>
                </>
              )}
              <div className="form-group" style={{ gridColumn: 'span 3' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input type="checkbox" checked={form.assignEmployee}
                    onChange={e => setForm({ ...form, assignEmployee: e.target.checked })} />
                  同時創建員工記錄（用於排班和計薪）
                </label>
                <label>診所指派</label>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {clinics.map(c => (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="checkbox" checked={form.clinicIds.includes(c.id)}
                        onChange={e => {
                          const ids = e.target.checked ? [...form.clinicIds, c.id] : form.clinicIds.filter(id => id !== c.id)
                          setForm({ ...form, clinicIds: ids })
                        }} />
                      {c.name}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
              {editingId && form.employeeId && (
                <button type="button" className="btn btn-sm" style={{ background: '#e8f5e9', color: '#2e7d32' }}
                  onClick={() => { setPayRuleEmployeeId(form.employeeId!); setShowPayRuleModal(true) }}>
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
                <tr onClick={() => setExpandedRow(expandedRow === acc.id ? null : acc.id)} style={{ cursor: 'pointer' }}>
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
                          <div style={{ fontSize: 12, color: '#888' }}>建立於: {new Date(acc.createdAt).toLocaleDateString('zh-HK')}</div>
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
                          <div style={{ fontSize: 12, color: '#888' }}>方式: {acc.payType === 'HOURLY' ? '時薪' : acc.payType === 'MONTHLY' ? '月薪' : '-'}</div>
                          <div style={{ fontSize: 12, color: '#888' }}>{acc.payType ? `${acc.payType === 'HOURLY' ? '時薪' : '月薪'}: ${acc.baseAmount || 0}` : '-'}</div>
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
                              leaveBalances[acc.employeeId!].map(b => (
                                <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 12 }}>
                                  <span style={{ minWidth: 60, color: '#555' }}>{b.leaveType?.name}</span>
                                  <input
                                    type="number"
                                    value={b.entitled}
                                    min="0"
                                    step="0.5"
                                    style={{ width: 70, padding: '2px 4px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12 }}
                                    onChange={e => updateLeaveBalance(b.id, 'entitled', parseFloat(e.target.value) || 0)}
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
          onSuccess={() => { setShowPayRuleModal(false); fetchData() }}
        />
      )}
    </div>
  )
}
