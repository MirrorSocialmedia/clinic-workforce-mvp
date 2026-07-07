'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { todayHK } from '@/lib/hk-date'

type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'RESIGNED' | 'PROBATION'
type PayType = 'MONTHLY' | 'DAILY' | 'HOURLY' | 'SPLIT'

interface EmployeeItem {
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
  }
  clinics: { clinic: { id: string; name: string }; isPrimary: boolean }[]
  payRules: Array<{
    id: string
    payType: PayType
    baseAmount: number | null
    configJson: string | null
    effectiveFrom: string
    effectiveTo: string | null
    isActive: boolean
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

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<EmployeeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [clinicFilter, setClinicFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [clinics, setClinics] = useState<{ id: string; name: string }[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)

  // Fetch clinics for filter dropdown
  useEffect(() => {
    fetch('/api/clinics')
      .then((r) => r.json())
      .then((data) => setClinics(data.clinics || []))
      .catch(() => {})
  }, [])

  const fetchEmployees = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    if (search) params.set('search', search)
    if (clinicFilter) params.set('clinicId', clinicFilter)
    if (statusFilter) params.set('status', statusFilter)

    try {
      const res = await fetch(`/api/employees?${params}`)
      const data = await res.json()
      if (res.ok) {
        setEmployees(data.employees || [])
        setTotal(data.total || 0)
      }
    } catch (err) {
      console.error('Failed to fetch employees:', err)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, clinicFilter, statusFilter])

  useEffect(() => {
    fetchEmployees()
  }, [fetchEmployees])

  const totalPages = Math.ceil(total / pageSize)

  const clearFilters = () => {
    setSearch('')
    setClinicFilter('')
    setStatusFilter('')
    setPage(1)
  }

  const hasFilters = search || clinicFilter || statusFilter

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: '#1a1a2e' }}>
            👥 員工管理
          </h1>
          <p className="text-muted text-sm" style={{ marginTop: 4 }}>
            管理員工資料、薪酬規則與跨店配置
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-primary"
            onClick={() => setShowAddModal(true)}
          >
            ＋ 新增員工
          </button>
          <button
            className="btn"
            style={{ background: '#f0f0f0', color: '#333' }}
            onClick={() => setShowImportModal(true)}
          >
            📥 批量匯入
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="🔍 搜尋姓名或手機..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            style={{
              flex: '1 1 200px',
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: 6,
              fontSize: 14,
            }}
          />
          <select
            value={clinicFilter}
            onChange={(e) => { setClinicFilter(e.target.value); setPage(1) }}
            style={{
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: 6,
              fontSize: 14,
              minWidth: 140,
            }}
          >
            <option value="">所有診所</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
            style={{
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: 6,
              fontSize: 14,
              minWidth: 120,
            }}
          >
            <option value="">所有狀態</option>
            {Object.entries(STATUS_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          {hasFilters && (
            <button
              onClick={clearFilters}
              style={{
                padding: '8px 12px',
                background: 'transparent',
                border: '1px solid #ddd',
                borderRadius: 6,
                fontSize: 13,
                color: '#888',
                cursor: 'pointer',
              }}
            >
              ✕ 清除篩選
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
            載入中...
          </div>
        ) : employees.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
            暫無員工資料
            <br />
            <button
              className="btn btn-primary"
              style={{ marginTop: 12 }}
              onClick={() => setShowAddModal(true)}
            >
              ＋ 新增第一位員工
            </button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>手機</th>
                  <th>診所</th>
                  <th>狀態</th>
                  <th>薪酬類型</th>
                  <th>到職日</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => {
                  const primaryClinic = emp.clinics.find((c) => c.isPrimary)?.clinic.name
                  const otherClinics = emp.clinics
                    .filter((c) => !c.isPrimary)
                    .map((c) => c.clinic.name)
                  const clinicDisplay = primaryClinic
                    ? otherClinics.length > 0
                      ? `${primaryClinic} (+${otherClinics.length})`
                      : primaryClinic
                    : '—'

                  const activePayRule = emp.payRules?.[0]
                  const payLabel = activePayRule
                    ? PAY_TYPE_LABELS[activePayRule.payType] || activePayRule.payType
                    : '—'

                  return (
                    <tr key={emp.id}>
                      <td>
                        <Link
                          href={`/employees/${emp.id}`}
                          style={{ color: '#1a1a2e', fontWeight: 500, textDecoration: 'none' }}
                        >
                          {emp.user.name}
                        </Link>
                      </td>
                      <td className="text-muted">{emp.user.phone}</td>
                      <td>{clinicDisplay}</td>
                      <td>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            background: `${STATUS_COLORS[emp.status]}18`,
                            color: STATUS_COLORS[emp.status],
                          }}
                        >
                          {STATUS_LABELS[emp.status]}
                        </span>
                      </td>
                      <td className="text-muted">{payLabel}</td>
                      <td className="text-muted">
                        {new Date(emp.joinDate).toLocaleDateString('zh-TW')}
                      </td>
                      <td>
                        <Link
                          href={`/employees/${emp.id}`}
                          className="btn btn-sm"
                          style={{ background: '#f0f0f0', color: '#333', textDecoration: 'none' }}
                        >
                          詳情
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderTop: '1px solid #eee' }}>
            <span className="text-muted text-sm">
              共 {total} 筆，第 {page} / {totalPages} 頁
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className="btn btn-sm"
                style={{ background: '#f0f0f0', color: '#333' }}
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← 上一頁
              </button>
              <button
                className="btn btn-sm"
                style={{ background: '#f0f0f0', color: '#333' }}
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一頁 →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Add Employee Modal */}
      {showAddModal && (
        <AddEmployeeModal
          clinics={clinics}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            fetchEmployees()
          }}
        />
      )}

      {/* Import Modal */}
      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onSuccess={() => {
            setShowImportModal(false)
            fetchEmployees()
          }}
        />
      )}
    </div>
  )
}

