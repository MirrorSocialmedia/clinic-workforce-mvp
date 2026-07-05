'use client'

import { useEffect, useState, useCallback } from 'react'

export default function MySchedulePage() {
  const [shifts, setShifts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [view, setView] = useState<'week' | 'month'>('month')

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

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const goToMonth = (delta: number) => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
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

  // Get days in month
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

  // Day of week for first day
  const firstDay = new Date(y, m - 1, 1).getDay()

  if (loading) return <div style={{ padding: 24 }}>載入中...</div>

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', marginBottom: 24 }}>📅 我的班表</h1>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => goToMonth(-1)}>◀</button>
            <span style={{ fontSize: 16, fontWeight: 600 }}>{month}</span>
            <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={() => goToMonth(1)}>▶</button>
          </div>
          <span style={{ fontSize: 13, color: '#888' }}>{shifts.length} 個班次</span>
        </div>

        {/* Calendar grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, background: '#eee', border: '1px solid #eee' }}>
          {['日', '一', '二', '三', '四', '五', '六'].map(d => (
            <div key={d} style={{ padding: 8, textAlign: 'center', fontSize: 12, fontWeight: 600, background: '#f5f5f5', color: '#888' }}>
              {d}
            </div>
          ))}

          {/* Empty cells before first day */}
          {Array.from({ length: firstDay }).map((_, i) => (
            <div key={`empty-${i}`} style={{ padding: 8, minHeight: 60, background: 'white' }} />
          ))}

          {/* Day cells */}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1
            const dayShiftsList = dayShifts[day] || []
            const isToday = day === new Date().getDate() && m === new Date().getMonth() + 1 && y === new Date().getFullYear()
            return (
              <div key={day} style={{
                padding: 6,
                minHeight: 60,
                background: isToday ? '#e3f2fd' : 'white',
                border: isToday ? '2px solid #1565c0' : '1px solid #f0f0f0',
              }}>
                <div style={{ fontSize: 13, fontWeight: isToday ? 700 : 400, marginBottom: 4 }}>
                  {day}
                </div>
                {dayShiftsList.map(s => (
                  <div key={s.id} style={{
                    fontSize: 10,
                    padding: '2px 4px',
                    borderRadius: 3,
                    marginBottom: 2,
                    background: `${getStatusColor(s.status)}20`,
                    color: getStatusColor(s.status),
                    cursor: 'default',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }} title={`${s.clinic?.name} ${new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}-${new Date(s.endTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}`}>
                    {new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                    {' '}{s.clinic?.name?.substring(0, 3)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      {/* Shift list */}
      {shifts.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>班次詳情</h2>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>時間</th>
                <th>診所</th>
                <th>角色</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map(s => (
                <tr key={s.id}>
                  <td>{new Date(s.startTime).toLocaleDateString('zh-HK')}</td>
                  <td>
                    {new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                    {' - '}
                    {new Date(s.endTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td>{s.clinic?.name || '-'}</td>
                  <td>{s.role || '-'}</td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      background: `${getStatusColor(s.status)}20`,
                      color: getStatusColor(s.status),
                    }}>
                      {getStatusLabel(s.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
