'use client'

import { useEffect, useState, useCallback } from 'react'

const TYPE_ICONS: Record<string, string> = {
  LEAVE_APPROVED: '✅',
  LEAVE_REJECTED: '❌',
  SHIFT_CHANGED: '📅',
  CORRECTION_APPROVED: '📋',
  SHIFT_CANCELLED: '🚫',
}

const TYPE_COLORS: Record<string, string> = {
  LEAVE_APPROVED: '#4CAF50',
  LEAVE_REJECTED: '#dc3545',
  SHIFT_CHANGED: '#2196F3',
  CORRECTION_APPROVED: '#FF9800',
  SHIFT_CANCELLED: '#888',
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchData = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/notifications', { credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `伺服器錯誤 (${res.status})`)
      }
      const data = await res.json()
      setNotifications(data.notifications || [])
    } catch (err: any) {
      setError(err.message || '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Poll every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [fetchData])

  const handleMarkRead = async (id: string) => {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: 'PUT',
        credentials: 'include',
      })
      setNotifications(prev =>
        prev.map(n => n.id === id ? { ...n, isRead: true } : n)
      )
    } catch (err) {
      console.error('Mark read error:', err)
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await fetch('/api/notifications/read-all', {
        method: 'POST',
        credentials: 'include',
      })
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })))
    } catch (err) {
      console.error('Mark all read error:', err)
    }
  }

  const unreadCount = notifications.filter(n => !n.isRead).length

  if (loading) return <div style={{ padding: 24 }}>載入中...</div>
  if (error) return <div style={{ padding: 24, color: '#c00' }}>⚠️ {error}</div>

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a2e', margin: 0 }}>
          🔔 通知中心 {unreadCount > 0 && <span style={{ fontSize: 14, color: '#dc3545', marginLeft: 8 }}>({unreadCount} 未讀)</span>}
        </h1>
        {unreadCount > 0 && (
          <button className="btn btn-sm" style={{ background: '#f0f0f0' }} onClick={handleMarkAllRead}>
            全部標記已讀
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {notifications.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 60 }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🔔</div>
            <div>尚無通知</div>
          </div>
        ) : (
          notifications.map(n => {
            const icon = TYPE_ICONS[n.type] || '📢'
            const color = TYPE_COLORS[n.type] || '#888'
            return (
              <div
                key={n.id}
                style={{
                  padding: '14px 20px',
                  borderBottom: '1px solid #f0f0f0',
                  background: n.isRead ? 'transparent' : '#f0f7ff',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
                onClick={() => !n.isRead && handleMarkRead(n.id)}
                onMouseEnter={e => {
                  if (!n.isRead) e.currentTarget.style.background = '#e3f2fd'
                }}
                onMouseLeave={e => {
                  if (!n.isRead) e.currentTarget.style.background = '#f0f7ff'
                }}
              >
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: `${color}15`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  flexShrink: 0,
                }}>
                  {icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: '#333' }}>{n.content}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    {new Date(n.createdAt).toLocaleString('zh-HK')}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {!n.isRead && (
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: '#dc3545',
                      flexShrink: 0,
                    }} />
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
