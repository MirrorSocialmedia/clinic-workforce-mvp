'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { Toaster } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import PWAPrompt from '@/components/PWAPrompt'
import EmployeeMobileLayout from '@/components/EmployeeMobileLayout'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

interface UserData {
  id: string
  name: string
  phone: string
  role: Role
  clinics: any[]
}

const ROLE_BADGE_VARIANT: Record<Role, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  OWNER: { variant: 'default', label: 'Owner' },
  MANAGER: { variant: 'secondary', label: 'Mgr' },
  ACCOUNTANT: { variant: 'outline', label: 'Acct' },
  EMPLOYEE: { variant: 'secondary', label: 'Emp' },
}

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<UserData | null>(null)
  const [loading, setLoading] = useState(true)
  const [unreadCount, setUnreadCount] = useState(0)
  const [collapsed, setCollapsed] = useState(false)

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
      <div className="flex justify-center items-center min-h-screen">
        <div className="text-gray-400">載入中...</div>
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
    { path: '/punch', label: '📱 我要打卡', roles: allRoles },
    { path: '/clinic/qr', label: '🖥 診所打卡螢幕', roles: ['OWNER', 'MANAGER'] },
    { path: '/dashboard', label: '📊 儀表板', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/attendance', label: '📋 考勤', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/scheduling', label: '📅 排班管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/leave', label: '🏖️ 假期管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/accounts', label: '👥 帳號管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/clinics', label: '🏥 診所管理', roles: ['OWNER'] },
    { path: '/audit-logs', label: '📝 審計日誌', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/payroll', label: '💰 計糧管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  ]

  const visibleNav = navItems.filter(item => item.roles.includes(user.role as any))

  const isActive = (itemPath: string) => {
    if (pathname === itemPath) return true
    const parentPattern = itemPath + '/'
    if (!pathname.startsWith(parentPattern)) return false
    const longerMatch = visibleNav.find(other => {
      if (other.path === itemPath) return false
      if (!pathname.startsWith(other.path)) return false
      return other.path.length > itemPath.length
    })
    return !longerMatch
  }

  // 員工用手機版佈局
  if (user.role === 'EMPLOYEE') {
    return (
      <EmployeeMobileLayout user={{ name: user.name, role: user.role }} onLogout={handleLogout}>
        {children}
      </EmployeeMobileLayout>
    )
  }

  const roleBadge = ROLE_BADGE_VARIANT[user.role]

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-50 flex flex-col bg-gradient-to-b from-slate-900 to-slate-950 text-gray-100 h-screen transition-all duration-300 ease-in-out border-r border-gray-700
          ${collapsed ? 'w-20' : 'w-64'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          {!collapsed && (
            <div>
              <h1 className="text-lg font-bold text-white">🏥 診所系統</h1>
              <div className="text-xs text-gray-400 mt-0.5">勞動力管理</div>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className="h-8 w-8 text-gray-400 hover:text-white hover:bg-gray-700"
            title={collapsed ? '展開' : '收合'}
          >
            {collapsed ? '→' : '←'}
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
          {/* My section */}
          <div>
            {!collapsed && (
              <div className="px-3 mb-2 text-xs uppercase text-gray-500 tracking-wider">我的</div>
            )}
            <div className="space-y-1">
              {visibleNav.filter(item => item.path.startsWith('/my')).map(item => (
                <Link
                  key={item.path}
                  href={item.path}
                  className={`flex items-center px-3 py-2 rounded-lg text-sm transition-colors relative
                    ${isActive(item.path)
                      ? 'bg-brand/90 text-white font-medium shadow-sm'
                      : 'text-gray-300 hover:bg-slate-800/50 hover:text-white'
                    }`}
                  title={item.label}
                >
                  <span className={`${collapsed ? 'mx-auto' : ''}`}>
                    {isActive(item.path) && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-white rounded-r" />
                    )}
                    {item.label}
                  </span>
                  {item.path === '/my/notifications' && unreadCount > 0 && (
                    <Badge variant="destructive" className="ml-auto text-xs px-1.5 min-w-[22px] justify-center">
                      {unreadCount}
                    </Badge>
                  )}
                </Link>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-700" />

          {/* System section */}
          <div>
            {!collapsed && (
              <div className="px-3 mb-2 text-xs uppercase text-gray-500 tracking-wider">系統</div>
            )}
            <div className="space-y-1">
              {visibleNav.filter(item => !item.path.startsWith('/my')).map(item => (
                <Link
                  key={item.path}
                  href={item.path}
                  className={`flex items-center px-3.5 py-2.5 rounded-lg text-[13.5px] transition-colors
                    ${isActive(item.path)
                      ? 'bg-brand/90 text-white font-medium shadow-sm'
                      : 'text-gray-300 hover:bg-slate-800/50 hover:text-white'
                    }`}
                  title={item.label}
                >
                  <span className={`${collapsed ? 'mx-auto' : ''}`}>
                    {isActive(item.path) && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-white rounded-r" />
                    )}
                    {item.label}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-gray-700">
          <div className="flex items-center gap-2 mb-2">
            {!collapsed && (
              <>
                <div className="flex-1 text-sm text-gray-300 truncate">{user.name}</div>
                <Badge variant={roleBadge.variant}>
                  {roleBadge.label}
                </Badge>
              </>
            )}
          </div>
          <Button
            variant="outline"
            onClick={handleLogout}
            className="w-full py-1.5 text-sm border-gray-600 text-gray-300 hover:bg-gray-800 hover:text-white hover:border-gray-500"
          >
            {collapsed ? '🚪' : '登出'}
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main
        className="flex-1 transition-all duration-300"
        style={{ marginLeft: collapsed ? '80px' : '256px' }}
      >
        <div className="main-content">
        {children}
        <PWAPrompt />
        </div>
      </main>

      {/* Toast notifications */}
      <Toaster position="top-right" theme="light" />
    </div>
  )
}
