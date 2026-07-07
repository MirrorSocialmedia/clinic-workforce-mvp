'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import PWAPrompt from '@/components/PWAPrompt'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

interface UserData {
  id: string
  name: string
  phone: string
  role: Role
  clinics: any[]
}

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<UserData | null>(null)
  const [loading, setLoading] = useState(true)
  const [unreadCount, setUnreadCount] = useState(0)

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) {
        router.push('/login')
        return
      }
      const data = await res.json()
      setUser(data.user)
    } catch {
      router.push('/login')
    } finally {
      setLoading(false)
    }
  }, [router])

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setUnreadCount(data.unreadCount || 0)
      }
    } catch {
      // Ignore errors
    }
  }, [])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  // Fetch unread count once and then poll every 60 seconds
  useEffect(() => {
    if (!user) return
    fetchUnreadCount()
    const interval = setInterval(fetchUnreadCount, 60000)
    return () => clearInterval(interval)
  }, [user, fetchUnreadCount])

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    router.push('/login')
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div>載入中...</div>
      </div>
    )
  }

  if (!user) return null

  const allRoles = ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'] as const

  const navItems = [
    { path: '/my/dashboard', label: '👋 我的首頁', roles: allRoles },
    { path: '/my/schedule', label: '📅 我的班表', roles: allRoles },
    { path: '/my/punches', label: '📋 我的考勤', roles: allRoles },
    { path: '/my/leave', label: '🏖️ 我的假期', roles: allRoles },
    { path: '/my/notifications', label: '🔔 通知', roles: allRoles },
    { path: '/punch', label: '📱 打卡', roles: allRoles },
    { path: '/clinic/qr', label: '🏥 診所 QR 碼', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/dashboard', label: '📊 儀表板', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/attendance', label: '📋 考勤記錄', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/scheduling', label: '📅 排班管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/leave', label: '🏖️ 假期管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/leave-types', label: '🏷️ 假期類型', roles: ['OWNER'] },
    { path: '/employees', label: '👥 員工管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/clinics', label: '🏥 診所管理', roles: ['OWNER'] },
    { path: '/users', label: '🔑 用戶管理', roles: ['OWNER'] },
    { path: '/hash', label: '🔒 每日雜湊', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/audit-logs', label: '📝 審計日誌', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/payroll', label: '💰 計糧管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/payroll/reports/exceptions', label: '📋 考勤異常', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  ]

  const visibleNav = navItems.filter(item => item.roles.includes(user.role as any))

  const badgeClass = `badge badge-${user.role.toLowerCase()}`

  // Check if current path starts with a nav item path for active state
  const isActive = (itemPath: string) => {
    if (itemPath === '/my/dashboard' && pathname === '/my/dashboard') return true
    return pathname.startsWith(itemPath) && (pathname.length === itemPath.length || pathname[itemPath.length] === '/')
  }

  return (
    <div style={{ display: 'flex' }}>
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>🏥 診所系統</h1>
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>勞動力管理</div>
        </div>

        <nav className="sidebar-nav">
          {/* My section */}
          <div style={{ padding: '8px 20px 4px', fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 1 }}>
            我的
          </div>
          {visibleNav.filter(item => item.path.startsWith('/my')).map(item => (
            <Link
              key={item.path}
              href={item.path}
              className={isActive(item.path) ? 'active' : ''}
              style={{ position: 'relative' }}
            >
              {item.label}
              {item.path === '/my/notifications' && unreadCount > 0 && (
                <span style={{
                  marginLeft: 'auto',
                  background: '#dc3545',
                  color: 'white',
                  borderRadius: 10,
                  padding: '1px 6px',
                  fontSize: 11,
                  fontWeight: 600,
                  minWidth: 18,
                  textAlign: 'center',
                }}>
                  {unreadCount}
                </span>
              )}
            </Link>
          ))}

          {/* Divider */}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: '8px 20px' }} />

          {/* Main section */}
          <div style={{ padding: '8px 20px 4px', fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 1 }}>
            系統
          </div>
          {visibleNav.filter(item => !item.path.startsWith('/my')).map(item => (
            <Link
              key={item.path}
              href={item.path}
              className={isActive(item.path) ? 'active' : ''}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer" style={{ position: 'relative', bottom: 'auto', width: 'auto' }}>
          <div style={{ fontSize: 13, color: '#ccc' }}>{user.name}</div>
          <span className={badgeClass}>{user.role}</span>
          <button
            onClick={handleLogout}
            style={{
              marginTop: 10,
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#ccc',
              padding: '4px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
              width: '100%',
            }}
          >
            登出
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="main-content">
        {children}
        <PWAPrompt />
      </div>
    </div>
  )
}
