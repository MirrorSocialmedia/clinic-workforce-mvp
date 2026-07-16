'use client'

import { useEffect, useState, useCallback } from 'react'
import { fmtTime, toHKDateStr, addDays, hkDayOfWeek } from '@/lib/hk-date'

/* ─────────── Company Overview Table (read-only) ─────────── */
function CompanyOverviewTable({
  weekStart,
  currentUserId,
}: {
  weekStart: string
  currentUserId: string
}) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!weekStart) return
    setLoading(true)
    fetch(`/api/my/company-overview?weekStart=${weekStart}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.resolve(null))
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [weekStart])

  if (loading) return <div className="text-xs text-muted-foreground py-2">載入公司總覽...</div>
  if (!data || !data.employees?.length) return <div className="text-xs text-muted-foreground py-2">無公司總覽資料</div>

  const { days, employees } = data

  return (
    <div>
      <div className="overflow-x-auto -mx-2" style={{ WebkitOverflowScrolling: 'touch' }}>
        <table style={{
          borderCollapse: 'separate', borderSpacing: 0,
          tableLayout: 'fixed',
          fontSize: 11, minWidth: 724, width: '100%',
        }}>
          <colgroup>
            <col style={{ width: 80 }} />
            {days.map((d: string) => <col key={d} style={{ width: 92 }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb', position: 'sticky', left: 0, background: '#f9fafb', zIndex: 2, fontWeight: 600 }}>員工</th>
              {days.map((d: string, i: number) => {
                const dayNames = ['日', '一', '二', '三', '四', '五', '六']
                const dayOfWeek = new Date(d + 'T00:00:00+08:00').getDay()
                return (
                  <th key={i} style={{ textAlign: 'center', padding: '4px 4px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>
                    <div style={{ fontWeight: 600 }}>{d.slice(5)}</div>
                    <div style={{ color: '#888', fontSize: 10 }}>{dayNames[dayOfWeek]}</div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map((emp: any) => {
              const isMe = emp.userId === currentUserId
              const shiftsByDay = emp.shifts?.reduce((acc: Record<string, any>, s: any) => { acc[s.date] = s; return acc }, {}) || {}
              return (
                <tr key={emp.id} style={{ background: isMe ? '#f0fdfa' : 'transparent' }}>
                  <td style={{
                    position: 'sticky', left: 0, zIndex: 1,
                    background: isMe ? '#f0fdfa' : '#fff',
                    padding: '4px 6px', fontWeight: isMe ? 700 : 500,
                    borderBottom: '1px solid #f3f4f6',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{emp.name}</td>
                  {days.map((d: string) => {
                    const ds = shiftsByDay[d]
                    return (
                      <td key={d} style={{ padding: '3px 3px', verticalAlign: 'top', borderBottom: '1px solid #f3f4f6' }}>
                        {ds && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {ds.shifts?.map((s: any) => (
                              <span
                                key={s.id}
                                style={{
                                  display: 'inline-block', maxWidth: 84, overflow: 'hidden',
                                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'top',
                                  background: '#e0f2fe', color: '#0369a1',
                                  borderRadius: 4, padding: '1px 4px', fontSize: 10,
                                }}
                                title={`${s.clinicName} ${s.startTime}-${s.endTime}`}
                              >
                                {s.clinicName} {s.startTime}-{s.endTime}
                              </span>
                            ))}
                            {ds.leaves?.map((l: string, li: number) => (
                              <span
                                key={li}
                                style={{
                                  display: 'inline-block',
                                  background: '#fef3c7', color: '#92400e',
                                  borderRadius: 4, padding: '1px 4px', fontSize: 10,
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                🏖 {l}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────── Main Page ─────────── */
export default function MySchedulePage() {
  const [shifts, setShifts] = useState<any[]>([])
  const [coworkerShifts, setCoworkerShifts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [includeCoworkers, setIncludeCoworkers] = useState(false)
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`  // tz-ok: client-side browser
  })

  // Current user ID for highlighting own row in overview
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  // Week start for company overview: defaults to "this week" Monday (HK perspective)
  const mondayOf = (d: Date) => {
    const dow = hkDayOfWeek(d)
    const offset = dow === 0 ? -6 : 1 - dow
    const base = toHKDateStr(d)
    return addDays(base, offset)
  }
  const [ovWeekStart, setOvWeekStart] = useState(() => mondayOf(new Date()))

  // Fetch current user
  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.user?.id) setCurrentUserId(d.user.id) })
      .catch(() => {})
  }, [])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const monthStart = new Date(`${month}-01`)
      const monthEnd = new Date(monthStart)
      monthEnd.setMonth(monthEnd.getMonth() + 1)  // tz-ok: client-side browser
      const url = includeCoworkers
        ? `/api/my/schedule?from=${monthStart.toISOString()}&to=${monthEnd.toISOString()}&includeCoworkers=true`
        : `/api/my/schedule?from=${monthStart.toISOString()}&to=${monthEnd.toISOString()}`
      const res = await fetch(url, { credentials: 'include' })
      const data = await res.json()
      if (includeCoworkers) {
        setShifts(data.myShifts || [])
        setCoworkerShifts(data.coworkerShifts || [])
      } else {
        setShifts(data.shifts || [])
        setCoworkerShifts([])
      }
    } catch (err) {
      console.error('Fetch schedule error:', err)
    } finally {
      setLoading(false)
    }
  }, [month, includeCoworkers])

  useEffect(() => { fetchData() }, [fetchData])

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
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-4">📅 我的班表</h1>

      {/* ─── Company Overview (read-only) ─── */}
      <div className="card mb-3" style={{ overflow: 'visible' }}>
        <div className="flex items-center justify-between mb-2" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-700">🏢 公司全局總覽</span>
            <button className="text-base hover:text-gray-900" onClick={() => setOvWeekStart(w => addDays(w, -7))} title="上一週">‹</button>
            <span className="text-xs text-muted-foreground">{ovWeekStart} 起</span>
            <button className="text-base hover:text-gray-900" onClick={() => setOvWeekStart(w => addDays(w, 7))} title="下一週">›</button>
            <button className="text-xs underline text-muted-foreground hover:text-gray-700" onClick={() => setOvWeekStart(mondayOf(new Date()))}>本週</button>
          </div>
          <span className="text-xs text-muted-foreground">唯讀</span>
        </div>
        {currentUserId && (
          <CompanyOverviewTable weekStart={ovWeekStart} currentUserId={currentUserId} />
        )}
      </div>

      {/* ─── Personal Calendar ─── */}
      <div className="card mb-3">
        <div className="flex items-center justify-between mb-3" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="flex items-center gap-3">
            <button
              className="btn btn-sm"
              style={{ background: '#f0f0f0' }}
              onClick={() => goToMonth(-1)}
            >
              ◀
            </button>
            <span className="text-base font-semibold">{month}</span>
            <button
              className="btn btn-sm"
              style={{ background: '#f0f0f0' }}
              onClick={() => goToMonth(1)}
            >
              ▶
            </button>
          </div>
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
                  {dayShiftsList.map(s => (
                    <div
                      key={s.id}
                      className="text-[10px] p-0.5 rounded mb-0.5 truncate"
                      style={{
                        background: `${getStatusColor(s.status)}20`,
                        color: getStatusColor(s.status),
                      }}
                      title={`${s.clinic?.name} ${fmtTime(s.startTime)}-${fmtTime(s.endTime)}`}
                    >
                      {fmtTime(s.startTime)}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Shift cards (mobile-friendly) */}
      {Object.keys(shiftsByDate).length > 0 && (
        <div className="card">
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
                          {s.clinicName || s.clinic?.name || '-'}
                          {s.role ? ` · ${s.role}` : ''}
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
      )}
    </div>
  )
}
