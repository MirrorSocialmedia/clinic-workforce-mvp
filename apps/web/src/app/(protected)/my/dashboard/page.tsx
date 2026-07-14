'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Hand, Smartphone, Calendar, Palmtree, Bell } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

/** Tremor-style Stat Card */
function StatCard({ value, title, color = 'blue' }: { value: number; title: string; color?: 'blue' | 'emerald' | 'amber' | 'violet' | 'cyan' }) {
  const colorMap = {
    blue: 'border-l-blue-500',
    emerald: 'border-l-emerald-500',
    amber: 'border-l-amber-500',
    violet: 'border-l-violet-500',
    cyan: 'border-l-cyan-500',
  }

  return (
    <div className={`bg-card border rounded-xl p-5 border-l-4 ${colorMap[color]} shadow-card`}>
      <div className="text-3xl font-bold text-foreground tabular-nums tracking-tight">{value}</div>
      <div className="text-sm text-muted-foreground mt-1">{title}</div>
    </div>
  )
}

export default function MyDashboardPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<any>(null)
  const [schedule, setSchedule] = useState<any[]>([])
  const [leaveBalances, setLeaveBalances] = useState<any[]>([])
  const [timebank, setTimebank] = useState<any>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<any[]>([])

  const fetchData = useCallback(async () => {
    setError('')
    try {
      const [summaryRes, scheduleRes, leaveRes, notifRes, tbRes] = await Promise.all([
        fetch('/api/my/summary', { credentials: 'include' }),
        fetch('/api/my/schedule', { credentials: 'include' }),
        fetch('/api/my/leave', { credentials: 'include' }),
        fetch('/api/notifications', { credentials: 'include' }),
        fetch('/api/my/timebank', { credentials: 'include' }).then(r => r).catch(() => ({ ok: false } as Response)),
      ])

      if (!summaryRes.ok || !scheduleRes.ok || !leaveRes.ok || !notifRes.ok) {
        const failed = [summaryRes, scheduleRes, leaveRes, notifRes].find(r => !r.ok)
        if (failed) {
          const body = await failed.json().catch(() => ({}))
          throw new Error(body.error || `伺服器錯誤 (${failed.status})`)
        }
      }

      const summaryData = await summaryRes.json()
      const scheduleData = await scheduleRes.json()
      const leaveData = await leaveRes.json()
      const notifData = await notifRes.json()
      const tbData = tbRes.ok ? await tbRes.json() : null

      setSummary(summaryData.summary)
      setSchedule(scheduleData.shifts || [])
      setLeaveBalances(leaveData.leaveBalances || [])
      setNotifications(notifData.notifications || [])
      setUnreadCount(notifData.unreadCount || 0)
      setTimebank(tbData)
    } catch (err: any) {
      setError(err.message || '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) return <div className="flex justify-center items-center py-12 text-muted-foreground">載入中...</div>
  if (error) return <div className="p-4 text-destructive">⚠️ {error}</div>

  return (
    <div className="p-4 space-y-4" style={{ maxWidth: '640px' }}>
      <h1 className="text-xl font-bold text-foreground">
        <Hand size={20} style={{ marginRight: 8 }} /> 我的首頁
      </h1>

      {/* Quick Actions — 2x2 grid on mobile */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">快捷操作</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            {[
              { href: '/punch', icon: <Smartphone size={22} />, label: '打卡' },
              { href: '/my/schedule', icon: <Calendar size={22} />, label: '班表' },
              { href: '/my/leave', icon: <Palmtree size={22} />, label: '假期' },
              { href: '/my/notifications', icon: <Bell size={22} />, label: '通知', badge: unreadCount },
            ].map(item => (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center p-4 rounded-lg bg-muted/50 hover:bg-muted transition-colors relative group"
              >
                {typeof item.icon === 'string' ? (
                  <span className="text-2xl mb-1">{item.icon}</span>
                ) : (
                  <span className="mb-1">{item.icon}</span>
                )}
                <span className="text-sm font-medium text-foreground">{item.label}</span>
                {item.badge && item.badge > 0 && (
                  <Badge variant="destructive" className="absolute top-2 right-2 text-[10px] px-1.5 py-0 min-w-0">
                    {item.badge}
                  </Badge>
                )}
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Today/Tomorrow Shift Cards — 2-col grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {(() => {
          const now = new Date()
          const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
          const tomorrow = new Date(now)
          tomorrow.setDate(tomorrow.getDate() + 1)
          const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

          const todayShifts = schedule.filter(s => (s.date || new Date(s.startTime).toISOString().slice(0, 10)) === todayStr)
          const tomorrowShifts = schedule.filter(s => (s.date || new Date(s.startTime).toISOString().slice(0, 10)) === tomorrowStr)

          const renderShiftCard = (title: string, shifts: any[], label: string) => (
            <div className="bg-card border rounded-xl p-4 shadow-sm">
              <div className="text-xs text-muted-foreground mb-2 font-medium">{label}</div>
              {shifts.length === 0 ? (
                <div className="text-sm text-muted-foreground">無排班</div>
              ) : (
                <div className="space-y-2">
                  {shifts.map(s => {
                    const startTime = s.startTime && typeof s.startTime === 'string' && s.startTime.length <= 5
                      ? s.startTime
                      : new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })
                    const endTime = s.endTime && typeof s.endTime === 'string' && s.endTime.length <= 5
                      ? s.endTime
                      : new Date(s.endTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })
                    return (
                      <div key={s.id}>
                        <div className="text-sm font-semibold text-foreground">
                          {startTime} - {endTime}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          📍 {s.clinic?.name || s.clinicName || '-'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )

          return (
            <>
              {renderShiftCard('', todayShifts, '今天')} {renderShiftCard('', tomorrowShifts, '明天')}
            </>
          )
        })()}
      </div>

      {/* Summary Stats — 2-col grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <StatCard value={summary?.shiftCount || 0} title="本月排班" color="blue" />
        <StatCard value={summary?.clockInCount || 0} title="本月打卡（上工）" color="emerald" />
        <StatCard value={summary?.leaveDays || 0} title="本月請假（天）" color="amber" />
      </div>

      {/* Late Attendance — 2-col grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="bg-card border rounded-xl p-4 border-l-4 border-l-red-500 shadow-sm">
          <div className="text-3xl font-bold text-foreground tabular-nums tracking-tight">{summary?.lateCount || 0}</div>
          <div className="text-sm text-muted-foreground mt-1">本月遲到次數</div>
          {summary?.lateMinutes != null && summary.lateMinutes > 0 && (
            <div className="text-xs text-muted-foreground mt-1">共 {summary.lateMinutes} 分鐘</div>
          )}
          {summary?.lateMinutes != null && summary.lateMinutes > 30 && (
            <div className="text-xs text-destructive mt-1">⚠️ 已超30分，勤工獎可能取消</div>
          )}
        </div>
        <StatCard value={summary?.lateMinutes || 0} title="本月遲到（分鐘）" color="violet" />
      </div>

      {/* Time Bank — 單一時間帳戶 */}
      {timebank && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">時間銀行</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const timeAccount = timebank.timeAccountMinutes ?? (timebank.balance ?? (timebank.availableMinutes ?? 0) - (timebank.owedMinutes ?? 0))
              return (
                <div className="rounded-xl p-5 text-center" style={{
                  borderColor: timeAccount >= 0 ? '#10b981' : '#dc2626',
                  borderWidth: 2,
                  background: timeAccount >= 0 ? '#f0fdf4' : '#fef2f2',
                }}>
                  <div className="text-sm text-muted-foreground">我的時間帳戶</div>
                  <div className="text-3xl font-bold mt-1" style={{ color: timeAccount >= 0 ? '#059669' : '#dc2626' }}>
                    {timeAccount >= 0 ? '+' : '−'}{Math.abs(timeAccount)} 分鐘
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">
                    {timeAccount > 0 && `可換假 ${Math.floor(timeAccount / 540)} 天（餘 ${timeAccount % 540} 分）`}
                    {timeAccount < 0 && '拖欠公司時間，之後 OT 自動償還'}
                    {timeAccount === 0 && '兩清'}
                  </div>
                  {/* 參考明細 */}
                  <div className="grid grid-cols-2 gap-3 mt-4 text-left">
                    <div className="text-center p-2 rounded-lg bg-white/60">
                      <div className="text-lg font-bold text-emerald-600">{timebank.otMinutes ?? 0}</div>
                      <div className="text-xs text-muted-foreground">本月 OT</div>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-white/60">
                      <div className="text-lg font-bold" style={{ color: (timebank.lateMinutes ?? 0) > 0 ? '#d97706' : 'inherit' }}>
                        {timebank.lateMinutes ?? 0}
                      </div>
                      <div className="text-xs text-muted-foreground">本月遲到</div>
                    </div>
                  </div>
                </div>
              )
            })()}
          </CardContent>
        </Card>
      )}

      {/* Leave Balances */}
      {leaveBalances.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">假期餘額</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {leaveBalances.map(b => (
                <div
                  key={b.id}
                  className="flex items-center justify-between p-3 rounded-lg"
                  style={{
                    background: `${b.leaveType.color || '#0d7377'}10`,
                    borderLeft: `3px solid ${b.leaveType.color || '#0d7377'}`,
                  }}
                >
                  <div>
                    <div className="text-sm text-muted-foreground">{b.leaveType.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-foreground">{b.remaining.toFixed(1)}</div>
                    <div className="text-xs text-muted-foreground">天剩餘</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upcoming Shifts */}
      {schedule.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">即將到來的班次</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {schedule.slice(0, 5).map(s => (
                <div
                  key={s.id}
                  className="p-3 rounded-lg bg-muted/50"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-sm text-foreground">
                      {new Date(s.startTime).toLocaleDateString('zh-HK')}
                    </span>
                    <Badge
                      variant={s.status === 'CONFIRMED' ? 'default' : 'secondary'}
                    >
                      {s.status === 'CONFIRMED' ? '已確認' : s.status === 'DRAFT' ? '草稿' : s.status}
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                    {' - '}
                    {new Date(s.endTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.clinic?.name || '-'}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Notifications */}
      {notifications.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">最近通知</CardTitle>
              <Link href="/my/notifications" className="text-sm text-brand hover:underline">
                查看全部 →
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {notifications.slice(0, 5).map(n => (
                <div
                  key={n.id}
                  className="flex items-center justify-between py-2.5 px-4"
                >
                  <div className="flex-1 min-w-0 mr-2">
                    <div className="text-sm text-foreground truncate">{n.content}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {new Date(n.createdAt).toLocaleString('zh-HK')}
                    </div>
                  </div>
                  {!n.isRead && (
                    <div className="w-2 h-2 rounded-full bg-destructive flex-shrink-0" />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
