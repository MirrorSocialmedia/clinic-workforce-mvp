'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Hand, Smartphone, Calendar, Palmtree, Bell } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { toHKDateStr, fmtTime, fmtDate, fmtDateTime } from '@/lib/hk-date'
import { TIMEBANK_MINUTES_PER_DAY } from '@/lib/timebank-constants'

// ★ 2026-08-31 (cwm-earlyin)：本月預測逐項加減嘅單行 —— 直式逐行，唔係四格橫排
function ForecastRow({ label, value, sub, highlight, divider, bold, strong }: {
  label: string; value: number; sub?: string; highlight?: boolean; divider?: boolean; bold?: boolean; strong?: boolean
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      padding: '2px 4px', fontSize: 11,
      background: strong ? '#fef3c7' : highlight ? '#fef2f2' : undefined,
      borderTop: divider ? '1px solid #e5e7eb' : undefined,
      borderRadius: strong ? 4 : undefined,
    }}>
      <span style={{ color: strong ? '#92400e' : '#6b7280' }}>
        {label}{sub ? <span style={{ fontSize: 9, color: '#9ca3af' }}>（{sub}）</span> : null}
      </span>
      <span style={{
        color: strong ? '#92400e' : value > 0 ? '#059669' : value < 0 ? '#dc2626' : '#6b7280',
        fontWeight: bold || strong ? 700 : 500,
      }}>
        {value > 0 ? '+' : value < 0 ? '−' : ''}{Math.abs(value)}
      </span>
    </div>
  )
}

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

  // ★ 逐日考勤明細 —— lazy load on expand（拍板 2026-08-21：加返逐日、剷 TimeBankEntry 清單）
  const [tbOpen, setTbOpen] = useState(false)
  const [attDays, setAttDays] = useState<any[]>([])
  const [attDaysLoaded, setAttDaysLoaded] = useState(false)
  const [rh, setRh] = useState<any>(null)
  const loadEntries = async () => {
    if (attDaysLoaded) return
    try {
      const r = await fetch('/api/my/timebank', { credentials: 'include' })
      if (r.ok) {
        const d = await r.json()
        setAttDays(d.attendanceDays ?? [])
      }
    } catch {
      setAttDays([])
    } finally {
      setAttDaysLoaded(true)
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
                  {/* ★ 2026-08-19: OT 四格 —— ①OT（含提早上班）②午休OT ③遲到/早退/補鐘 ④本月實收 OT */}
                  {/*   ①+②+③ = netOtThisMonth（同 payroll-engine 一致，算式行寫出嚟防「加唔埋」） */}
                  {(() => {
                    // ★ 陷阱①：otMinutes 已含 lunchOt —— 第①格一定減走先，否則同第②格重複計
                    const c1 = (summary.otMinutes ?? 0) - (summary.lunchOtMinutes ?? 0) + (summary.earlyInOtMinutes ?? 0)
                    const c2 = summary.lunchOtMinutes ?? 0
                    // ★ 陷阱②：makeupMinutes（= late + early + absent）全部計入第③格，唔計三格加唔埋
                    const c3 = -((summary.netLateMinutes ?? 0) + (summary.netEarlyMinutes ?? 0) + (summary.makeupMinutes ?? 0))
                    const c4 = summary.netOtThisMonth ?? null
                    return (
                      <>
                        <div className="grid grid-cols-2 gap-2 mt-4">
                          <div>
                            <div className="text-[10px] text-muted-foreground">OT（含提早上班）</div>
                            <div className="text-base font-semibold" style={{ color: c1 >= 0 ? '#059669' : '#dc2626' }}>
                              {c1 >= 0 ? '+' : '−'}{Math.abs(c1)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-muted-foreground">午飯OT</div>
                            <div className="text-base font-semibold" style={{ color: '#059669' }}>+{c2}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-muted-foreground">遲到／早退／補鐘</div>
                            <div className="text-base font-semibold" style={{ color: c3 < 0 ? '#dc2626' : '#9ca3af' }}>
                              {c3 === 0 ? '0' : c3}
                            </div>
                            {/* ★ 拍板③(a)：用淨值，但補鐘要睇得到 */}
                            {(summary.makeupMinutes ?? 0) > 0 && (
                              <div className="text-[9px] text-muted-foreground">
                                含補鐘 {summary.makeupMinutes} 分
                                {(summary.makeupAbsentMinutes ?? 0) > 0 && `（缺勤 ${summary.makeupAbsentMinutes}）`}
                              </div>
                            )}
                          </div>
                          <div className="rounded" style={{ background: '#f0fdf4', padding: 4 }}>
                            <div className="text-[10px] text-muted-foreground font-medium">本月實收 OT</div>
                            <div className="text-base font-bold" style={{ color: c4 === null ? '#9ca3af' : c4 >= 0 ? '#059669' : '#dc2626' }}>
                              {c4 === null ? '—' : `${c4 >= 0 ? '+' : '−'}${Math.abs(c4)}`}
                            </div>
                          </div>
                        </div>
                        {/* ★ 算式直接寫出嚟 —— 最直接嘅防線 */}
                        <div className="text-[9px] text-muted-foreground mt-1">
                          {c1} {c2 >= 0 ? '+' : '−'} {Math.abs(c2)} {c3 >= 0 ? '+' : '−'} {Math.abs(c3)} = {c4 === null ? '—' : c4}
                        </div>

                        {/* ★ 2026-08-31 (cwm-earlyin) 拍板③：OT 換假／退回 —— 有值先顯示（分鐘＋天）。
                            日數換算用共享常數（同寫入側同一個「一日」單位），唔好再砌第三個寫死值。 */}
                        {((summary?.leaveConvertMinutes ?? 0) !== 0 || (summary?.leaveSwapBackMinutes ?? 0) !== 0) && (
                          <div className="grid grid-cols-2 gap-px mt-1">
                            {(summary?.leaveConvertMinutes ?? 0) !== 0 && (
                              <div className="text-center p-1">
                                <div className="text-[10px] text-muted-foreground">OT 換假</div>
                                <div className="text-sm font-semibold text-red-600">{summary.leaveConvertMinutes}</div>
                                <div className="text-[9px] text-muted-foreground">
                                  {Math.abs(summary.leaveConvertMinutes / TIMEBANK_MINUTES_PER_DAY).toFixed(1)} 天
                                </div>
                              </div>
                            )}
                            {(summary?.leaveSwapBackMinutes ?? 0) !== 0 && (
                              <div className="text-center p-1">
                                <div className="text-[10px] text-muted-foreground">換假退回</div>
                                <div className="text-sm font-semibold text-emerald-600">+{summary.leaveSwapBackMinutes}</div>
                                <div className="text-[9px] text-muted-foreground">
                                  {(summary.leaveSwapBackMinutes / TIMEBANK_MINUTES_PER_DAY).toFixed(1)} 天
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* ★ 2026-08-31 (cwm-earlyin)：本月預測改直式逐項加減（拍板④⑤）。
                            原本四格加起身唔等於預計月底（中間差咗 convertedMinutes，完全冇顯示）。
                            ⚠️★★★ 三個守住嘅點：
                            ①「目前結餘」直接用 timeAccountMinutes —— 唔好自己加上面幾行；
                            ②「預計月底」＝ timeAccountMinutes + diffMinutes —— 唔好用逐行加總；
                            ③「其他調整」用減法（convertedMinutes − 換假 − 換回）—— 表面永遠夾得返，
                               驗收要逐 type 對數（MD §六 #24），唔可以靠畫面自洽。
                            ⚠️ 時薪（applicable=false）／未排更（unscheduled=true）→ 整組唔顯示，同應返卡一致 */}
                        {rh?.applicable && !rh.unscheduled && (
                          <div className="mt-2" style={{ background: '#fffbeb', borderRadius: 6, padding: '8px 10px', marginTop: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#92400e', textAlign: 'center', marginBottom: 6 }}>
                              本月預測
                            </div>
                            <ForecastRow label="上月結轉" value={summary?.carriedFrom ?? 0} />
                            <ForecastRow label="本月實收 OT" value={summary?.netOtThisMonth ?? 0} />
                            {(summary?.leaveConvertMinutes ?? 0) !== 0 && (
                              <ForecastRow label="OT 換假" sub={`${Math.abs(summary.leaveConvertMinutes / TIMEBANK_MINUTES_PER_DAY).toFixed(1)} 天`}
                                           value={summary.leaveConvertMinutes} highlight />
                            )}
                            {(summary?.leaveSwapBackMinutes ?? 0) !== 0 && (
                              <ForecastRow label="換假退回" sub={`${(summary.leaveSwapBackMinutes / TIMEBANK_MINUTES_PER_DAY).toFixed(1)} 天`}
                                           value={summary.leaveSwapBackMinutes} highlight />
                            )}
                            {/* ★ 拍板⑤⑥：其他調整一行唔展開；RESTDAY_GRANT 本來就唔喺 convertedMinutes（唔會出現） */}
                            <ForecastRow label="其他調整" sub="初始調整等"
                                         value={(summary?.convertedMinutes ?? 0)
                                                  - (summary?.leaveConvertMinutes ?? 0)
                                                  - (summary?.leaveSwapBackMinutes ?? 0)} />
                            <ForecastRow label="目前結餘" value={summary?.timeAccountMinutes ?? 0} divider bold />
                            {/* ★ 2026-08-31 拍板④：「預計 OT」→「應返時間OT」；settled 保留「（已入帳）」 */}
                            <ForecastRow label={rh?.settled ? '應返時間OT（已入帳）' : '應返時間OT'} sub="編更差額" value={rh?.diffMinutes ?? 0} />
                            <ForecastRow label="預計月底"
                                         value={(summary?.timeAccountMinutes ?? 0) + (rh?.diffMinutes ?? 0)}
                                         divider strong />
                          </div>
                        )}
                      </>
                    )
                  })()}

                  {/* ★ 摺疊明細 */}
                  <button
                    onClick={() => { setTbOpen(o => !o); if (!tbOpen) loadEntries() }}
                    className="w-full mt-2 text-xs py-1"
                  >
                    {tbOpen ? '收起明細 ▲' : '查看明細 ▼'}
                  </button>

                  {tbOpen && (
                    <div className="mt-2 border-t pt-2">
                      {!attDaysLoaded ? (
                        <div className="text-xs text-muted-foreground py-2 text-center">載入中…</div>
                      ) : (
                        <>
                          {/* ── 本月考勤（未入帳）*/}
                          <div className="text-[10px] text-muted-foreground font-semibold mt-2 mb-1">
                            ── 本月考勤（未入帳）
                          </div>
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <div className="text-center">
                              {/* ★ 2026-08-31 (cwm-earlyin)：otMinutes 唔含早返（由 TimeBankEntry 嚟）—— 用鐘口徑，
                                  令逐日加起身 = 呢個數 = 上面 c1 + c2 */}
                              <div className="text-base font-semibold text-emerald-600">
                                {summary?.otMinutesForAccount ?? summary?.otMinutes ?? 0}
                              </div>
                              <div className="text-[10px] text-muted-foreground">OT（含提早・午飯）</div>
                              <div className="text-[10px] text-emerald-600">
                                = {(summary?.otMinutes ?? 0) - (summary?.lunchOtMinutes ?? 0) + (summary?.earlyInOtMinutes ?? 0)}
                                {' + '}{summary?.lunchOtMinutes ?? 0}
                              </div>
                            </div>
                            <div className="text-center">
                              <div className="text-base font-semibold">{summary?.netLateMinutes ?? 0}</div>
                              <div className="text-[10px] text-muted-foreground">遲到（分鐘）</div>
                            </div>
                          </div>
                          {attDays.length === 0 ? (
                            <div className="text-xs text-muted-foreground py-2 text-center">本月未有考勤記錄</div>
                          ) : (
                            <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                              {attDays.map((d: any) => (
                                <div key={d.date}
                                  className="flex justify-between items-start py-1.5 border-b text-xs last:border-0">
                                  <span className="text-muted-foreground">{String(d.date).slice(5)}</span>
                                  <span className="flex flex-wrap gap-x-2 justify-end">
                                    {d.clockOutOt   ? <span style={{ color: '#059669' }}>OT {d.clockOutOt} 分</span> : null}
                                    {d.holidayOt    ? <span style={{ color: '#059669' }}>假期返工OT {d.holidayOt} 分</span> : null}
                                    {/* ★ 2026-08-31：早返 OT（TimeBankEntry EARLY_IN_OT）由引擎 merge 入同一日 */}
                                    {d.earlyInOt    ? <span style={{ color: '#059669' }}>提早上班OT {d.earlyInOt} 分</span> : null}
                                    {d.lunchOt      ? <span style={{ color: '#059669' }}>午飯OT {d.lunchOt} 分</span> : null}
                                    {d.lateMinutes  ? <span style={{ color: '#d97706' }}>遲到 {d.lateMinutes} 分</span> : null}
                                    {d.lunchLate    ? <span style={{ color: '#d97706' }}>午飯超時 {d.lunchLate} 分</span> : null}
                                    {d.earlyMinutes ? <span style={{ color: '#dc2626' }}>早退 {d.earlyMinutes} 分</span> : null}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  <div className="text-[10px] text-muted-foreground mt-1">
                    上面嘅結餘 = 累積結轉 ＋ 本月考勤 ＋ 調整項（初始／發休息日）
                    <br />· 逐日「遲到」係原始值，未扣補鐘
                  </div>
                </div>
              )
            })()}
          </CardContent>
        </Card>
      )}

      {/* Leave Balances */}
      {rh?.applicable && (
        rh.unscheduled ? (
          <div className="rounded-xl border p-3 mt-3">
            <div className="text-xs text-muted-foreground mb-2">本月工時</div>
            <div className="text-xs text-muted-foreground py-2 text-center">本月未排更</div>
          </div>
        ) : (
          <div className="rounded-xl border p-3 mt-3">
            <div className="text-xs text-muted-foreground mb-2">本月工時</div>
            <div className="flex justify-between text-sm py-1">
              <span className="text-muted-foreground">應返</span>
              <span>{rh.expectedMinutes} 分</span>
            </div>
            <div className="flex justify-between text-sm py-1">
              <span className="text-muted-foreground">已編班</span>
              <span>{rh.rosterMinutes} 分</span>
            </div>
            <div className="flex justify-between text-sm pt-2 border-t font-medium">
              <span>{rh.settled ? '編更差額（已入帳）' : '預計 OT'}</span>
              <span style={{ color: rh.diffMinutes > 0 ? '#059669' : rh.diffMinutes < 0 ? '#dc2626' : '#6b7280' }}>
                {rh.diffMinutes > 0 ? '+' : rh.diffMinutes < 0 ? '−' : ''}
                {Math.abs(rh.diffMinutes)} 分
              </span>
            </div>
            {rh.settled && (
              <div className="text-[10px] text-muted-foreground mt-1">
                已出糧鎖定；之後改更表唔會影響呢個數
              </div>
            )}
            <div className="text-[10px] text-muted-foreground mt-2">
              {rh.settled ? '已出糧，數字已入時間帳戶' : '更表未定，出糧時以實際為準'}
            </div>
          </div>
        )
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