// ============================================================
// Add/Edit Employee Modal
// ============================================================
function AddEmployeeModal({
  clinics,
  onClose,
  onSuccess,
}: {
  clinics: { id: string; name: string }[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    password: '',
    clinicIds: [] as string[],
    joinDate: todayHK(),
    payType: 'MONTHLY' as PayType,
    baseAmount: '',
    overtimeMultiplier: '1.5',
    overtimeThreshold: '8',
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

    if (!form.name || !form.phone || !form.password) {
      setError('姓名、手機、密碼為必填')
      return
    }
    if (form.clinicIds.length === 0) {
      setError('請至少選擇一家診所')
      return
    }

    setSubmitting(true)

    try {
      const configJson =
        form.payType !== 'MONTHLY' && form.payType !== 'SPLIT'
          ? JSON.stringify({
              overtimeMultiplier: parseFloat(form.overtimeMultiplier) || 1.5,
              overtimeThreshold: parseFloat(form.overtimeThreshold) || 8,
            })
          : null

      const res = await fetch('/api/employees', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          phone: form.phone,
          email: form.email || undefined,
          password: form.password,
          clinicIds: form.clinicIds,
          joinDate: form.joinDate,
          payType: form.payType,
          baseAmount: form.baseAmount ? parseFloat(form.baseAmount) : undefined,
          configJson,
          effectiveFrom: form.joinDate,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || '新增失敗')
        return
      }

      onSuccess()
    } catch (err: any) {
      setError(err.message || '新增失敗')
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
        <h2 style={{ margin: '0 0 20px 0' }}>＋ 新增員工</h2>

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
          {/* Basic info */}
          <div className="form-group">
            <label>姓名 *</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="輸入姓名"
            />
          </div>

          <div className="form-group">
            <label>手機 *</label>
            <input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="09xxxxxxxx"
            />
          </div>

          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="optional@email.com"
            />
          </div>

          <div className="form-group">
            <label>密碼 *</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="設定初始密碼"
            />
          </div>

          {/* Clinics */}
          <div className="form-group">
            <label>診所配置（至少選1家，第一家為主診所）*</label>
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

          {/* Join date */}
          <div className="form-group">
            <label>到職日</label>
            <input
              type="date"
              value={form.joinDate}
              onChange={(e) => setForm({ ...form, joinDate: e.target.value })}
            />
          </div>

          {/* Pay rule */}
          <div style={{ borderTop: '1px solid #eee', paddingTop: 16, marginTop: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#555' }}>
              薪酬規則
            </div>

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
          </div>

          {/* Submit */}
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
              {submitting ? '處理中...' : '新增員工'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ============================================================
// CSV Import Modal
// ============================================================
function ImportModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void
  onSuccess: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<any | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<any | null>(null)
  const [step, setStep] = useState<'upload' | 'preview' | 'result'>('upload')
  const [error, setError] = useState('')
  const [clinics, setClinics] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    fetch('/api/clinics')
      .then((r) => r.json())
      .then((data) => setClinics(data.clinics || []))
      .catch(() => {})
  }, [])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (!selectedFile) return
    setFile(selectedFile)
    setError('')

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)
      formData.append('preview', 'true')

      const res = await fetch('/api/employees/import', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'CSV 解析失敗')
        return
      }

      setPreview(data)
      setStep('preview')
    } catch (err: any) {
      setError(err.message || 'CSV 解析失敗')
    }
  }

  const confirmImport = async () => {
    if (!file) return
    setImporting(true)
    setError('')

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/employees/import', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '匯入失敗')
        return
      }

      setResult(data)
      setStep('result')
    } catch (err: any) {
      setError(err.message || '匯入失敗')
    } finally {
      setImporting(false)
    }
  }

  const downloadTemplate = () => {
    const csv = `name,phone,clinicName,role,payType,baseAmount,email,joinDate\n陳醫生,0912345678,台北旗艦店,Doctor,SPLIT,70,dr.chen@email.com,2024-01-15\n李護士,0912345679,台北旗艦店,Nurse,HOURLY,250,nurse.li@email.com,2024-01-15\n王前台,0912345680,新竹分店,Receptionist,MONTHLY,45000,reception@email.com,2024-01-15`
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'employee_import_template.csv'
    a.click()
    URL.revokeObjectURL(url)
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
          maxWidth: 640,
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 24,
          margin: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 16px 0' }}>📥 批量匯入員工（CSV）</h2>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {['upload', 'preview', 'result'].map((s, i) => (
            <div
              key={s}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                background:
                  step === s ? '#1a1a2e' : i < ['upload', 'preview', 'result'].indexOf(step) ? '#c7d2fe' : '#e5e7eb',
              }}
            />
          ))}
        </div>

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

        {step === 'upload' && (
          <div>
            <div className="text-muted text-sm mb-4">
              CSV 欄位：name, phone, clinicName, role, payType, baseAmount, email (可選), joinDate (可選)
              <br />
              role: Doctor / Nurse / Receptionist / Other
              <br />
              payType: MONTHLY / DAILY / HOURLY / SPLIT
            </div>

            <button
              className="btn"
              style={{ background: '#f0f0f0', color: '#333', marginBottom: 16 }}
              onClick={downloadTemplate}
            >
              📄 下載範本 CSV
            </button>

            <div
              style={{
                border: '2px dashed #ddd',
                borderRadius: 8,
                padding: 40,
                textAlign: 'center',
                cursor: 'pointer',
              }}
              onClick={() => document.getElementById('csv-file-input')?.click()}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
              <div style={{ color: '#888' }}>
                {file ? file.name : '點擊或拖放上傳 CSV 檔案'}
              </div>
              <input
                id="csv-file-input"
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </div>
          </div>
        )}

        {step === 'preview' && preview && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <span className="text-sm" style={{ color: '#888' }}>
                共 {preview.totalLines} 筆資料
              </span>
            </div>

            {/* Success preview */}
            {preview.success && preview.success.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#2e7d32' }}>
                  ✅ 可匯入 ({preview.success.length} 筆)
                </div>
                <div style={{ maxHeight: 200, overflow: 'auto' }}>
                  <table style={{ fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th>姓名</th>
                        <th>手機</th>
                        <th>診所</th>
                        <th>薪酬類型</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.success.slice(0, 20).map((item: any, idx: number) => (
                        <tr key={idx}>
                          <td>{item.name}</td>
                          <td>{item.phone}</td>
                          <td>{clinics?.find((c) => c.id === item.clinicId)?.name || item.clinicId}</td>
                          <td>{item.payType}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.success.length > 20 && (
                    <div className="text-muted text-sm">...還有 {preview.success.length - 20} 筆</div>
                  )}
                </div>
              </div>
            )}

            {/* Skipped */}
            {preview.skipped && preview.skipped.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#e65100' }}>
                  ⚠️ 跳過（重複手機）({preview.skipped.length} 筆)
                </div>
                {preview.skipped.slice(0, 10).map((item: any, idx: number) => (
                  <div key={idx} style={{ fontSize: 13, color: '#e65100' }}>
                    第 {item.lineNum} 行: {item.reason}
                  </div>
                ))}
              </div>
            )}

            {/* Errors */}
            {preview.errors && preview.errors.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#dc2626' }}>
                  ❌ 錯誤 ({preview.errors.length} 筆)
                </div>
                {preview.errors.slice(0, 10).map((item: any, idx: number) => (
                  <div key={idx} style={{ fontSize: 13, color: '#dc2626' }}>
                    第 {item.lineNum} 行: {item.error}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                className="btn"
                style={{ background: '#f0f0f0', color: '#333' }}
                onClick={() => setStep('upload')}
              >
                重新上傳
              </button>
              <button
                className="btn btn-primary"
                disabled={importing || (preview.success?.length || 0) === 0}
                onClick={confirmImport}
              >
                {importing ? '匯入中...' : `確認匯入 (${preview.success?.length || 0} 筆)`}
              </button>
            </div>
          </div>
        )}

        {step === 'result' && result && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>匯入完成</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
              <div style={{ background: '#e8f5e9', padding: 16, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#2e7d32' }}>{result.summary?.imported}</div>
                <div style={{ fontSize: 12, color: '#2e7d32' }}>成功匯入</div>
              </div>
              <div style={{ background: '#fff3e0', padding: 16, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#e65100' }}>{result.summary?.skipped}</div>
                <div style={{ fontSize: 12, color: '#e65100' }}>跳過（重複）</div>
              </div>
              <div style={{ background: '#fef2f2', padding: 16, borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#dc2626' }}>{result.summary?.errors}</div>
                <div style={{ fontSize: 12, color: '#dc2626' }}>錯誤</div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={onSuccess}>
                完成
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#888',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            關閉
          </button>
        </div>
      </div>
    </div>
  )
}


