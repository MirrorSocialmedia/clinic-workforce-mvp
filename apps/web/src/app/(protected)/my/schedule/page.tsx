'use client'

import { useEffect, useState, useCallback } from 'react'

export default function MySchedulePage() {
  const [shifts, setShifts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const monthStart = new Date(`${month}-01`)
      const monthEnd = new Date(monthStart)
      monthEnd.setMonth(monthEnd.getMonth() + 1)
      const res = await fetch(
        `/api/my/schedule?from=${monthStart.toISOString()}&to=${monthEnd.toISOString()}`,
        { credentials: 'include' }
      )
      const data = await res.json()
      setShifts(data.shifts || [])
    } catch (err) {
      console.error('Fetch schedule error:', err)
    } finally {
      setLoading(false)
    }
  }, [month])

  useEffect(() => { fetchData() }, [fetchData])

  const goToMonth = (delta: number) => {
    const parts = month.split('-').map(Number)
    const d = new Date(parts[0], parts[1] - 1 + delta, 1)
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
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
    const dateKey = new Date(s.startTime).toLocaleDateString('zh-HK')
    if (!shiftsByDate[dateKey]) shiftsByDate[dateKey] = []
    shiftsByDate[dateKey].push(s)
  })

  // Also keep calendar data
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const dayShifts: Record<number, any[]> = {}
  shifts.forEach(s => {
    const shiftDate = new Date(s.startTime)
    if (shiftDate.getFullYear() === y && shiftDate.getMonth() === m - 1) {
      const day = shiftDate.getDate()
      if (!dayShifts[day]) dayShifts[day] = []
      dayShifts[day].push(s)
    }
  })
  const firstDay = new Date(y, m - 1, 1).getDay()

  if (loading) return <div className="flex justify-center items-center py-12 text-gray-400">載入中...</div>

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-4">📅 我的班表</h1>

      <div className="card mb-3">
        <div className="flex items-center justify-between mb-3">
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
          <span className="text-xs text-gray-400">{shifts.length} 個班次</span>
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
                day === new Date().getDate() &&
                m === new Date().getMonth() + 1 &&
                y === new Date().getFullYear()
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
                      title={`${s.clinic?.name} ${new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}-${new Date(s.endTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}`}
                    >
                      {new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
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
              .map(([date, dayShiftsList]) => (
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
                          {new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                          {' - '}
                          {new Date(s.endTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {s.clinic?.name || '-'}
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
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
