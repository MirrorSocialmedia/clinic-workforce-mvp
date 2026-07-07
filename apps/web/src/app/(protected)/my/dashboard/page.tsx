'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

export default function MyDashboardPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<any>(null)
  const [schedule, setSchedule] = useState<any[]>([])
  const [leaveBalances, setLeaveBalances] = useState<any[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<any[]>([])

  const fetchData = useCallback(async () => {
    setError('')
    try {
      const [summaryRes, scheduleRes, leaveRes, notifRes] = await Promise.all([
        fetch('/api/my/summary', { credentials: 'include' }),
        fetch('/api/my/schedule', { credentials: 'include' }),
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
      setSchedule(scheduleData.shifts || [])
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

  if (loading) return <div className="flex justify-center items-center py-12 text-gray-400">載入中...</div>
  if (error) return <div className="p-4 text-red-600 dark:text-red-400">⚠️ {error}</div>

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-4">
        👋 我的首頁
      </h1>

      {/* Quick Actions — 2x2 grid on mobile */}
      <div className="card mb-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">快捷操作</h2>
        <div className="grid grid-cols-2 gap-3">
          {[
            { href: '/punch', icon: '📱', label: '打卡' },
            { href: '/my/schedule', icon: '📅', label: '班表' },
            { href: '/my/leave', icon: '🏖️', label: '假期' },
            { href: '/my/notifications', icon: '🔔', label: '通知', badge: unreadCount },
          ].map(item => (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-col items-center justify-center p-4 rounded-lg bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors relative"
            >
              <span className="text-2xl mb-1">{item.icon}</span>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{item.label}</span>
              {item.badge && item.badge > 0 && (
                <span className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-5 h-5 text-[10px] flex items-center justify-center font-semibold">
                  {item.badge}
                </span>
              )}
            </Link>
          ))}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="space-y-2 mb-3">
        {[
          { value: summary?.shiftCount || 0, label: '本月排班' },
          { value: summary?.clockInCount || 0, label: '本月打卡（上班）' },
          { value: summary?.leaveDays || 0, label: '本月請假（天）' },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Late Attendance */}
      <div className="space-y-2 mb-3">
        <div className="stat-card">
          <div className="stat-value">{summary?.lateCount || 0}</div>
          <div className="stat-label">本月遲到次數</div>
          {summary?.lateMinutes != null && summary.lateMinutes > 0 && (
            <div className="text-xs text-gray-400 mt-1">共 {summary.lateMinutes} 分鐘</div>
          )}
          {summary?.lateMinutes != null && summary.lateMinutes > 30 && (
            <div className="text-xs text-red-600 dark:text-red-400 mt-1">⚠️ 已超30分，勤工獎可能取消</div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-value">{summary?.lateMinutes || 0}</div>
          <div className="stat-label">本月遲到（分鐘）</div>
        </div>
      </div>

      {/* Leave Balances */}
      {leaveBalances.length > 0 && (
        <div className="card mb-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">假期餘額</h2>
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
                  <div className="text-sm text-gray-500 dark:text-gray-400">{b.leaveType.name}</div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-gray-900 dark:text-white">{b.remaining.toFixed(1)}</div>
                  <div className="text-xs text-gray-400">天剩餘</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming Shifts */}
      {schedule.length > 0 && (
        <div className="card mb-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">即將到來的班次</h2>
          <div className="space-y-2">
            {schedule.slice(0, 5).map(s => (
              <div
                key={s.id}
                className="p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-sm text-gray-900 dark:text-white">
                    {new Date(s.startTime).toLocaleDateString('zh-HK')}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded" style={{
                    background: s.status === 'CONFIRMED' ? '#e6f4ec' : '#fdf6e3',
                    color: s.status === 'CONFIRMED' ? '#2e7d5b' : '#b8860b',
                  }}>
                    {s.status === 'CONFIRMED' ? '已確認' : s.status === 'DRAFT' ? '草稿' : s.status}
                  </span>
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-300">
                  {new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                  {' - '}
                  {new Date(s.endTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">{s.clinic?.name || '-'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Notifications */}
      {notifications.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">最近通知</h2>
            <Link href="/my/notifications" className="text-sm text-[#0d7377] dark:text-teal-400">
              查看全部 →
            </Link>
          </div>
          <div className="space-y-1">
            {notifications.slice(0, 5).map(n => (
              <div
                key={n.id}
                className="flex items-center justify-between py-2.5 px-2 border-b border-gray-100 dark:border-gray-700 last:border-0"
                style={{ background: n.isRead ? 'transparent' : '#f0f7ff' }}
              >
                <div className="flex-1 min-w-0 mr-2">
                  <div className="text-sm text-gray-800 dark:text-gray-200 truncate">{n.content}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {new Date(n.createdAt).toLocaleString('zh-HK')}
                  </div>
                </div>
                {!n.isRead && (
                  <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
