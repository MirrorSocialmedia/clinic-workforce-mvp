'use client'

import { useEffect, useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { fmtDateTime } from '@/lib/hk-date'

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

  
  const ENTITY_LABELS: Record<string, string> = {
    PayRule: '薪酬規則', Shift: '排班', PunchRecord: '打卡', PunchCorrection: '打卡補登',
    User: '用戶', Employee: '員工', Clinic: '診所', LeaveRequest: '請假',
    LeaveType: '假期類型', ShiftChangeRequest: '換班申請', ShiftTemplate: '班表模板',
    DailyHash: '完整性驗證', Notification: '通知',
  }

  // Comprehensive audit action Chinese labels
  const AUDIT_ACTION_LABELS: Record<string, string> = {
    'EMPLOYEE_CREATED': '新增員工',
    'EMPLOYEE_UPDATED': '更新員工',
    'EMPLOYEE_DELETED': '刪除員工',
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
    'LEAVE_REQUEST_CREATED': '申請假期',
    'LEAVE_REQUEST_APPROVED': '假期批準',
    'LEAVE_REQUEST_REJECTED': '假期拒絕',
    'LEAVE_TYPE_CREATED': '新增假期類型',
    'LEAVE_TYPE_UPDATED': '更新假期類型',
    'LEAVE_TYPE_DELETED': '刪除假期類型',
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
    'EMERGENCY_NUMBER_UPDATED': '更新緊急聯絡人',
    // Keep existing simple labels
    'CREATE': '新增', 'UPDATE': '修改', 'DELETE': '刪除', 'LOGIN': '登入', 'LOGOUT': '登出',
    // TimeBank / OT actions
    'TIMEBANK_INIT_ADJUST': '初始化時間帳戶',
    'TIMEBANK_MAKEUP': '補鐘',
    'TIMEBANK_CONVERT': '時間帳戶兌換',
    'TIMEBANK_ABSENT_DEDUCT': '缺勤扣OT鐘',
    'TIMEBANK_REST_TO_ACCOUNT': '休息日還鐘',
    // Legacy action names (kept for existing audit logs)
    'CONVERT': 'OT換假',
    'MAKEUP': '補鐘',
    'ABSENT_DEDUCT': '缺勤扣OT',
  }
  function getActionLabel(action: string): string {
    return AUDIT_ACTION_LABELS[action] || action
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

  useEffect(() => { fetchLogs() }, [page, filters])

  const totalPages = Math.ceil(total / 50)

  if (loading) return <div className="p-6">載画中...</div>
  if (error) return <div className="p-6" style={{ color: '#dc2626' }}>載画審計日志失败：{error}</div>

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
                {logs.map(log => (
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
                    <td title={log.action}><span className='text-sm font-medium'>{getActionLabel(log.action)}</span>{getActionLabel(log.action) !== log.action && <span className="text-muted text-sm ml-1" style={{fontSize:10}}>({log.action})</span>}</td>
                    <td>
                      {log.entity === 'LeaveRequest' && log.notes
                        ? log.notes
                        : (ENTITY_LABELS[log.entity] || log.entity)
                      }
                      {!(log.entity === 'LeaveRequest' && log.notes) && <span className="text-muted text-sm"> #{log.entityId.slice(0,8)}</span>}
                      {log.entity === 'LeaveRequest' && log.notes && <span className="text-muted text-sm"> #{log.entityId.slice(0,8)}</span>}
                      {log.beforeJson && log.afterJson && (
                        <div className="text-xs mt-1">
                          <span className="text-muted-foreground">原始: </span>
                          {typeof log.beforeJson === 'string' ? log.beforeJson : JSON.stringify(log.beforeJson)}
                          <span className="mx-1">→</span>
                          <span className="text-muted-foreground">修改後: </span>
                          {typeof log.afterJson === 'string' ? log.afterJson : JSON.stringify(log.afterJson)}
                        </div>
                      )}
                    </td>
                    <td className="text-sm">{log.ipAddress || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {logs.map(log => (
                <div key={log.id} className="rounded-xl border shadow-card p-3">
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <div className="font-semibold text-sm">{log.actor.name}</div>
                      <div className="text-xs text-muted-foreground">{fmtDateTime(log.createdAt)}</div>
                    </div>
                    <span className='text-sm font-medium'>{getActionLabel(log.action)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {log.entity === 'LeaveRequest' && log.notes
                      ? log.notes
                      : (ENTITY_LABELS[log.entity] || log.entity)
                    }
                    <span className="text-muted"> #{log.entityId.slice(0,8)}</span>
                  </div>
                  {log.beforeJson && log.afterJson && (
                    <div className="text-xs mb-1">
                      <span className="text-muted-foreground">原始: </span>
                      {typeof log.beforeJson === 'string' ? log.beforeJson : JSON.stringify(log.beforeJson)}
                      <span className="mx-1">→</span>
                      <span className="text-muted-foreground">修改後: </span>
                      {typeof log.afterJson === 'string' ? log.afterJson : JSON.stringify(log.afterJson)}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">IP: {log.ipAddress || '—'}</div>
                </div>
              ))}
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
          <li>每筆記錄包含操作者、操作類型、實體、變更前後快照</li>
        </ul>
      </div>
    </div>
  )
}
