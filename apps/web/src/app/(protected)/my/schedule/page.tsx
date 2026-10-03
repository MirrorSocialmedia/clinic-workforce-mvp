'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtTime, toHKDateStr } from '@/lib/hk-date'
import { useLatestRequest } from '@/lib/use-latest-request'
import { useLiveRefresh } from '@/lib/live-refresh'
import MonthOverviewTable, { MyLeaveBalanceStrip } from '@/components/my-month-overview'

// ★ cwm-mobilemonth-20261003：「整月總覽」（同電腦版月視圖）／「我的日曆」切換，記住上次揀嘅（純本機方便）
type ScheduleView = 'month' | 'mine'
const VIEW_KEY = 'my-schedule-view'
function readView(): ScheduleView {
  try { return localStorage.getItem(VIEW_KEY) === 'mine' ? 'mine' : 'month' } catch { return 'month' }
}

/* ─────────── Main Page ─────────── */
export default function MySchedulePage() {
  const [shifts, setShifts] = useState<any[]>([])
  const [coworkerShifts, setCoworkerShifts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [includeCoworkers, setIncludeCoworkers] = useState(false)
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`  // tz-ok: client-side browser
  })

  // Current user ID for highlighting own row in overview
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  const [view, setViewState] = useState<ScheduleView>('month')
  useEffect(() => { setViewState(readView()) }, [])
  const setView = (v: ScheduleView) => {
    setViewState(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* 私密模式等 —— 唔記都照用 */ }
  }

  // Fetch current user
  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.user?.id) setCurrentUserId(d.user.id) })
      .catch(() => {})
  }, [])

  const schedReq = useLatestRequest()
  const fetchData = useCallback(async (opts?: { silent?: boolean }) => {
    const { signal, isLatest } = schedReq()
    // ★ F-4：live refresh 唔好成頁變「載入中」（捲動彈返頂、公司總覽 remount 再拉一次）
    if (!opts?.silent) setLoading(true)
    try {
      const monthStart = new Date(`${month}-01`)
      const monthEnd = new Date(monthStart)
      monthEnd.setMonth(monthEnd.getMonth() + 1)  // tz-ok: client-side browser
      // ★ 2026-08-04：後端 hkDateStart() 期望 'YYYY-MM-DD' 純日期字串
      //   toISOString() 會拼成 '…000ZT00:00:00+08:00' → Invalid Date → Prisma 500
      //   且 toISOString() 轉 UTC，HK 8/1 00:00 會變 7/31 —— 差一日
      const fromStr = toHKDateStr(monthStart)
      const toStr = toHKDateStr(monthEnd)
      const url = includeCoworkers
        ? `/api/my/schedule?from=${fromStr}&to=${toStr}&includeCoworkers=true`
        : `/api/my/schedule?from=${fromStr}&to=${toStr}`
      const res = await fetch(url, { credentials: 'include', signal })
      const data = await res.json().catch(() => null)
      if (!isLatest()) return
      if (!res.ok || !data) throw new Error(data?.error || `HTTP ${res.status}`)   // ★ F-4：失敗唔好清空現有班表
      if (includeCoworkers) {
        setShifts(data.myShifts || [])
        setCoworkerShifts(data.coworkerShifts || [])
        setCompanyId(data.companyId ?? null)
      } else {
        setShifts(data.shifts || [])
        setCoworkerShifts([])
        setCompanyId(data.companyId ?? null)
      }
    } catch (err) {
      if ((err as any)?.name === 'AbortError' || !isLatest()) return
      console.error('Fetch schedule error:', err)
    } finally {
      if (isLatest()) setLoading(false)
    }
  }, [month, includeCoworkers, schedReq])

  useEffect(() => { fetchData() }, [fetchData])

  // ★ cwm-consistency Stage 5.2：live refresh（120s + 其他 tab 排班/假期 mutation 即 refetch）
  useLiveRefresh(() => fetchData({ silent: true }), ['schedule', 'leave'], { intervalMs: 120_000 })

  // ★ 2026-08-04: Fetch schedule notes (read-only for employee)
  useEffect(() => {
    if (!companyId || shifts.length === 0) { setNotes({}); return }
    const dates = shifts.map(s => s.date || toHKDateStr(new Date(s.startTime))).sort()
    const start = dates[0], end = dates[dates.length - 1]
    if (!start || !end) return
    fetch(`/api/schedule-notes?companyId=${companyId}&startDate=${start}&endDate=${end}`,
      { credentials: 'include', cache: 'no-store' })
      .then(r => r.ok ? r.json() : { notes: [] })
      .then(d => {
        const m: Record<string, string> = {}
        ;(d.notes || []).forEach((n: any) => { m[n.date] = n.text })
        setNotes(m)
      })
      .catch(() => {})
  }, [companyId, shifts])

  const goToMonth = (delta: number) => {
    const parts = month.split('-').map(Number)
    const d = new Date(parts[0], parts[1] - 1 + delta, 1)
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)  // tz-ok: client-side browser
  }

  const getStatusLabel = (status: string) => {
    const map: Record<string, string> = { CONFIRMED: '已確認', DRAFT: '草稿', CANCELLED: '已取消', COMPLETED: '已完成' }
    return map[status] || status
  }

  const getStatusColor = (status: string) => {
    const map: Record<string, string> = { CONFIRMED: '#2e7d32', DRAFT: '#e65100', CANCELLED: '#888', COMPLETED: '#1565c0' }
    return map[status] || '#888'
  }

  // Group shifts by date for card display
  const shiftsByDate: Record<string, any[]> = {}
  shifts.forEach(s => {
    const dateKey = s.date || toHKDateStr(new Date(s.startTime))
    if (!shiftsByDate[dateKey]) shiftsByDate[dateKey] = []
    shiftsByDate[dateKey].push(s)
  })

  // Group coworker shifts by date
  const coworkersByDate: Record<string, any[]> = {}
  coworkerShifts.forEach(s => {
    const dateKey = s.date
    if (!coworkersByDate[dateKey]) coworkersByDate[dateKey] = []
    coworkersByDate[dateKey].push(s)
  })

  // Also keep calendar data
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()  // tz-ok: client-side browser
  const dayShifts: Record<number, any[]> = {}
  shifts.forEach(s => {
    const d = s.date || toHKDateStr(new Date(s.startTime))
    const [shiftY, shiftM] = d.split('-').map(Number)
    if (shiftY === y && shiftM === m) {
      const day = parseInt(shiftM === m ? d.split('-')[2] : '0')
      if (!dayShifts[day]) dayShifts[day] = []
      dayShifts[day].push(s)
    }
  })
  const firstDay = new Date(y, m - 1, 1).getDay()  // tz-ok: client-side browser

  if (loading) return <div className="flex justify-center items-center py-12 text-gray-400">載入中...</div>

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-3">📅 我的班表</h1>

      {/* ─── 月份 + 檢視切換 ─── */}
      <div className="flex items-center justify-between mb-2">
        <button className="btn btn-sm" style={{ background: '#f0f0f0', minWidth: 44, minHeight: 40 }} onClick={() => goToMonth(-1)} aria-label="上個月">◀</button>
        <span className="text-base font-semibold">{month.replace('-', ' 年 ')} 月</span>
        <button className="btn btn-sm" style={{ background: '#f0f0f0', minWidth: 44, minHeight: 40 }} onClick={() => goToMonth(1)} aria-label="下個月">▶</button>
      </div>
      <div style={{ display: 'flex', border: '1px solid #c3cbd4', borderRadius: 8, overflow: 'hidden', marginBottom: 10 }}>
        {([['month', '整月總覽'], ['mine', '我的日曆']] as [ScheduleView, string][]).map(([v, label]) => (
          <button key={v} type="button" onClick={() => setView(v)} style={{
            flex: 1, height: 40, border: 0, fontSize: 14,
            background: view === v ? '#1F4E79' : '#fff', color: view === v ? '#fff' : '#1f2933',
          }}>{label}</button>
        ))}
      </div>

      {view === 'month' && currentUserId && (
        <div className="mb-3">
          <MonthOverviewTable month={month} currentUserId={currentUserId} />
          <MyLeaveBalanceStrip />
        </div>
      )}

      {view === 'mine' && (<>
      {/* ─── Personal Calendar ─── */}
      <div className="card mb-3">
        <div className="flex items-center justify-between mb-3" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Coworker toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="text-xs text-gray-500" style={{ fontSize: 12 }}>{includeCoworkers ? '看全店' : '只看我的'}</span>
              <button
                onClick={() => setIncludeCoworkers(!includeCoworkers)}
                style={{
                  width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                  background: includeCoworkers ? '#0d6efd' : '#ccc', position: 'relative', transition: 'background 0.2s',
                }}
                title={includeCoworkers ? '切換為只看我的' : '切換為看全店同事'}
              >
                <span style={{
                  position: 'absolute', top: 2, width: 18, height: 18, borderRadius: '50%',
                  background: 'white', transition: 'left 0.2s',
                  left: includeCoworkers ? 20 : 2,
                }} />
              </button>
            </div>
            <span className="text-xs text-gray-400">{shifts.length} 個班次</span>
          </div>
        </div>

        {/* Calendar grid - scrollable on mobile */}
        <div className="overflow-x-auto -mx-2">
          <div
            className="grid grid-cols-7 gap-px bg-gray-200 dark:bg-gray-700 border border-gray-200 dark:border-gray-700"
            style={{ minWidth: '280px' }}
          >
            {['日', '一', '二', '三', '四', '五', '六'].map(d => (
              <div key={d} className="p-2 text-center text-xs font-semibold text-gray-400 bg-gray-50 dark:bg-gray-800">
                {d}
              </div>
            ))}

            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`empty-${i}`} className="p-1 min-h-[48px] bg-white dark:bg-gray-900" />
            ))}

            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1
              const dayShiftsList = dayShifts[day] || []
              const isToday =
                day === new Date().getDate() &&  // tz-ok: client-side browser
                m === new Date().getMonth() + 1 &&  // tz-ok: client-side browser
                y === new Date().getFullYear()  // tz-ok: client-side browser
              return (
                <div
                  key={day}
                  className="p-1 min-h-[48px] bg-white dark:bg-gray-900"
                  style={{
                    border: isToday ? '2px solid #0d7377' : '1px solid transparent',
                  }}
                >
                  <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">
                    {day}
                  </div>
                  {dayShiftsList.map(s => {
                    const single = dayShiftsList.length === 1
                    const isTransfer = !!s.secondaryClinicName
                    // ★ 手機可讀性：月曆格只顯示「地點簡稱 + 更次簡稱」，唔再顯示時間（時間喺「班次詳情」睇）
                    //   一更：地點 12px 粗 / 更次 11px；多更：11px / 10px，避免撐爆格仔
                    const placeSize = single ? 12 : 11
                    const shiftSize = single ? 11 : 10
                    return (
                      <div key={s.id}
                        className="p-0.5 rounded mb-0.5"
                        style={{
                          background: isTransfer ? '#fef3c7' : `${getStatusColor(s.status)}20`,
                          color: isTransfer ? '#92400e' : getStatusColor(s.status),
                          lineHeight: 1.2,
                          overflow: 'hidden',
                        }}
                        title={[
                          s.clinicName,
                          isTransfer ? `→ ${s.secondaryClinicName}` : '',
                          s.templateName,
                          `${fmtTime(s.startTime)}-${fmtTime(s.endTime)}`,
                        ].filter(Boolean).join(' ')}
                      >
                        <div className="truncate" style={{ fontSize: placeSize, fontWeight: 600 }}>
                          {isTransfer
                            ? <>{s.clinicShortName}<span style={{ margin: '0 1px' }}>→</span>{s.secondaryClinicShortName}</>
                            : s.clinicShortName}
                        </div>
                        {s.templateShortName && (
                          <div className="truncate" style={{ fontSize: shiftSize }}>
                            {s.templateShortName}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Shift cards (mobile-friendly) */}
      {Object.keys(shiftsByDate).length > 0 ? (
        <div className="card mb-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">班次詳情</h2>
          <div className="space-y-2">
            {Object.entries(shiftsByDate)
              .sort(([a], [b]) => b.localeCompare(a))
              .map(([date, dayShiftsList]) => {
                const coworkers = coworkersByDate[date] || []
                return (
                <div key={date} className="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50">
                  <div className="font-semibold text-sm text-gray-900 dark:text-white mb-2">
                    {date}
                  </div>
                  {notes[date] && (
                    <div style={{
                      fontSize: 11, color: '#b45309', background: '#fffbeb',
                      borderRadius: 4, padding: '3px 8px', marginTop: 4,
                    }}>
                      📌 {notes[date]}
                    </div>
                  )}
                  {dayShiftsList.map(s => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between py-2 border-t border-gray-100 dark:border-gray-600 first:border-0 first:pt-0"
                    >
                      <div>
                        <div className="text-sm text-gray-800 dark:text-gray-200">
                          🟦 {s.templateName || ''}
                          {s.startTime ? ` ${fmtTime(s.startTime)}-${fmtTime(s.endTime)}` : ''}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {s.secondaryClinicName
                            ? <>
                                {s.clinicShortName || s.clinicName || s.clinic?.name || '-'}
                                <span className="mx-0.5 text-amber-600 font-medium">→</span>
                                {s.secondaryClinicShortName || s.secondaryClinicName}
                              </>
                            : (s.clinicShortName || s.clinicName || s.clinic?.name || '-')}
                          {s.role ? ` · ${s.role}` : ''}
                          {s.secondaryClinicName && (
                            <span className="text-amber-600 ml-1">⚠️ 調鋪</span>
                          )}
                        </div>
                      </div>
                      <span
                        className="text-xs px-2 py-0.5 rounded ml-2 flex-shrink-0"
                        style={{
                          background: `${getStatusColor(s.status)}20`,
                          color: getStatusColor(s.status),
                        }}
                      >
                        {getStatusLabel(s.status)}
                      </span>
                    </div>
                  ))}
                  {/* Coworkers */}
                  {includeCoworkers && coworkers.length > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #ddd' }}>
                      <div className="text-xs font-medium text-gray-500 mb-1">同班同事：</div>
                      {coworkers.map(c => (
                        <div key={c.id} className="text-xs text-gray-600 dark:text-gray-300 py-0.5 pl-2" style={{ borderLeft: '2px solid #e5e7eb' }}>
                          {c.employeeName} {c.templateName && `(${c.templateName})`} {fmtTime(c.startTime)}-{fmtTime(c.endTime)} @ {c.clinicName}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )})}
          </div>
        </div>
      ) : (
        <div className="card mb-3">
          <div className="text-center py-12 text-sm text-muted-foreground">
            本月未有排班
          </div>
        </div>
      )}

      </>)}
    </div>
  )
}
