'use client'

import { useEffect, useState, useMemo } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { fmtDateTime } from '@/lib/hk-date'

/** 審計明細中不顯示的 ID 類欄位 */
const HIDDEN_KEYS = new Set([
  'id', 'employeeId', 'clinicId', 'userId', 'companyId', 'templateId', 'runId',
  'punchRecordId', 'leaveTypeId', 'createdBy', 'approvedBy', 'requestedBy',
  'createdAt', 'updatedAt', 'actorId', 'targetEmployeeId', 'entityId',
  'permissionsJson', 'password', 'passwordHash', 'token',
])

/** 欄位中文名映射 */
const FIELD_LABELS: Record<string, string> = {
  amount: '金額', description: '說明', periodMonth: '月份',
  punchType: '類型', punchTime: '時間', correctedTime: '時間',
  initMinutes: '時間帳戶', balanceMinutes: '餘額', otBalanceMinutes: 'OT餘額',
  minutes: '分鐘', delta: '變量', days: '天數',
  entitled: '額度', remaining: '剩餘', used: '已用',
  year: '年份', reason: '原因', voidReason: '作廢原因',
  status: '狀態', name: '名稱', role: '角色', payType: '薪資類型',
  date: '日期', startTime: '開始', endTime: '結束',
  faceScore: '相似度', totalPayable: '應付總額', periodMonthLabel: '計糧月份',
  leaveTypes: '假期類型', count: '筆數',
  oldValue: '舊值', newValue: '新值',
}

interface AuditLog {
  id: string
  actorId: string
  action: string
  entity: string
  entityId: string
  clinicId: string | null
  beforeJson: string | null
  afterJson: string | null
  notes: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  actor: {
    name: string
    phone: string
    role: string
  }
  targetEmployee?: {
    id: string
    user: {
      name: string
    }
  } | null
}

/** 友好顯示 JSON 明細：欄位轉中文、ID 隱藏、時間格式化 */
function fmtAudit(json: string): string {
  try {
    const o = JSON.parse(json)
    const parts: string[] = []
    const handled = new Set(['initMinutes', 'balanceMinutes', 'otBalanceMinutes', 'minutes'])

    // 時間帳戶類特殊處理
    if (o.initMinutes != null) parts.push(`時間帳戶: ${(o.initMinutes / 60).toFixed(1)}h`)
    if (o.balanceMinutes != null) parts.push(`餘額: ${(o.balanceMinutes / 60).toFixed(1)}h`)
    if (o.otBalanceMinutes != null) parts.push(`OT餘額: ${(o.otBalanceMinutes / 60).toFixed(1)}h`)
    if (o.minutes != null) parts.push(`${o.minutes > 0 ? '+' : ''}${(o.minutes / 60).toFixed(1)}h`)

    // 通用遍歷
    for (const [k, v] of Object.entries(o)) {
      if (HIDDEN_KEYS.has(k) || handled.has(k)) continue
      if (v == null || v === '') continue
      if (typeof v === 'object') continue
      const label = FIELD_LABELS[k] || k
      let val: any = v
      if (k === 'amount' || k === 'totalPayable') val = `$${Number(v).toLocaleString()}`
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) val = v.slice(0, 16).replace('T', ' ')
      parts.push(`${label}: ${val}`)
    }

    return parts.join('、') || '（無詳細）'
  } catch {
    return '（格式錯誤）'
  }
}

/** 差異值格式化 */
function fmtVal(key: string, val: any): string {
  if (key === 'amount' || key === 'totalPayable') return `$${Number(val).toLocaleString()}`
  if (key === 'minutes' || key === 'delta') return `${Number(val) > 0 ? '+' : ''}${(Number(val) / 60).toFixed(1)}h`
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) return val.slice(0, 16).replace('T', ' ')
  return String(val)
}

