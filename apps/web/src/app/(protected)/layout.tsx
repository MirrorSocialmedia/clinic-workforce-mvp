'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'

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

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

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

  const navItems = [
    { path: '/dashboard', label: '📊 儀表板', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'] },
    { path: '/clinics', label: '🏥 診所管理', roles: ['OWNER'] },
    { path: '/employees', label: '👥 員工管理', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
    { path: '/users', label: '🔑 用戶管理', roles: ['OWNER'] },
    { path: '/audit-logs', label: '📝 審計日誌', roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  ]

  const visibleNav = navItems.filter(item => item.roles.includes(user.role))

  const badgeClass = `badge badge-${user.role.toLowerCase()}`

  return (
    <div style={{ display: 'flex' }}>
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>🏥 診所系統</h1>
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>勞動力管理</div>
        </div>

        <nav className="sidebar-nav">
          {visibleNav.map(item => (
            <Link
              key={item.path}
              href={item.path}
              className={pathname === item.path ? 'active' : ''}
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
      </div>
    </div>
  )
}
