'use client'

import { useEffect, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

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
function toHKDateStr(d: Date): string {
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export default function DashboardPage() {
  const [data, setData] = useState<{
    role: Role
    clinics: ClinicData[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Employee attendance summary — fixed to current month
  const [empSummary, setEmpSummary] = useState<any[]>([])
  const [empLoading, setEmpLoading] = useState(false)

  // Leave balances (all employees)
  const [leaveBalances, setLeaveBalances] = useState<any[]>([])

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
      .then(d => setData({ role: d.role, clinics: d.clinics }))
      .catch(err => setError(err.message || '載入失敗'))
      .finally(() => setLoading(false))
  }, [])

  // Fixed to current month, use periodMonth mode
  useEffect(() => {
    const periodMonth = new Date().toISOString().slice(0, 7) // YYYY-MM

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>員工</TableHead>
                  <TableHead>遲到次數</TableHead>
                  <TableHead>遲到時間</TableHead>
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
                    <TableCell>{emp.otCount ?? 0} 次</TableCell>
                    <TableCell className="text-emerald-600">{emp.otMinutes ?? 0} 分鐘</TableCell>
                    <TableCell>
                      {emp.timeAccountMinutes == null ? '—' : (
                        <span style={{
                          fontWeight: 700,
                          color: emp.timeAccountMinutes >= 0 ? '#059669' : '#dc2626',
                        }}>
                          {emp.timeAccountMinutes >= 0 ? '+' : '−'}{Math.abs(emp.timeAccountMinutes)} 分
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
          )}
        </CardContent>
      </Card>
    </div>
  )
}
