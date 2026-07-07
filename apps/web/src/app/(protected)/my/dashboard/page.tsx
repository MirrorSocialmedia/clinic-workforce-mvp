'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

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

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) return <div style={{ padding: 24 }}>載入中...</div>
  if (error) return <div style={{ padding: 24, color: '#c00' }}>⚠️ {error}</div>

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', marginBottom: 24 }}>
        👋 我的首頁
      </h1>

      {/* Quick Actions */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2>快捷操作</h2>
        <div className="grid-4" style={{ marginBottom: 0 }}>
          <Link href="/punch" className="card" style={{ textAlign: 'center', cursor: 'pointer', textDecoration: 'none', padding: 20 }}>
            <div style={{ fontSize: 28 }}>📱</div>
            <div style={{ marginTop: 8, fontSize: 14, color: '#333', fontWeight: 500 }}>打卡</div>
          </Link>
          <Link href="/my/schedule" className="card" style={{ textAlign: 'center', cursor: 'pointer', textDecoration: 'none', padding: 20 }}>
            <div style={{ fontSize: 28 }}>📅</div>
            <div style={{ marginTop: 8, fontSize: 14, color: '#333', fontWeight: 500 }}>我的班表</div>
          </Link>
          <Link href="/my/leave" className="card" style={{ textAlign: 'center', cursor: 'pointer', textDecoration: 'none', padding: 20 }}>
            <div style={{ fontSize: 28 }}>🏖️</div>
            <div style={{ marginTop: 8, fontSize: 14, color: '#333', fontWeight: 500 }}>假期</div>
          </Link>
          <Link href="/my/notifications" className="card" style={{ textAlign: 'center', cursor: 'pointer', textDecoration: 'none', padding: 20, position: 'relative' }}>
            <div style={{ fontSize: 28 }}>🔔</div>
            <div style={{ marginTop: 8, fontSize: 14, color: '#333', fontWeight: 500 }}>通知</div>
            {unreadCount > 0 && (
              <span style={{
                position: 'absolute', top: 8, right: 8,
                background: '#dc3545', color: 'white',
                borderRadius: '50%', width: 20, height: 20,
                fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {unreadCount}
              </span>
            )}
          </Link>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid-3" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-value">{summary?.shiftCount || 0}</div>
          <div className="stat-label">本月排班</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{summary?.clockInCount || 0}</div>
          <div className="stat-label">本月打卡（上班）</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{summary?.leaveDays || 0}</div>
          <div className="stat-label">本月請假（天）</div>
        </div>
      </div>

      {/* Leave Balances */}
      {leaveBalances.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2>假期餘額</h2>
          <div className="grid-4" style={{ marginBottom: 0 }}>
            {leaveBalances.map(b => (
              <div key={b.id} style={{
                padding: 16,
                borderRadius: 8,
                background: `${b.leaveType.color || '#1a1a2e'}10`,
                borderLeft: `4px solid ${b.leaveType.color || '#1a1a2e'}`,
              }}>
                <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>{b.leaveType.name}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{b.remaining.toFixed(1)}</div>
                <div style={{ fontSize: 12, color: '#888' }}>天剩餘</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming Shifts */}
      {schedule.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2>即將到來的班次</h2>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>時間</th>
                <th>診所</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {schedule.slice(0, 5).map(s => (
                <tr key={s.id}>
                  <td>{new Date(s.startTime).toLocaleDateString('zh-HK')}</td>
                  <td>
                    {new Date(s.startTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                    {' - '}
                    {new Date(s.endTime).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td>{s.clinic?.name || '-'}</td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      background: s.status === 'CONFIRMED' ? '#e8f5e9' : '#fff3e0',
                      color: s.status === 'CONFIRMED' ? '#2e7d32' : '#e65100',
                    }}>
                      {s.status === 'CONFIRMED' ? '已確認' : s.status === 'DRAFT' ? '草稿' : s.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Notifications */}
      {notifications.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2>最近通知</h2>
            <Link href="/my/notifications" style={{ fontSize: 13, color: '#1565c0', textDecoration: 'none' }}>
              查看全部 →
            </Link>
          </div>
          {notifications.slice(0, 5).map(n => (
            <div key={n.id} style={{
              padding: '10px 12px',
              borderBottom: '1px solid #eee',
              background: n.isRead ? 'transparent' : '#f0f7ff',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 14 }}>{n.content}</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                  {new Date(n.createdAt).toLocaleString('zh-HK')}
                </div>
              </div>
              {!n.isRead && (
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#dc3545', flexShrink: 0 }} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
