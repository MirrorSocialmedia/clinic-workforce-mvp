'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CalendarDays, ShieldAlert, AlertTriangle, CheckSquare } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { toHKDateStr } from '@/lib/hk-date'
import { useTodoCount } from '@/lib/use-todo-count'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

interface TodayStats {
  clinicId: string
  clinicName: string
  scheduled: number
  clockedIn: number
  late: number
  notArrived: number
}

interface ClinicData {
  id: string
  name: string
  address: string | null
  _count: {
    users: number
    employees: number
    shifts: number
    punches?: number
  }
  employees?: { employeeId: string }[]
  todayStats: TodayStats | null
}

/** Format Date to YYYY-MM-DD in HK timezone */
export default function DashboardPage() {
  const router = useRouter()
  const todoCounts = useTodoCount()
  const [data, setData] = useState<{
    role: Role
    clinics: ClinicData[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [isEmployee, setIsEmployee] = useState(false)

  // Employee attendance summary — fixed to current month
  const [empSummary, setEmpSummary] = useState<any[]>([])
  const [empLoading, setEmpLoading] = useState(false)

  // Leave balances (all employees)
  const [leaveBalances, setLeaveBalances] = useState<any[]>([])

  // Sensitive operations (OWNER only)
  const [sensitiveOps, setSensitiveOps] = useState<any[] | null>(null)
  const [opsLoading, setOpsLoading] = useState(false)

  // Group balances by employeeId + systemKey
  const balancesByEmp = (() => {
    const m = new Map<string, Record<string, any>>()
    for (const b of leaveBalances) {
      if (!m.has(b.employeeId)) m.set(b.employeeId, {})
      const key = b.leaveType?.systemKey || b.leaveType?.name
      m.get(b.employeeId)![key] = b
    }
    return m
  })()

  useEffect(() => {
    fetch('/api/dashboard', { credentials: 'include' })
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `伺服器錯誤 (${res.status})`)
        }
        return res.json()
      })
      .then(d => {
        if (d.role === 'EMPLOYEE') {
          setIsEmployee(true)
          router.replace('/my/dashboard')
          return
        }
        setData({ role: d.role, clinics: d.clinics })
      })
      .catch(err => setError(err.message || '載入失敗'))
      .finally(() => setLoading(false))
  }, [router])

  // Fixed to current month, use periodMonth mode
  useEffect(() => {
    const periodMonth = toHKDateStr(new Date()).slice(0, 7) // YYYY-MM 香港月份

    setEmpLoading(true)
    fetch(`/api/payroll-runs/exceptions?periodMonth=${periodMonth}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { summaries: [] })
      .then(d => setEmpSummary(d.summaries || []))
      .catch(() => setEmpSummary([]))
      .finally(() => setEmpLoading(false))
  }, [])

  // Fetch leave balances
  useEffect(() => {
    fetch('/api/leave-balance', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { leaveBalances: [] })
      .then(d => setLeaveBalances(d.leaveBalances || []))
      .catch(() => setLeaveBalances([]))
  }, [])

  // Fetch sensitive operations (OWNER only)
  useEffect(() => {
    const role = data?.role
    if (role !== 'OWNER') return

    setOpsLoading(true)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const fromDate = toHKDateStr(sevenDaysAgo).slice(0, 10)
    const sensitiveActions = ['VOID_PUNCH', 'ABSENT_DEDUCT', 'ABSENT_DEDUCT_CANCEL', 'CONVERT']

    let promises = sensitiveActions.map(action =>
      fetch(`/api/audit-logs?action=${action}&fromDate=${fromDate}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : { logs: [] })
        .catch(() => ({ logs: [] }))
    )
    // Also fetch DELETE on LeaveRequest (Prisma extension logs as action=DELETE, entity=LeaveRequest)
    promises.push(
      fetch(`/api/audit-logs?action=DELETE&entity=LeaveRequest&fromDate=${fromDate}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : { logs: [] })
        .catch(() => ({ logs: [] }))
    )

    Promise.all(promises).then(results => {
      const allLogs = results.flatMap(r => r.logs || [])
      // Group by actor
      const byActor = new Map<string, { name: string; role: string; count: number; byAction: Record<string, number> }>()
      const actionLabels: Record<string, string> = {
        VOID_PUNCH: '作廢打卡',
        ABSENT_DEDUCT: '缺勤扣OT',
        ABSENT_DEDUCT_CANCEL: '取消扣OT',
        CONVERT: 'OT換假',
        LEAVE_DELETE: '刪除請假',
      }
      for (const log of allLogs) {
        const actorName = log.actor?.name || log.actorId
        const actorRole = log.actor?.role || ''
        // Normalize: DELETE on LeaveRequest → LEAVE_DELETE
        const action = (log.action === 'DELETE' && log.entity === 'LeaveRequest') ? 'LEAVE_DELETE' : log.action
        const existing = byActor.get(log.actorId)
        if (!existing) {
          byActor.set(log.actorId, { name: actorName, role: actorRole, count: 1, byAction: { [action]: 1 } })
        } else {
          existing.count++
          existing.byAction[action] = (existing.byAction[action] || 0) + 1
        }
      }
      const actors = Array.from(byActor.values()).sort((a, b) => b.count - a.count)
      setSensitiveOps(actors.map(a => ({ ...a, actionLabels })))
    }).catch(() => setSensitiveOps([])).finally(() => setOpsLoading(false))
  }, [data?.role])

  if (isEmployee) return null
  if (loading) return <div className="flex justify-center items-center py-12 text-muted-foreground">載入中...</div>
  if (error) return <div className="p-4 text-destructive">⚠️ {error}</div>
  if (!data) return <div className="p-4 text-muted-foreground">沒有資料</div>

  const roleLabels: Record<Role, string> = {
    OWNER: '創辦人 / 總管理',
    MANAGER: '診所經理',
    ACCOUNTANT: '會計',
    EMPLOYEE: '員工',
  }

  return (
    <div className="p-6 space-y-6" style={{ maxWidth: '1200px' }}>
      {/* Page Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground">儀表板</h1>
          <p className="text-sm text-muted-foreground mt-1">角色: {roleLabels[data.role]}</p>
        </div>
      </div>

      {/* ── Mobile-first cards: Face anomaly + Todo ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Face anomaly card */}
        <Card
          className="cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => router.push('/todo')}
        >
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle
              size={24}
              className={todoCounts.failN + todoCounts.noFaceN > 0 ? 'text-red-500' : 'text-green-500'}
            />
            <div>
              {todoCounts.failN + todoCounts.noFaceN > 0 ? (
                <div>
                  <span className="font-semibold">⚠️ {todoCounts.failN} 未通過</span>
                  <span className="text-muted-foreground mx-1">·</span>
                  <span className="font-semibold text-orange-500">🟠 {todoCounts.noFaceN} 未拍攝</span>
                  <span className="text-sm text-muted-foreground ml-1">→ 點擊處理</span>
                </div>
              ) : (
                <div className="text-green-600 font-medium">✅ 今日臉部驗證無異常</div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Todo summary card */}
        <Card
          className="cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => router.push('/todo')}
        >
          <CardContent className="p-4 flex items-center gap-3">
            <CheckSquare size={24} className={todoCounts.total > 0 ? 'text-amber-500' : 'text-green-500'} />
            <div>
              {todoCounts.total > 0 ? (
                <div>
                  <span className="font-semibold">{todoCounts.total} 項待處理</span>
                  <span className="text-sm text-muted-foreground ml-1">
                    （假期 {todoCounts.leaveN} · 登記 {todoCounts.enrollN} · 覆核 {todoCounts.reviewN}）
                  </span>
                </div>
              ) : (
                <div className="text-green-600 font-medium">🎉 全部待辦已完成</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Sensitive Operations Summary (OWNER only) ── */}
      {data.role === 'OWNER' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert size={18} /> 本週敏感操作摘要
            </CardTitle>
          </CardHeader>
          <CardContent>
            {opsLoading ? (
              <div className="text-center py-6 text-muted-foreground">載入中...</div>
            ) : sensitiveOps && sensitiveOps.length > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-semibold">
                    總計 {sensitiveOps.reduce((s, a) => s + a.count, 0)} 筆操作
                  </span>
                  <Link href="/audit-logs" className="text-sm text-brand hover:underline">
                    查看完整審計日誌 →
                  </Link>
                </div>
                <div className="space-y-2">
                  {sensitiveOps.map((actor) => (
                    <div key={actor.name} className="flex items-center justify-between px-3 py-2 rounded-lg border">
                      <div>
                        <span className="text-sm font-medium">{actor.name}</span>
                        {actor.role && <span className="ml-2 text-xs text-muted-foreground">({actor.role})</span>}
                      </div>
                      <div className="flex gap-2">
                        {Object.entries(actor.byAction).map(([action, count]) => {
                          const labels: Record<string, string> = (actor as any).actionLabels || {}
                          return (
                            <span key={action} className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                              {labels[action] || action}: {String(count)}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-muted-foreground text-sm">
                本週無敏感操作記錄
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Today's Daily Operations (multi-clinic) — compact grid ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarDays size={18} /> 今日各店營運</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {(data.clinics ?? []).map(clinic => {
              const stats = clinic.todayStats
              const abnormal = stats ? (stats.late + stats.notArrived) : 0
              return (
                <div key={clinic.id} className="border rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold truncate">{clinic.name}</span>
                    <span className="text-xs" style={{ color: abnormal > 0 ? '#dc2626' : '#10b981' }}>
                      {abnormal > 0 ? `${abnormal} 異常` : '正常'}
                    </span>
                  </div>
                  {stats ? (
                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                      <span>排班 {stats.scheduled}</span>
                      <span>已到 {stats.clockedIn}</span>
                      <span>未到 {stats.notArrived}</span>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground mt-1">今日無排班資料</div>
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Time Account Overview Card (cumulative) ── */}
      {empSummary.some(e => e.timeAccountMinutes != null) && (
        <div className="bg-card border rounded-xl p-6 shadow-card mb-6">
          <h3 className="text-lg font-semibold mb-3">⏱ 時間帳戶總覽（累計）</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {empSummary
              .filter(e => e.timeAccountMinutes != null) // 兼職不列
              .sort((a, b) => (a.timeAccountMinutes ?? 0) - (b.timeAccountMinutes ?? 0)) // 拖欠排前面
              .map(e => (
                <div key={e.employeeId} className="flex items-center justify-between px-3 py-2 rounded-lg border"
                  style={{
                    borderColor: (e.timeAccountMinutes ?? 0) >= 0 ? '#d1fae5' : '#fecaca',
                    background: (e.timeAccountMinutes ?? 0) >= 0 ? '#f0fdf4' : '#fef2f2',
                  }}>
                  <span className="text-sm font-medium">{e.employeeName}</span>
                  <span className="font-bold" style={{
                    color: (e.timeAccountMinutes ?? 0) >= 0 ? '#059669' : '#dc2626',
                  }}>
                    {(e.timeAccountMinutes ?? 0) >= 0 ? '+' : '−'}{Math.abs(e.timeAccountMinutes ?? 0)} 分
                    {(e.timeAccountMinutes ?? 0) < 0 && <span className="text-xs text-red-600 ml-1">（約 {(Math.abs(e.timeAccountMinutes ?? 0) / 540).toFixed(1)} 日）</span>}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── Employee Attendance Summary ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            📊 本月員工考勤詳細
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {empLoading ? (
            <div className="flex justify-center py-8 text-muted-foreground">載入中...</div>
          ) : empSummary.length === 0 ? (
            <div className="flex justify-center py-8 text-muted-foreground">沒有考勤資料</div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>員工</TableHead>
                    <TableHead>遲到次數</TableHead>
                    <TableHead>遲到時間</TableHead>
                    <TableHead>早退次數</TableHead>
                    <TableHead>早退時間</TableHead>
                    <TableHead>OT次數</TableHead>
                    <TableHead>本月OT</TableHead>
                    <TableHead>時間帳戶</TableHead>
                    <TableHead>可換假</TableHead>
                    <TableHead>休息日餘</TableHead>
                    <TableHead>年假餘</TableHead>
                    <TableHead>OT補假餘</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {empSummary.map(emp => (
                    <TableRow key={emp.employeeId}>
                      <TableCell className="font-medium">{emp.employeeName}</TableCell>
                      <TableCell style={emp.lateCount > 0 ? { color: '#d97706', fontWeight: 600 } : {}}>
                        {emp.lateCount ?? 0} 次
                      </TableCell>
                      <TableCell style={{ color: (emp.lateMinutes ?? 0) > 0 ? '#d97706' : 'inherit' }}>
                        {emp.lateMinutes ?? 0} 分鐘
                        {emp.makeupMinutes != null && emp.makeupMinutes > 0 && <span className="text-xs text-muted-foreground ml-1">（已補{emp.makeupMinutes}）</span>}
                      </TableCell>
                      <TableCell style={emp.earlyLeaveCount > 0 ? { color: '#dc2626', fontWeight: 600 } : {}}>
                        {emp.earlyLeaveCount ?? 0} 次
                      </TableCell>
                      <TableCell style={{ color: (emp.netEarlyMinutes ?? 0) > 0 ? '#dc2626' : 'inherit' }}>
                        {emp.netEarlyMinutes ?? 0} 分鐘
                      </TableCell>
                      <TableCell>{emp.otCount ?? 0} 次</TableCell>
                      <TableCell className="text-emerald-600">{emp.otMinutes ?? 0} 分鐘</TableCell>
                      <TableCell>
                        {emp.timeAccountMinutes == null ? '—' : (
                          <span style={{
                            fontWeight: 700,
                            color: emp.timeAccountMinutes >= 0 ? '#059669' : '#dc2626',
                          }}>
                            {emp.timeAccountMinutes >= 0 ? '+' : '−'}{Math.abs(emp.timeAccountMinutes)} 分
                            {emp.timeAccountMinutes < 0 && <span className="text-xs text-red-600 ml-1">（約 {(Math.abs(emp.timeAccountMinutes) / 540).toFixed(1)} 日）</span>}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {emp.convertibleLeaveDays == null ? '—' : `${(emp.convertibleLeaveDays).toFixed(1)} 天`}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const bal = balancesByEmp.get(emp.employeeId) || {}
                          const rd = bal.REST_DAY
                          if (!rd) return '-'
                          const val = rd.remaining ?? rd.entitled ?? 0
                          return Number(val).toFixed(1)
                        })()}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const bal = balancesByEmp.get(emp.employeeId) || {}
                          const al = bal.ANNUAL_LEAVE
                          if (!al) return '-'
                          return Number(al.remaining ?? 0).toFixed(1)
                        })()}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const bal = balancesByEmp.get(emp.employeeId) || {}
                          const ol = bal.OT_LEAVE
                          if (!ol) return '-'
                          return Number(ol.remaining ?? 0).toFixed(1)
                        })()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden p-4 space-y-2">
                {empSummary.map(emp => {
                  const bal = balancesByEmp.get(emp.employeeId) || {}
                  const rd = bal.REST_DAY
                  const al = bal.ANNUAL_LEAVE
                  const ol = bal.OT_LEAVE
                  return (
                    <div key={emp.employeeId} className="rounded-xl border shadow-card p-3">
                      <div className="font-semibold mb-1">{emp.employeeName}</div>
                      <div className="grid grid-cols-2 gap-1 text-xs">
                        <div style={emp.lateCount > 0 ? { color: '#d97706', fontWeight: 600 } : { color: '#888' }}>
                          遲到 {emp.lateCount ?? 0} 次 ({emp.lateMinutes ?? 0}分)
                        </div>
                        <div style={emp.earlyLeaveCount > 0 ? { color: '#dc2626', fontWeight: 600 } : { color: '#888' }}>
                          早退 {emp.earlyLeaveCount ?? 0} 次 ({emp.netEarlyMinutes ?? 0}分)
                        </div>
                        <div className="text-emerald-600">OT {emp.otCount ?? 0} 次 ({emp.otMinutes ?? 0}分)</div>
                        <div style={{
                          fontWeight: 700,
                          color: emp.timeAccountMinutes == null ? '#888' : emp.timeAccountMinutes >= 0 ? '#059669' : '#dc2626',
                        }}>
                          {emp.timeAccountMinutes == null ? '帳戶 —' : `${emp.timeAccountMinutes >= 0 ? '+' : '−'}${Math.abs(emp.timeAccountMinutes)} 分`}
                        </div>
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground mt-1 pt-1 border-t">
                        <span>休息日 {(rd ? Number(rd.remaining ?? 0).toFixed(1) : '—')}天</span>
                        <span>年假 {(al ? Number(al.remaining ?? 0).toFixed(1) : '—')}天</span>
                        <span>OT假 {(ol ? Number(ol.remaining ?? 0).toFixed(1) : '—')}天</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
