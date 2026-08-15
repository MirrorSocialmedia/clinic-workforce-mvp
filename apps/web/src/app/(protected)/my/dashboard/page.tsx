'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Hand, Smartphone, Calendar, Palmtree, Bell } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { toHKDateStr, fmtTime, fmtDate, fmtDateTime } from '@/lib/hk-date'
import { timebankLabel } from '@/lib/timebank-labels'

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
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<any[]>([])

  // ★ Time bank entries — lazy load on expand
  const [tbOpen, setTbOpen] = useState(false)
  const [tbEntries, setTbEntries] = useState<any[] | null>(null)
  const [attendanceOt, setAttendanceOt] = useState<{ otMinutes: number; lateMinutes: number } | null>(null)
  const [attDays, setAttDays] = useState<any[]>([])
  const [lateMinutes, setLateMinutes] = useState<number | null>(null)
  const [netLateMinutes, setNetLateMinutes] = useState<number | null>(null)
  const [rh, setRh] = useState<any>(null)
  const loadEntries = async () => {
    if (tbEntries !== null) return
    try {
      const r = await fetch('/api/my/timebank', { credentials: 'include' })
      if (r.ok) {
        const d = await r.json()
        setTbEntries(d.entries ?? [])
        setAttendanceOt(d.attendanceOt ?? null)
        setAttDays(d.attendanceDays ?? [])
        setLateMinutes(d.lateMinutes ?? null)
        setNetLateMinutes(d.netLateMinutes ?? null)
      }
    } catch {
      setTbEntries([])
    }
  }

  const fetchData = useCallback(async () => {
    setError('')
    try {
      const [summaryRes, scheduleRes, leaveRes, notifRes] = await Promise.all([
        fetch('/api/my/summary', { credentials: 'include' }),
        (() => {
          // ★ 2026-08-02：前端傳 from/to（今天 + 明天），確保 API 唔會因為預設值錯而漏晒今日
          const today = toHKDateStr(new Date())
          const tomorrow = toHKDateStr(new Date(Date.now() + 86400000))
          return fetch(`/api/my/schedule?from=${today}&to=${tomorrow}`, { credentials: 'include' })
        })(),
        fetch('/api/my/leave', { credentials: 'include' }),
        fetch('/api/notifications', { credentials: 'include' }),
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

      setSummary(summaryData.summary)
      // ★ 按開工時間排序（分更顯示正確）
      setSchedule(
        (scheduleData.shifts || []).sort(
          (a: any, b: any) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
        ),
      )
      setLeaveBalances(leaveData.leaveBalances || [])
      setNotifications(notifData.notifications || [])
      setUnreadCount(notifData.unreadCount || 0)
    } catch (err: any) {
      setError(err.message || '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    fetch('/api/my/roster-hours', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setRh(d))
      .catch(() => setRh(null))
  }, [])

  if (loading) return <div className="flex justify-center items-center py-12 text-muted-foreground">載入中...</div>
  if (error === 'Employee profile not found' || error?.includes('not allowed')) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <p style={{ fontSize: 15, marginBottom: 8 }}>呢一頁只適用於員工帳戶</p>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
          你嘅帳戶類型冇對應嘅員工資料
        </p>
        <button onClick={() => window.location.replace('/')}>返回首頁</button>
      </div>
    )
  }
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
          const todayStr = toHKDateStr(now)
          const tomorrow = new Date(now)
          tomorrow.setDate(tomorrow.getDate() + 1)  // tz-ok: client-side browser
          const tomorrowStr = toHKDateStr(tomorrow)

          const todayShifts = schedule.filter(s => (s.date || toHKDateStr(new Date(s.startTime))) === todayStr)
          const tomorrowShifts = schedule.filter(s => (s.date || toHKDateStr(new Date(s.startTime))) === tomorrowStr)

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
                      : fmtTime(s.startTime)
                    const endTime = s.endTime && typeof s.endTime === 'string' && s.endTime.length <= 5
                      ? s.endTime
                      : fmtTime(s.endTime)
                    return (
                      <div key={s.id}>
                        <div className="text-sm font-semibold text-foreground">
                          {startTime} - {endTime}
                        </div>
                        {/* ★ 調鋪：顯示「主店 → 副店」*/}
                        <div className="text-xs text-muted-foreground mt-0.5">
                          📍 {s.secondaryClinicName
                            ? <>
                                {s.clinicShortName || s.clinicName || s.clinic?.name || '-'}
                                <span className="mx-1 text-amber-600 font-medium">→</span>
                                {s.secondaryClinicShortName || s.secondaryClinicName}
                              </>
                            : (s.clinicShortName || s.clinicName || s.clinic?.name || '-')}
                        </div>
                        {s.secondaryClinicName && (
                          <div className="text-[10px] text-amber-600 mt-0.5">
                            ⚠️ 調鋪：上班喺{s.clinicShortName || s.clinicName}、落班喺{s.secondaryClinicShortName || s.secondaryClinicName}
                          </div>
                        )}
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

      {/* Late Attendance — StatCard only */}
      <StatCard value={summary?.lateMinutes || 0} title="本月遲到（分鐘）" color="violet" />

      {/* Time Bank — use summary data (少咗 /api/my/timebank fetch) */}
      {summary && summary.timeAccountMinutes != null && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">時間銀行</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const timeAccount = summary.timeAccountMinutes
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
                    {timeAccount < 0 && <>
                      拖欠公司時間，之後 OT 自動償還
                      <br />
                      <span className="text-red-600" style={{ fontSize: 12 }}>拖欠 {Math.abs(timeAccount)} 分鐘（約 {(Math.abs(timeAccount) / 540).toFixed(1)} 日）</span>
                    </>}
                    {timeAccount === 0 && '兩清'}
                  </div>
                  {/* 參考明細 */}
                  <div className="grid grid-cols-2 gap-3 mt-4 text-left">
                    <div className="text-center p-2 rounded-lg bg-white/60">
                      <div className="text-lg font-bold text-emerald-600">{summary.otMinutes ?? 0}</div>
                      <div className="text-xs text-muted-foreground">本月 OT</div>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-white/60">
                      <div className="text-lg font-bold" style={{ color: (summary.lateMinutes ?? 0) > 0 ? '#d97706' : 'inherit' }}>
                        {summary.lateMinutes ?? 0}
                      </div>
                      <div className="text-xs text-muted-foreground">本月遲到</div>
                    </div>
                  </div>

                  {/* ★ 摺疊明細 */}
                  <button
                    onClick={() => { setTbOpen(o => !o); if (!tbOpen) loadEntries() }}
                    className="w-full mt-2 text-xs py-1"
                  >
                    {tbOpen ? '收起明細 ▲' : '查看明細 ▼'}
                  </button>

                  {tbOpen && (
                    <div className="mt-2 border-t pt-2">
                      {tbEntries === null ? (
                        <div className="text-xs text-muted-foreground py-2 text-center">載入中…</div>
                      ) : (
                        <>
                          {/* ★ 已入帳（TimeBankEntry） */}
                          <div className="text-[10px] text-muted-foreground mb-1 font-semibold">
                            ── 已入帳（TimeBankEntry）
                          </div>
                          {tbEntries.length === 0 ? (
                            <div className="text-xs text-muted-foreground py-1 text-center">近兩月冇入帳記錄</div>
                          ) : (
                            <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                              {tbEntries.map(e => (
                                <div key={e.id} title={e.note || undefined}
                                  className="flex justify-between items-center py-1.5 border-b text-xs last:border-0">
                                  <span className="truncate">
                                    <span className="text-muted-foreground mr-1.5">{e.date.slice(5)}</span>
                                    {timebankLabel(e.type, e.targetType)}
                                  </span>
                                  <span style={{
                                    fontVariantNumeric: 'tabular-nums',
                                    color: e.minutes > 0 ? '#059669' : e.minutes < 0 ? '#dc2626' : '#9ca3af',
                                  }}>
                                    {e.minutes > 0 ? '+' : e.minutes < 0 ? '−' : ''}{Math.abs(e.minutes)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* ★ 本月考勤（未入帳） */}
                          {attendanceOt && (
                            <>
                              <div className="text-[10px] text-muted-foreground mb-1 font-semibold mt-2">
                                ── 本月考勤（未入帳）
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div className="text-center p-2 rounded-lg" style={{ backgroundColor: '#f0fdf4' }}>
                                  <div className="text-base font-bold text-emerald-600">{attendanceOt.otMinutes ?? 0}</div>
                                  <div className="text-[10px] text-muted-foreground">OT（分鐘）</div>
                                </div>
                                <div className="text-center p-2 rounded-lg" style={{ backgroundColor: '#fff7ed' }}>
                                  <div className="text-base font-bold" style={{ color: (lateMinutes ?? 0) > 0 ? '#d97706' : 'inherit' }}>
                                    {lateMinutes ?? 0}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">遲到（分鐘）</div>
                                  {/* 補鐘抵扣說明 */}
                                  {(lateMinutes ?? 0) !== (netLateMinutes ?? 0) && (
                                    <div className="text-[10px] text-muted-foreground mt-1 text-right">
                                      補鐘抵扣 {(lateMinutes ?? 0) - (netLateMinutes ?? 0)} 分 → 淨遲到 {netLateMinutes} 分
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* ★ 逐日考勤明細 */}
                              {attDays.length > 0 && (
                                <div style={{ maxHeight: 190, overflowY: 'auto', marginTop: 6 }}>
                                  {attDays.map((d: any) => (
                                    <div key={d.date} className="flex justify-between items-start py-1.5 border-b text-xs last:border-0">
                                      <span className="text-muted-foreground">{String(d.date).slice(5)}</span>
                                      <span className="flex flex-wrap gap-x-2 justify-end">
                                        {d.clockOutOt ? <span style={{ color: '#059669' }}>OT {d.clockOutOt} 分</span> : null}
                                        {d.lunchOt ? <span style={{ color: '#059669' }}>少休 {d.lunchOt} 分</span> : null}
                                        {d.lateMinutes ? <span style={{ color: '#d97706' }}>遲到 {d.lateMinutes} 分</span> : null}
                                        {d.lunchLate ? <span style={{ color: '#d97706' }}>超休 {d.lunchLate} 分</span> : null}
                                        {d.earlyMinutes ? <span style={{ color: '#dc2626' }}>早退 {d.earlyMinutes} 分</span> : null}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}

                              <div className="text-[10px] text-muted-foreground mt-1">
                                已入帳明細：本月及上月 · 考勤明細：本月
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  <div className="text-[10px] text-muted-foreground mt-1">
                    上面嘅結餘 = 累積結轉 ＋ 本月考勤 ＋ 已入帳調整
                  </div>
                </div>
              )
            })()}
          </CardContent>
        </Card>
      )}

      {/* Leave Balances */}
      {rh && (
        <div className="rounded-xl border p-3 mt-3">
          <div className="text-xs text-muted-foreground mb-2">本月工時</div>
          <div className="flex justify-between text-sm py-1">
            <span className="text-muted-foreground">應返</span>
            <span>{(rh.expectedMinutes / 60).toFixed(1)} h</span>
          </div>
          <div className="flex justify-between text-sm py-1">
            <span className="text-muted-foreground">已編班</span>
            <span>{(rh.rosterMinutes / 60).toFixed(1)} h</span>
          </div>
          <div className="flex justify-between text-sm pt-2 border-t font-medium">
            <span>{rh.settled ? '編更差額（已入帳）' : '預計 OT'}</span>
            <span style={{ color: rh.diffMinutes > 0 ? '#059669' : rh.diffMinutes < 0 ? '#dc2626' : '#6b7280' }}>
              {rh.diffMinutes > 0 ? '+' : rh.diffMinutes < 0 ? '−' : ''}
              {(Math.abs(rh.diffMinutes) / 60).toFixed(1)} h
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-2">
            {rh.settled ? '已出糧，數字已入時間帳戶' : '更表未定，出糧時以實際為準'}
          </div>
        </div>
      )}
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
                    <div className="text-lg font-bold" style={{ color: b.remaining < 0 ? '#dc2626' : undefined }}>
                      {b.remaining < 0 ? `欠 ${Math.abs(b.remaining).toFixed(1)}` : b.remaining.toFixed(1)}
                    </div>
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
                      {fmtDate(s.startTime)}
                    </span>
                    <Badge
                      variant={s.status === 'CONFIRMED' ? 'default' : 'secondary'}
                    >
                      {s.status === 'CONFIRMED' ? '已確認' : s.status === 'DRAFT' ? '草稿' : s.status}
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {fmtTime(s.startTime)}
                    {' - '}
                    {fmtTime(s.endTime)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {s.secondaryClinicName
                      ? <>
                          📍 {s.clinicShortName || s.clinicName || s.clinic?.name || '-'}
                          <span className="mx-1 text-amber-600 font-medium">→</span>
                          {s.secondaryClinicShortName || s.secondaryClinicName}
                        </>
                      : `📍 ${s.clinicShortName || s.clinicName || s.clinic?.name || '-'}`}
                  </div>
                  {s.secondaryClinicName && (
                    <div className="text-[10px] text-amber-600 mt-0.5">
                      ⚠️ 調鋪：上班喺{s.clinicShortName || s.clinicName}、落班喺{s.secondaryClinicShortName || s.secondaryClinicName}
                    </div>
                  )}
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
                      {fmtDateTime(n.createdAt)}
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
