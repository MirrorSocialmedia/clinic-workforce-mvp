'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'RESIGNED' | 'PROBATION'
type PayType = 'MONTHLY' | 'DAILY' | 'HOURLY' | 'SPLIT'

interface EmployeeDetail {
  id: string
  status: EmployeeStatus
  joinDate: string
  leaveDate: string | null
  notes: string | null
  user: {
    id: string
    name: string
    phone: string
    email: string | null
    role: string
    createdAt: string
  }
  clinics: Array<{
    clinic: { id: string; name: string }
    isPrimary: boolean
    joinedAt: string
  }>
  payRules: Array<{
    id: string
    payType: PayType
    baseAmount: number | null
    configJson: string | null
    effectiveFrom: string
    effectiveTo: string | null
    isActive: boolean
    createdBy: string
    createdAt: string
  }>
}

const PAY_TYPE_LABELS: Record<PayType, string> = {
  MONTHLY: '月薪',
  DAILY: '日薪',
  HOURLY: '時薪',
  SPLIT: '拆帳',
}

const STATUS_LABELS: Record<EmployeeStatus, string> = {
  ACTIVE: '在職',
  ON_LEAVE: '休假',
  RESIGNED: '離職',
  PROBATION: '試用',
}

const STATUS_COLORS: Record<EmployeeStatus, string> = {
  ACTIVE: '#2e7d32',
  ON_LEAVE: '#e65100',
  RESIGNED: '#888',
  PROBATION: '#1565c0',
}

