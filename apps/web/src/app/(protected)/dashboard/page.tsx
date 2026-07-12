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

  // Employee attendance summary
  const [empSummary, setEmpSummary] = useState<any[]>([])
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('month')
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

  useEffect(() => {
    const now = new Date()
    let startDate: string, endDate: string

    if (period === 'day') {
      startDate = endDate = toHKDateStr(now)
    } else if (period === 'week') {
      const d = new Date(now)
      const day = d.getDay()
      const monday = new Date(d)
      monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
      const sunday = new Date(monday)
      sunday.setDate(monday.getDate() + 6)
      startDate = toHKDateStr(monday)
      endDate = toHKDateStr(sunday)
    } else {
      startDate = toHKDateStr(new Date(now.getFullYear(), now.getMonth(), 1))
      endDate = toHKDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0))
    }

    setEmpLoading(true)
    fetch(`/api/payroll-runs/exceptions?startDate=${startDate}&endDate=${endDate}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { summaries: [] })
      .then(d => setEmpSummary(d.summaries || []))
      .catch(() => setEmpSummary([]))
      .finally(() => setEmpLoading(false))
  }, [period])

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

  const periodLabel = { day: '今日', week: '本週', month: '本月' } as const

  return (
    <div className="p-6 space-y-6" style={{ maxWidth: '1200px' }}>
      {/* Page Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground">儀表板</h1>
          <p className="text-sm text-muted-foreground mt-1">角色: {roleLabels[data.role]}</p>
        </div>
      </div>

      {/* ── Today's Daily Operations (multi-clinic) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarDays size={18} /> 今日各店營運</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(data.clinics ?? []).map(clinic => {
              const stats = clinic.todayStats
              return (
                <div
                  key={clinic.id}
                  className="border rounded-xl p-5 bg-muted/30 shadow-card hover:shadow-soft transition-shadow"
                >
                  <div className="font-semibold text-base mb-3">{clinic.name}</div>

                  {stats ? (
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span>📋 排班</span>
                        <span className="font-semibold">{stats.scheduled} 人</span>
                      </div>
                      <div className="flex justify-between">
                        <span>✅ 已到</span>
                        <span className="font-semibold text-emerald-600">{stats.clockedIn} 人</span>
                      </div>
                      <div className="flex justify-between">
                        <span>⚠️ 遲到</span>
                        <span className={`font-semibold ${stats.late > 0 ? 'text-red-600' : ''}`}>{stats.late} 人</span>
                      </div>
                      <div className="flex justify-between">
                        <span>⏳ 未到</span>
                        <span className={`font-semibold ${stats.notArrived > 0 ? 'text-amber-600' : ''}`}>{stats.notArrived} 人</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-muted-foreground text-sm">今日無排班資料</div>
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Employee Attendance Summary ── */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="flex items-center gap-2">
              📊 {periodLabel[period]}員工考勤詳細
            </CardTitle>
            <div className="flex gap-1">
              {(['day', 'week', 'month'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    period === p
                      ? 'bg-brand text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {periodLabel[p]}
                </button>
              ))}
            </div>
          </div>
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
                  <TableHead>遲到分鐘</TableHead>
                  <TableHead>OT 時間</TableHead>
                  <TableHead>拖欠</TableHead>
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
                      {emp.lateCount || 0}
                    </TableCell>
                    <TableCell style={emp.lateMinutes > 0 ? { color: '#d97706', fontWeight: 600 } : {}}>
                      {emp.lateMinutes || 0} 分
                    </TableCell>
                    <TableCell style={{ color: '#16a34a' }}>
                      {((emp.otMinutes || 0) / 60).toFixed(1)}h
                    </TableCell>
                    <TableCell style={emp.owedMinutes > 0 ? { color: '#dc2626' } : {}}>
                      {((emp.owedMinutes || 0) / 60).toFixed(1)}h
                    </TableCell>
                    <TableCell>
                      {emp.convertibleLeaveDays?.toFixed(1) || '0.0'} 天
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