/** 比對 before/after 差異：只顯示變動的欄位 */
function fmtDiff(beforeJson?: string, afterJson?: string): string {
  try {
    const b = beforeJson ? JSON.parse(beforeJson) : {}
    const a = afterJson ? JSON.parse(afterJson) : {}
    const keys = new Set([...Object.keys(b), ...Object.keys(a)])
    const diffs: string[] = []
    for (const k of keys) {
      if (HIDDEN_KEYS.has(k)) continue
      if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue
      const label = FIELD_LABELS[k] || k
      diffs.push(`${label}: ${fmtVal(k, b[k])} → ${fmtVal(k, a[k])}`)
    }
    return diffs.join('、') || '（無變更）'
  } catch {
    return '（格式錯誤）'
  }
}

/** 從 beforeJson/afterJson 嘗試解析出 employeeId（舊記錄兜底） */
function tryParseEmployeeId(json: any): string | null {
  try {
    const o = typeof json === 'string' ? JSON.parse(json) : json
    return o.employeeId || null
  } catch {
    return null
  }
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState({
    action: '',
    entity: '',
    fromDate: '',
    toDate: '',
  })
  const [employeeMap, setEmployeeMap] = useState<Map<string, string>>(new Map())

  const ENTITY_LABELS: Record<string, string> = {
    PayRule: '薪酬規則', Shift: '排班', PunchRecord: '打卡記錄', PunchCorrection: '補登申請',
    User: '帳號', Employee: '員工', Clinic: '診所', Company: '公司',
    LeaveRequest: '假期申請', LeaveType: '假期類型', LeaveBalance: '假期額度',
    ShiftChangeRequest: '換班申請', ShiftTemplate: '更次模板',
    DailyHash: '完整性驗證', Notification: '通知',
    TimeBank: '時間帳戶', TimeBankEntry: '時間帳戶明細',
    FaceTemplate: '人臉模板', FaceEnrollCode: '登記碼', ACCOUNT: '帳號',
    ExpenseEntry: '雜項費用', PayrollRun: '計糧單', PayrollItem: '計糧明細',
    ConsultationRevenue: '營業額', PunchVoid: '作廢記錄',
  }

  // Comprehensive audit action Chinese labels
  const AUDIT_ACTION_LABELS: Record<string, string> = {
    'EMPLOYEE_CREATED': '新增員工',
    'EMPLOYEE_UPDATED': '更新員工',
    'EMPLOYEE_DELETED': '刪除員工',
    'EMPLOYEE_RESIGN': '員工離職',
    'EMPLOYEE_REHIRE': '員工復職',
    'SHIFT_CREATED': '新增班次',
    'SHIFT_UPDATED': '更新班次',
    'SHIFT_DELETED': '刪除班次',
    'SHIFT_ASSIGNED': '指派班次',
    'SHIFT_CHANGE_REQUEST': '換更申請',
    'SHIFT_CHANGE_APPROVED': '換更批準',
    'SHIFT_CHANGE_REJECTED': '換更拒絕',
    'PUNCH_CORRECTION_CREATED': '申請補打卡',
    'PUNCH_CORRECTION_APPROVED': '補打卡批準',
    'PUNCH_CORRECTION_REJECTED': '補打卡拒絕',
    'PUNCH_RECORDED': '打卡記錄',
    'PUNCH_EDIT': '編輯打卡',
    'VOID_PUNCH': '作廢打卡',
    'CREATE_PUNCH': '補登打卡',
    'LEAVE_REQUEST_CREATED': '申請假期',
    'LEAVE_REQUEST_APPROVED': '假期批準',
    'LEAVE_REQUEST_REJECTED': '假期拒絕',
    'LEAVE_TYPE_CREATED': '新增假期類型',
    'LEAVE_TYPE_UPDATED': '更新假期類型',
    'LEAVE_TYPE_DELETED': '刪除假期類型',
    'LEAVE_INIT': '初始化假期額度',
    'PAYROLL_RUN_CREATED': '生成計糧',
    'PAYROLL_RUN_UPDATED': '更新計糧',
    'PAYROLL_RUN_APPROVED': '批準計糧',
    'PAYROLL_RUN_EXPORTED': '匯出計糧',
    'PAYROLL_RULE_CREATED': '新增薪酬規則',
    'PAYROLL_RULE_UPDATED': '更新薪酬規則',
    'USER_CREATED': '新增用戶',
    'USER_UPDATED': '更新用戶',
    'USER_ROLE_CHANGED': '角色變更',
    'SETTING_UPDATED': '更新設定',
    'USER_CREATED_NEW_ACCOUNT': '新增帳號',
    'CREATE_ACCOUNT': '新增帳號',
    'CREATE_ACCOUNT_WITH_EMPLOYEE': '新增帳號(含員工)',
    'ACCOUNT_DELETE': '刪除帳號',
    'UPDATE_ACCOUNT': '更新帳號',
    'PASSWORD_RESET': '重設密碼',
    'EMERGENCY_NUMBER_UPDATED': '更新緊急聯絡人',
    'FACE_ENROLL': '人臉登記',
    'FACE_ENROLL_APPROVE': '人臉登記批准',
    'FACE_ENROLL_REJECT': '人臉登記拒絕',
    'FACE_ENROLL_CODE_ISSUED': '發出人臉登記碼',
    'FACE_REF_VIEW': '查看人臉參考照',
    'FACE_FRAME_VIEW': '查看人臉證據',
    'FACE_REVIEW_ACTION': '人臉覆核處置',
    'FACE_VERIFY': '人臉驗證',
    // TimeBank / OT actions
    'TIMEBANK_INIT_ADJUST': '初始化時間帳戶',
    'TIMEBANK_MAKEUP': '補鐘',
    'TIMEBANK_CONVERT': 'OT換假',
    'TIMEBANK_ABSENT_DEDUCT': '缺勤扣OT',
    'TIMEBANK_REST_TO_ACCOUNT': '休息日轉時間帳戶',
    // Expense
    'EXPENSE_CREATE': '新增雜項費用',
    'EXPENSE_DELETE': '取消雜項費用',
    // Payroll
    'CREATE_PAYROLL_RUN': '生成計糧',
    // Legacy action names
    'CONVERT': 'OT換假',
    'MAKEUP': '補鐘',
    'ABSENT_DEDUCT': '缺勤扣OT',
    'ABSENT_DEDUCT_CANCEL': '取消缺勤扣OT',
    // Generic actions (will be combined with entity name)
    'MUTATE': '系統變更', 'CREATE': '新增', 'UPDATE': '修改',
    'DELETE': '刪除', 'UPSERT': '新增/更新', 'CREATEMANY': '批次新增',
    'LOGIN': '登入', 'LOGOUT': '登出',
  }

  /** 動作標籤：通用動作會自動附加實體名稱 */
  function actionLabel(log: AuditLog): string {
    const GENERIC = new Set(['MUTATE', 'CREATE', 'UPDATE', 'DELETE', 'UPSERT', 'CREATEMANY'])
    const base = AUDIT_ACTION_LABELS[log.action] || log.action
    if (GENERIC.has(log.action)) {
      const ent = ENTITY_LABELS[log.entity] || log.entity
      return `${base}${ent}`
    }
    return base
  }
  const ROLE_LABELS: Record<string, string> = {
    OWNER: '院長', MANAGER: '管理', ACCOUNTANT: '會計', EMPLOYEE: '員工',
  }

  const fetchLogs = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' })
      if (filters.action) params.set('action', filters.action)
      if (filters.entity) params.set('entity', filters.entity)
      if (filters.fromDate) params.set('fromDate', filters.fromDate)
      if (filters.toDate) params.set('toDate', filters.toDate)

      const res = await fetch(`/api/audit-logs?${params}`, { credentials: 'include' })
      const data = await res.json()
      setLogs(data.logs || [])
      setTotal(data.total || 0)
      setLoading(false)
    } catch (e: any) {
      setError(e.message || '載入失敗')
      setLoading(false)
    }
  }

  // Load global employee map from API (not from logs)
  useEffect(() => {
    fetch('/api/employees?includeResigned=true', { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: any) => {
        const m = new Map<string, string>()
        ;(d.employees ?? d ?? []).forEach((e: any) => {
          m.set(e.id, e.user?.name ?? e.name ?? e.id)
        })
        setEmployeeMap(m)
      })
      .catch(() => { /* fallback: empty map */ })
  }, [])

  useEffect(() => { fetchLogs() }, [page, filters])

  const totalPages = Math.ceil(total / 50)

  // Get target employee name (from targetEmployee join or fallback from beforeJson/afterJson)
  function getTargetEmployeeName(log: AuditLog): string | null {
    if (log.targetEmployee?.user?.name) return log.targetEmployee.user.name
    // Fallback: try to parse employeeId from beforeJson/afterJson
    const targetId = tryParseEmployeeId(log.afterJson ?? log.beforeJson)
    if (targetId) return employeeMap.get(targetId) ?? null
    return null
  }

  if (loading) return <div className="p-6">載入中...</div>
  if (error) return <div className="p-6" style={{ color: '#dc2626' }}>載入審計日誌失敗：{error}</div>

  return (
    <div>
      <h1 style={{ margin: '0 0 16px 0' }}>審計日誌</h1>

      {/* Filters */}
      <div className="card mb-4">
        <h2>篩選條件</h2>
        <div className="grid-4">
          <div className="form-group">
            <label>操作類型</label>
            <select
              value={filters.action}
              onChange={e => { setFilters({ ...filters, action: e.target.value }); setPage(1) }}
            >
              <option value="">全部</option>
              <option value="CREATE">建立</option>
              <option value="UPDATE">更新</option>
              <option value="DELETE">刪除</option>
              <option value="LOGIN">登入</option>
              <option value="LOGOUT">登出</option>
              <option value="VOID_PUNCH">作廢打卡</option>
              <option value="CREATE_PUNCH">補登打卡</option>
              <option value="TIMEBANK_INIT_ADJUST">初始化時間帳戶</option>
              <option value="TIMEBANK_MAKEUP">補鐘</option>
              <option value="TIMEBANK_CONVERT">時間帳戶兌換</option>
              <option value="TIMEBANK_ABSENT_DEDUCT">缺勤扣OT鐘</option>
              <option value="TIMEBANK_REST_TO_ACCOUNT">休息日還鐘</option>
              <option value="LEAVE_INIT">初始化假期額度</option>
            </select>
          </div>
          <div className="form-group">
            <label>實體</label>
            <input
              value={filters.entity}
              onChange={e => { setFilters({ ...filters, entity: e.target.value }); setPage(1) }}
              placeholder="例如: Clinic"
            />
          </div>
          <div className="form-group">
            <label>從日期</label>
            <input
              type="date"
              value={filters.fromDate}
              onChange={e => { setFilters({ ...filters, fromDate: e.target.value }); setPage(1) }}
            />
          </div>
          <div className="form-group">
            <label>至日期</label>
            <input
              type="date"
              value={filters.toDate}
              onChange={e => { setFilters({ ...filters, toDate: e.target.value }); setPage(1) }}
            />
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="card">
        <div className="flex justify-between items-center mb-4">
          <h2 style={{ margin: 0 }}>日誌記錄 (共 {total} 筆)</h2>
          <span className="text-muted text-sm">
            第 {page} / {totalPages || 1} 頁
          </span>
        </div>

        {loading ? (
          <div>載入中...</div>
        ) : logs.length === 0 ? (
          <EmptyState text="尚無審計記錄" />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>時間</th>
                  <th>操作者</th>
                  <th>操作</th>
                  <th>實體</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => {
                  const targetEmpName = getTargetEmployeeName(log)
                  return (
                  <tr key={log.id}>
                    <td className="text-sm">{fmtDateTime(log.createdAt)}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{log.actor.name}</div>
                      <div className="text-muted text-sm">
                        {log.actor.phone}
                        <span className={`badge badge-${log.actor.role.toLowerCase()}`} style={{ marginLeft: 4 }}>
                          {ROLE_LABELS[log.actor.role] || log.actor.role}
                        </span>
                      </div>
                    </td>
                    <td title={log.action}>
                      <span className='text-sm font-medium'>{actionLabel(log)}</span>
                      {actionLabel(log) !== log.action && <span className="text-muted text-sm ml-1" style={{fontSize:10}}>({log.action})</span>}
                      {targetEmpName ? (
                        <div className="text-xs mt-0.5" style={{ color: '#2563eb' }}>員工：{targetEmpName}</div>
                      ) : log.entityId === 'batch' ? (
                        <div className="text-xs mt-0.5 text-muted-foreground">批次操作</div>
                      ) : null}
                    </td>
                    <td>
                      {log.entity === 'LeaveRequest' && log.notes
                        ? log.notes
                        : (ENTITY_LABELS[log.entity] || log.entity)
                      }
                      {log.beforeJson && log.afterJson ? (
                        <div className="text-xs mt-1">
                          {fmtDiff(log.beforeJson, log.afterJson)}
                        </div>
                      ) : (log.beforeJson || log.afterJson) ? (
                        <div className="text-xs mt-1">
                          {fmtAudit(log.afterJson ?? log.beforeJson ?? '')}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-sm">{log.ipAddress || '—'}</td>
                  </tr>
                  )})}
              </tbody>
            </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {logs.map(log => {
                const targetEmpName = getTargetEmployeeName(log)
                return (
                <div key={log.id} className="rounded-xl border shadow-card p-3">
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <div className="font-semibold text-sm">{log.actor.name}</div>
                      <div className="text-xs text-muted-foreground">{fmtDateTime(log.createdAt)}</div>
                    </div>
                    <span className='text-sm font-medium'>{actionLabel(log)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {log.entity === 'LeaveRequest' && log.notes
                      ? log.notes
                      : (ENTITY_LABELS[log.entity] || log.entity)
                    }
                    {targetEmpName ? <span className="ml-1" style={{ color: '#2563eb' }}>員工：{targetEmpName}</span> : log.entityId === 'batch' ? <span className="ml-1 text-muted-foreground">批次操作</span> : null}
                  </div>
                  {log.beforeJson && log.afterJson ? (
                    <div className="text-xs mb-1">
                      {fmtDiff(log.beforeJson, log.afterJson)}
                    </div>
                  ) : (log.beforeJson || log.afterJson) ? (
                    <div className="text-xs mb-1">
                      {fmtAudit(log.afterJson ?? log.beforeJson ?? '')}
                    </div>
                  ) : null}
                  <div className="text-xs text-muted-foreground">IP: {log.ipAddress || '—'}</div>
                </div>
                )})}
            </div>
          </>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex justify-between items-center mt-4">
            <button
              className="btn btn-primary btn-sm"
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
            >
              ← 上一頁
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              下一頁 →
            </button>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="card mt-4" style={{ background: '#f0f9ff', border: '1px solid #bae6fd' }}>
        <h2>⚠️ 防竄改保障</h2>
        <ul style={{ fontSize: 14, color: '#0c4a6e', lineHeight: 1.8 }}>
          <li>審計日誌為 <strong>Append-Only</strong> — 只可新增，不可修改或刪除</li>
          <li>系統不提供任何 AuditLog 的 UPDATE/DELETE API</li>
          <li>所有 Prisma 操作（CREATE/UPDATE/DELETE）自動記錄審計日誌</li>
          <li>每筆記錄包含操作者、操作類型、實體、目標員工、變更前後快照</li>
        </ul>
      </div>
    </div>
  )
}
