'use client'

import { useEffect, useState, useCallback, Fragment } from 'react'
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

  // ★ cwm-payrollcols-20260918 C2/C3：逐月帳本 —— lazy load on expand；
  //   reconciled / currentBalance 全部由 server 算好（C4：前端唔好自己算）
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [ledger, setLedger] = useState<any | null>(null)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null)
  const loadLedger = useCallback(async () => {
    if (ledger || ledgerLoading) return
    setLedgerLoading(true)
    try {
      const r = await fetch('/api/my/timebank-ledger', { credentials: 'include', cache: 'no-store' })
      if (r.ok) setLedger(await r.json())
    } catch { /* 載入失敗：下次撳再試 */ } finally {
      setLedgerLoading(false)
    }
  }, [ledger, ledgerLoading])

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
    <div className="p-4 space-y-4 pb-[calc(72px+env(safe-area-inset-bottom))] md:pb-4" style={{ maxWidth: '640px' }}>
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
      {/* ★ cwm-attexempt-20260914 D：免考勤員工（會計）時間帳戶卡整張唔出
          —— 理論上冇更冇打卡所有數自然 0，但出一張全 0 卡係噪音。 */}
      {summary && !summary.attendanceExempt && summary.timeAccountMinutes != null && (
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
                  {/* ★ 拍板③：大字用【目前結餘】而且一定要標明 ——
                      下面條式尾係「月底結餘」，兩個數差住編更差額。
                      ⚠️ 目前結餘先係 DB 真實值；編更差額要等確認計糧先寫入 TimeBankEntry，
                         員工換假時系統係按【目前結餘】算。 */}
                  <div className="text-sm text-muted-foreground">目前結餘</div>
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
                  {/* ★ cwm-attexempt-tblayout-20260914 G3：OT 四格橫排剷走，併入下面「本月預測」直式
                      （毛 OT／遲到早退補鐘拆做兩行 —— 欄位組合由 G1 實測決定，2026-09-14）。 */}
                  {(() => {
                    return (
                      <>

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
                            {/* ★ cwm-attexempt-tblayout-20260914 G3（拍板②）：OT 用【毛額】、遲到補鐘獨立一行 —— 同老細張 Excel 口徑一致。
                                欄位組合由 G1 實測決定（2026-09-14 dev 實測）：
                                毛 = otMinutesForAccount（= otMinutes + earlyInOtMinutes；lunchOt 已含喺 otMinutes 入面，唔好再加）；
                                負 = makeup（late+early+absent）+ netLate + netEarly。
                                硬驗收：兩行加返 === netOtThisMonth（engine :1960 定義）。 */}
                            <ForecastRow label="本月 OT" sub="含提早・午飯" value={summary?.otMinutesForAccount ?? 0} />
                            <ForecastRow label="遲到／早退／補鐘"
                                         sub={(summary?.makeupMinutes ?? 0) > 0
                                             ? `含補鐘 ${summary.makeupMinutes} 分${(summary?.makeupAbsentMinutes ?? 0) > 0 ? `（缺勤 ${summary.makeupAbsentMinutes}）` : ''}`
                                             : undefined}
                                         value={-((summary?.makeupMinutes ?? 0) + (summary?.netLateMinutes ?? 0) + (summary?.netEarlyMinutes ?? 0))} />
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
                            {/* ★ cwm-attexempt-tblayout-20260914 G4（拍板②）：「已編更 / 應返」縮做子項 ——
                                放喺加減式入面會令人以為要加 8,610。實際只有【差額】入賬。
                                底部原「本月工時」block 嘅獨有註（已出糧鎖定／以實際為準）搬咗落嚟。 */}
                            <ForecastRow label={rh?.settled ? '編更差額（已入帳）' : '編更差額'}
                                         sub={`已編更 ${rh?.rosterMinutes ?? 0} · 應返 ${rh?.expectedMinutes ?? 0}`}
                                         value={rh?.diffMinutes ?? 0} />
                            <div style={{ fontSize: 9, color: '#9ca3af', padding: '0 4px' }}>
                              {rh?.settled ? '已出糧鎖定；之後改更表唔會影響呢個數' : '更表未定，出糧時以實際為準'}
                            </div>
                            <ForecastRow label="月底結餘"
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

      {/* ★ cwm-payrollcols-20260918 C2/C3：逐月帳本（可摺疊，預設收起）—— 同一條件先出（冇時間帳戶就唔出）
          五欄（手機）：月份／期初／OT／扣減／期末 ＋ 狀態圖示；「調整」併入 OT/扣減，逐日明細分開列。
          C4：頂部大字＝最後一個月期末；reconciled 橫幅由 API 回，唔好前端自己算。 */}
      {summary && !summary.attendanceExempt && summary.timeAccountMinutes != null && (
        <Card>
          <CardContent className="pt-4">
            <button
              onClick={() => { setLedgerOpen(o => !o); if (!ledgerOpen) loadLedger() }}
              className="w-full text-xs py-1 text-blue-600"
            >
              {ledgerOpen ? '▲ 逐月帳本' : '▼ 逐月帳本'}
            </button>

            {ledgerOpen && (
              <div className="mt-2">
                {ledgerLoading || !ledger ? (
                  <div className="text-xs text-muted-foreground py-2 text-center">載入中…</div>
                ) : ledger.notApplicable ? (
                  <div className="text-xs text-muted-foreground py-2 text-center">時薪／兼職不設時間帳戶</div>
                ) : (
                  <>
                    {/* C4：頂部大字「目前結餘」同帳本最後一個月「期末」必須一樣 */}
                    <div className="flex items-baseline gap-2 mb-2">
                      <span className="text-xs text-muted-foreground">目前結餘</span>
                      <span className="text-xl font-bold">{ledger.currentBalance ?? 0} 分</span>
                      {!ledger.balanceMatchesLatestClosing && (
                        <span className="text-[10px] text-amber-600">⚠️ 同帳本最新月期末唔符，請報告</span>
                      )}
                    </div>

                    {/* C4：「帳本已對數」橫幅 —— 由 API 嘅 reconciled 決定 */}
                    {ledger.reconciled ? (
                      <div className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 mb-2">
                        ✅ 帳本已對數：{ledger.months?.length ?? 6} 個月逐月加得埋，月與月接得返
                      </div>
                    ) : (
                      <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 mb-2">
                        ⚠️ 帳本有唔加得埋／接唔返嘅月：
                        {(ledger.months as any[]).filter(m => !m.reconciles).map(m => m.periodMonth).filter(Boolean).join('、')}
                        {ledger.chainBreaks?.length > 0 &&
                          `；月鏈斷點：${ledger.chainBreaks.map((b: any) => `${b.from}→${b.to}`).join('、')}`}
                      </div>
                    )}

                    {/* 五欄表（手機）：月份／期初／OT／扣減／期末＋狀態圖示 */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="text-left py-1 pr-1 font-normal">月份</th>
                            <th className="text-right py-1 px-1 font-normal">期初</th>
                            <th className="text-right py-1 px-1 font-normal">OT</th>
                            <th className="text-right py-1 px-1 font-normal">扣減</th>
                            <th className="text-right py-1 px-1 font-normal">期末</th>
                            <th className="py-1 pl-1 w-6"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {(ledger.months as any[]).map(m => {
                            const otAdd = m.lines.reduce((s: number, l: any) => s + (l.minutes > 0 ? l.minutes : 0), 0)
                            const ded = m.lines.reduce((s: number, l: any) => s + (l.minutes < 0 ? l.minutes : 0), 0)
                            const expanded = expandedMonth === m.periodMonth
                            return (
                              <Fragment key={m.periodMonth}>
                                <tr
                                  onClick={() => setExpandedMonth(expanded ? null : m.periodMonth)}
                                  className="cursor-pointer border-t border-gray-100"
                                >
                                  <td className="py-1.5 pr-1">{m.periodMonth}</td>
                                  <td className="py-1.5 px-1 text-right">{m.opening}</td>
                                  <td className="py-1.5 px-1 text-right" style={{ color: otAdd ? '#059669' : undefined }}>{otAdd > 0 ? `+${otAdd}` : otAdd}</td>
                                  <td className="py-1.5 px-1 text-right" style={{ color: ded ? '#dc2626' : undefined }}>{ded}</td>
                                  <td className="py-1.5 px-1 text-right font-semibold">{m.closing}</td>
                                  <td className="py-1.5 pl-1" title={m.frozen ? '已確認計糧' : '未確認計糧'}>
                                    {m.frozen ? '✓' : '⏳'}
                                  </td>
                                </tr>
                                {expanded && (
                                  <tr>
                                    <td colSpan={6} className="pb-2 pl-3">
                                      {m.lines.length === 0 ? (
                                        <div className="text-[11px] text-muted-foreground">本月無入帳記錄</div>
                                      ) : (
                                        m.lines.map((l: any, i: number) => (
                                          <div key={`${m.periodMonth}-${i}`} className="flex justify-between text-[11px] py-0.5">
                                            <span className="text-muted-foreground">
                                              {String(l.date).slice(5)}　{l.label}{l.note ? `（${l.note}）` : ''}
                                            </span>
                                            <span style={{ color: l.minutes > 0 ? '#059669' : l.minutes < 0 ? '#dc2626' : '#6b7280' }}>
                                              {l.minutes > 0 ? `+${l.minutes}` : l.minutes}
                                            </span>
                                          </div>
                                        ))
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      撳一行展開逐日明細；✓ 已確認計糧／⏳ 未確認（出糧後凍結）
                    </div>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Leave Balances */}
      {/* ★ cwm-attexempt-tblayout-20260914 G5：原「本月工時」block 剷走 —— 已編更／應返／差額同「編更差額」子行完全重複，
          獨有文字（已出糧鎖定／以實際為準）已搬去子行旁邊。未排更提示保留一行。 */}
      {rh?.applicable && rh.unscheduled && (
        <div className="rounded-xl border p-3 mt-3">
          <div className="text-xs text-muted-foreground py-1 text-center">本月未排更</div>
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