export default function EmployeeDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [showPayRuleModal, setShowPayRuleModal] = useState(false)
  const [clinics, setClinics] = useState<{ id: string; name: string }[]>([])

  const fetchEmployee = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/employees/${params.id}`)
      const data = await res.json()
      if (res.ok) {
        setEmployee(data.employee)
      } else {
        if (res.status === 404) router.push('/employees')
      }
    } catch (err) {
      console.error('Failed to fetch employee:', err)
    } finally {
      setLoading(false)
    }
  }, [params.id, router])

  useEffect(() => {
    fetchEmployee()
    // Fetch clinics for edit form
    fetch('/api/clinics')
      .then((r) => r.json())
      .then((data) => setClinics(data.clinics || []))
      .catch(() => {})
  }, [fetchEmployee])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        載入中...
      </div>
    )
  }

  if (!employee) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>
        找不到員工資料
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>
            <a href="/employees" style={{ color: '#888', textDecoration: 'none' }}>
              ← 返回員工列表
            </a>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: '#1a1a2e' }}>
            {employee.user.name}
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            style={{ background: '#f0f0f0', color: '#333' }}
            onClick={() => setEditMode(true)}
          >
            ✏️ 編輯
          </button>
          {employee.status === 'ACTIVE' && (
            <button
              className="btn btn-danger"
              onClick={async () => {
                if (!confirm('確定要標記此員工為離職嗎？')) return
                try {
                  const res = await fetch(`/api/employees/${employee.id}`, {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'RESIGNED' }),
                  })
                  if (res.ok) {
                    fetchEmployee()
                  } else {
                    alert('離職處理失敗')
                  }
                } catch (err) {
                  alert('離職處理失敗')
                }
              }}
            >
              🚪 標記離職
            </button>
          )}
          {employee.status !== 'RESIGNED' && (
            <button
              className="btn"
              style={{ background: '#fef3c7', color: '#92400e' }}
              onClick={() => setShowPayRuleModal(true)}
            >
              💰 新增薪酬規則
            </button>
          )}
        </div>
      </div>

      {/* Status badge */}
      <div style={{ marginBottom: 20 }}>
        <span
          style={{
            display: 'inline-block',
            padding: '4px 12px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            background: `${STATUS_COLORS[employee.status]}18`,
            color: STATUS_COLORS[employee.status],
          }}
        >
          {STATUS_LABELS[employee.status]}
        </span>
        {employee.leaveDate && (
          <span className="text-muted text-sm" style={{ marginLeft: 12 }}>
            離職日：{new Date(employee.leaveDate).toLocaleDateString('zh-TW')}
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Basic Info */}
        <div className="card">
          <h2>📋 基本資料</h2>
          <table>
            <tbody>
              <tr>
                <td style={{ color: '#888', width: 100 }}>姓名</td>
                <td>{employee.user.name}</td>
              </tr>
              <tr>
                <td style={{ color: '#888' }}>手機</td>
                <td>{employee.user.phone}</td>
              </tr>
              <tr>
                <td style={{ color: '#888' }}>Email</td>
                <td>{employee.user.email || '—'}</td>
              </tr>
              <tr>
                <td style={{ color: '#888' }}>系統角色</td>
                <td>{employee.user.role}</td>
              </tr>
              <tr>
                <td style={{ color: '#888' }}>到職日</td>
                <td>{new Date(employee.joinDate).toLocaleDateString('zh-TW')}</td>
              </tr>
              <tr>
                <td style={{ color: '#888' }}>加入系統</td>
                <td>{new Date(employee.user.createdAt).toLocaleDateString('zh-TW')}</td>
              </tr>
            </tbody>
          </table>
          {employee.notes && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: '#f9f9f9', borderRadius: 6, fontSize: 14, color: '#555' }}>
              <strong>備註：</strong>{employee.notes}
            </div>
          )}
        </div>

        {/* Clinic Assignments */}
        <div className="card">
          <h2>🏥 診所配置</h2>
          {employee.clinics.length === 0 ? (
            <div className="text-muted">暫無診所配置</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {employee.clinics.map((ec) => (
                <div
                  key={ec.clinic.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: ec.isPrimary ? '#f0f4ff' : '#fafafa',
                    borderRadius: 6,
                    border: ec.isPrimary ? '1px solid #c7d2fe' : '1px solid #eee',
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 500 }}>{ec.clinic.name}</span>
                    {ec.isPrimary && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 11,
                          fontWeight: 600,
                          background: '#1565c0',
                          color: 'white',
                          padding: '1px 6px',
                          borderRadius: 3,
                        }}
                      >
                        主診所
                      </span>
                    )}
                  </div>
                  <span className="text-muted text-sm">
                    加入：{new Date(ec.joinedAt).toLocaleDateString('zh-TW')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Pay Rule History */}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>💰 薪酬規則歷史</h2>
        {employee.payRules.length === 0 ? (
          <div className="text-muted">暫無薪酬規則</div>
        ) : (
          <div style={{ position: 'relative' }}>
            {/* Timeline */}
            {employee.payRules.map((rule, idx) => {
              const config = rule.configJson ? JSON.parse(rule.configJson) : null
              return (
                <div
                  key={rule.id}
                  style={{
                    display: 'flex',
                    gap: 16,
                    paddingBottom: idx < employee.payRules.length - 1 ? 20 : 0,
                    marginBottom: idx < employee.payRules.length - 1 ? 20 : 0,
                    borderBottom: idx < employee.payRules.length - 1 ? '1px solid #eee' : 'none',
                  }}
                >
                  {/* Timeline dot */}
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: rule.isActive ? '#2e7d32' : '#ccc',
                      marginTop: 4,
                      flexShrink: 0,
                    }}
                  />
                  {/* Content */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 15 }}>
                        {PAY_TYPE_LABELS[rule.payType] || rule.payType}
                      </span>
                      {rule.isActive && (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            background: '#e8f5e9',
                            color: '#2e7d32',
                            padding: '1px 6px',
                            borderRadius: 3,
                          }}
                        >
                          當前生效
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: 14, color: '#555', marginBottom: 4 }}>
                      {rule.payType === 'SPLIT'
                        ? `拆帳比例：${rule.baseAmount}%`
                        : `薪資數額：$${rule.baseAmount?.toLocaleString() || '—'}`}
                    </div>

                    {config?.overtimeMultiplier && (
                      <div style={{ fontSize: 13, color: '#888' }}>
                        加班倍率：{config.overtimeMultiplier}x | 門檻：{config.overtimeThreshold}hr/日
                      </div>
                    )}

                    <div className="text-muted text-sm" style={{ marginTop: 4 }}>
                      生效期間：{new Date(rule.effectiveFrom).toLocaleDateString('zh-TW')}
                      {rule.effectiveTo
                        ? ` ~ ${new Date(rule.effectiveTo).toLocaleDateString('zh-TW')}`
                        : rule.isActive
                          ? ' ~ 至今'
                          : ''}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editMode && employee && (
        <EditEmployeeModal
          employee={employee}
          clinics={clinics}
          onClose={() => setEditMode(false)}
          onSuccess={() => {
            setEditMode(false)
            fetchEmployee()
          }}
        />
      )}

      {/* Add Pay Rule Modal */}
      {showPayRuleModal && (
        <AddPayRuleModal
          employeeId={employee.id}
          onClose={() => setShowPayRuleModal(false)}
          onSuccess={() => {
            setShowPayRuleModal(false)
            fetchEmployee()
          }}
        />
      )}
    </div>
  )
}

// ============================================================
// Edit Employee Modal
// ============================================================
function EditEmployeeModal({
  employee,
  clinics,
  onClose,
  onSuccess,
}: {
  employee: EmployeeDetail
  clinics: { id: string; name: string }[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState({
    name: employee.user.name,
    phone: employee.user.phone,
    email: employee.user.email || '',
    password: '',
    clinicIds: employee.clinics.map((c) => c.clinic.id),
    joinDate: new Date(employee.joinDate).toISOString().split('T')[0],
    status: employee.status,
    notes: employee.notes || '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const toggleClinic = (id: string) => {
    setForm((f) => ({
      ...f,
      clinicIds: f.clinicIds.includes(id)
        ? f.clinicIds.filter((c) => c !== id)
        : [...f.clinicIds, id],
    }))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!form.name || !form.phone) {
      setError('姓名和手機為必填')
      return
    }

    setSubmitting(true)

    try {
      const body: any = {
        name: form.name,
        phone: form.phone,
        email: form.email || undefined,
        clinicIds: form.clinicIds,
        joinDate: form.joinDate,
        status: form.status,
        notes: form.notes || undefined,
      }
      if (form.password) {
        body.password = form.password
      }

      const res = await fetch(`/api/employees/${employee.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '更新失敗')
        return
      }

      onSuccess()
    } catch (err: any) {
      setError(err.message || '更新失敗')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 560,
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 24,
          margin: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 20px 0' }}>✏️ 編輯員工</h2>

        {error && (
          <div
            style={{
              background: '#fef2f2',
              color: '#dc2626',
              padding: '10px 14px',
              borderRadius: 6,
              marginBottom: 16,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="form-group">
            <label>姓名 *</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>手機 *</label>
            <input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Email</label>
            <input
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>新密碼（留空則不更改）</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="輸入新密碼"
            />
          </div>

          <div className="form-group">
            <label>診所配置</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {clinics.map((c) => (
                <label
                  key={c.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: form.clinicIds.includes(c.id) ? '#f0f4ff' : '#fafafa',
                    border: form.clinicIds.includes(c.id) ? '1px solid #c7d2fe' : '1px solid transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={form.clinicIds.includes(c.id)}
                    onChange={() => toggleClinic(c.id)}
                  />
                  {c.name}
                  {form.clinicIds[0] === c.id && (
                    <span style={{ fontSize: 11, color: '#1565c0', fontWeight: 600 }}>
                      主診所
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>到職日</label>
            <input
              type="date"
              value={form.joinDate}
              onChange={(e) => setForm({ ...form, joinDate: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>狀態</label>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as EmployeeStatus })}
            >
              <option value="ACTIVE">在職</option>
              <option value="ON_LEAVE">休假</option>
              <option value="PROBATION">試用</option>
              <option value="RESIGNED">離職</option>
            </select>
          </div>

          <div className="form-group">
            <label>備註</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
            <button
              type="button"
              onClick={onClose}
              className="btn"
              style={{ background: '#f0f0f0', color: '#333' }}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? '儲存中...' : '儲存變更'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ============================================================
// Add Pay Rule Modal
// ============================================================
function AddPayRuleModal({
  employeeId,
  onClose,
  onSuccess,
}: {
  employeeId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState({
    payType: 'MONTHLY' as PayType,
    baseAmount: '',
    overtimeMultiplier: '1.5',
    overtimeThreshold: '8',
    effectiveFrom: new Date().toISOString().split('T')[0],
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!form.effectiveFrom) {
      setError('請設定生效日期')
      return
    }

    setSubmitting(true)

    try {
      const configJson =
        form.payType === 'HOURLY'
          ? JSON.stringify({
              overtimeMultiplier: parseFloat(form.overtimeMultiplier) || 1.5,
              overtimeThreshold: parseFloat(form.overtimeThreshold) || 8,
            })
          : null

      const res = await fetch(`/api/employees/${employeeId}/pay-rules`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payType: form.payType,
          baseAmount: form.baseAmount ? parseFloat(form.baseAmount) : undefined,
          configJson,
          effectiveFrom: form.effectiveFrom,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '新增薪酬規則失敗')
        return
      }

      onSuccess()
    } catch (err: any) {
      setError(err.message || '新增薪酬規則失敗')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 480,
          padding: 24,
          margin: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 20px 0' }}>💰 新增薪酬規則</h2>

        {error && (
          <div
            style={{
              background: '#fef2f2',
              color: '#dc2626',
              padding: '10px 14px',
              borderRadius: 6,
              marginBottom: 16,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="form-group">
            <label>薪酬類型</label>
            <select
              value={form.payType}
              onChange={(e) => setForm({ ...form, payType: e.target.value as PayType })}
            >
              <option value="MONTHLY">月薪</option>
              <option value="DAILY">日薪</option>
              <option value="HOURLY">時薪</option>
              <option value="SPLIT">拆帳</option>
            </select>
          </div>

          <div className="form-group">
            <label>
              {form.payType === 'SPLIT' ? '拆帳比例 (%)' : '薪資數額'}
            </label>
            <input
              type="number"
              value={form.baseAmount}
              onChange={(e) => setForm({ ...form, baseAmount: e.target.value })}
              placeholder={form.payType === 'SPLIT' ? '如 70' : '如 50000'}
              step="0.01"
            />
          </div>

          {form.payType === 'HOURLY' && (
            <>
              <div className="form-group">
                <label>加班倍率</label>
                <input
                  type="number"
                  value={form.overtimeMultiplier}
                  onChange={(e) => setForm({ ...form, overtimeMultiplier: e.target.value })}
                  step="0.1"
                  min="1"
                />
              </div>
              <div className="form-group">
                <label>加班門檻（小時/日）</label>
                <input
                  type="number"
                  value={form.overtimeThreshold}
                  onChange={(e) => setForm({ ...form, overtimeThreshold: e.target.value })}
                  step="0.5"
                  min="0"
                />
              </div>
            </>
          )}

          <div className="form-group">
            <label>生效日期 *</label>
            <input
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
            <button
              type="button"
              onClick={onClose}
              className="btn"
              style={{ background: '#f0f0f0', color: '#333' }}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? '新增中...' : '新增薪酬規則'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
