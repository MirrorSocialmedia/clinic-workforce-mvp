'use client'

import { useEffect, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
  todayStats: TodayStats | null
}

interface AuditLogData {
  id: string
  action: string
  entity: string
  notes: string | null
  createdAt: string
  actor: {
    name: string
    role: string
  }
}

/** Tremor-style Metric Card */
function StatCard({ value, title, color = 'blue' }: { value: number; title: string; color?: 'blue' | 'emerald' | 'amber' | 'violet' | 'cyan' }) {
  const colorMap = {
    blue: 'border-l-blue-500',
    emerald: 'border-l-emerald-500',
    amber: 'border-l-amber-500',
    violet: 'border-l-violet-500',
    cyan: 'border-l-cyan-500',
  }

  return (
    <div className={`bg-card border rounded-xl p-6 border-l-4 ${colorMap[color]} shadow-card`}>
      <div className="text-3xl font-bold text-foreground tabular-nums tracking-tight">{value}</div>
      <div className="text-sm text-muted-foreground mt-1">{title}</div>
    </div>
  )
}

export default function DashboardPage() {
  const [data, setData] = useState<{
    role: Role
    clinics: ClinicData[]
    recentAuditLogs: AuditLogData[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/dashboard', { credentials: 'include' })
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `伺服器錯誤 (${res.status})`)
        }
        return res.json()
      })
      .then(setData)
      .catch(err => setError(err.message || '載入失敗'))
      .finally(() => setLoading(false))
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

  const totalEmployees = (data.clinics ?? []).reduce((sum, c) => sum + (c._count?.employees ?? 0), 0)
  const totalShifts = (data.clinics ?? []).reduce((sum, c) => sum + (c._count?.shifts ?? 0), 0)

  return (
    <div className="p-6 space-y-6" style={{ maxWidth: '1200px' }}>
      {/* Page Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground">儀表板</h1>
          <p className="text-sm text-muted-foreground mt-1">角色: {roleLabels[data.role]}</p>
        </div>
      </div>

      {/* Stats overview — Tremor-style cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard value={data.clinics?.length ?? 0} title="可見診所" color="blue" />
        <StatCard value={totalEmployees} title="總員工數" color="emerald" />
        <StatCard value={totalShifts} title="總班數" color="amber" />
        <StatCard value={data.recentAuditLogs?.length ?? 0} title="最近審計記錄" color="violet" />
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

      {/* Clinics overview */}
      <Card>
        <CardHeader>
          <CardTitle>診所概要</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(data.clinics ?? []).map(clinic => (
              <div
                key={clinic.id}
                className="border rounded-xl p-5 bg-muted/30 shadow-card hover:shadow-soft transition-shadow"
              >
                <div className="font-semibold text-base mb-2">{clinic.name}</div>
                {clinic.address && <div className="text-muted-foreground text-sm mb-3">{clinic.address}</div>}
                <div className="flex gap-4 text-sm text-muted-foreground">
                  <span>👥 {clinic._count?.users || 0} 用戶</span>
                  <span>👤 {clinic._count?.employees || 0} 員工</span>
                  <span>📋 {clinic._count?.shifts || 0} 班</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent audit logs */}
      {(data.recentAuditLogs?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>最近審計日誌</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>時間</TableHead>
                  <TableHead>操作者</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead>實體</TableHead>
                  <TableHead>備註</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data.recentAuditLogs ?? []).map(log => (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap text-sm">
                      {new Date(log.createdAt).toLocaleString('zh-HK')}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span>{log.actor.name}</span>
                        <Badge
                          variant={log.actor.role === 'OWNER' ? 'default' : log.actor.role === 'MANAGER' ? 'secondary' : 'outline'}
                        >
                          {log.actor.role}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{log.action}</code>
                    </TableCell>
                    <TableCell>{log.entity}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{log.notes || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
