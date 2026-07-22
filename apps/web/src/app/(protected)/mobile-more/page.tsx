'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import {
  Calendar,
  Palmtree,
  FileText,
  Users,
  LogOut,
  Monitor,
  AlertTriangle,
  Wallet,
} from 'lucide-react'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE'

interface MenuItem {
  label: string
  href: string
  icon: any
  roles: Role[]
  description?: string
  warning?: boolean
}

export default function MobileMorePage() {
  const router = useRouter()
  const [userRole, setUserRole] = useState<Role | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json()
        setUserRole(data.user.role as Role)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const menuItems: MenuItem[] = [
    {
      label: '計糧管理',
      href: '/payroll',
      icon: Wallet,
      roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    },
    {
      label: '排班管理',
      href: '/scheduling',
      icon: Calendar,
      roles: ['OWNER', 'MANAGER'],
      description: '整週規劃請在電腦端操作',
      warning: true,
    },
    {
      label: '假期管理',
      href: '/leave',
      icon: Palmtree,
      roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    },
    {
      label: '臉部覆核',
      href: '/face-review',
      icon: Monitor,
      roles: ['OWNER', 'MANAGER'],
    },
    {
      label: '帳號管理',
      href: '/accounts',
      icon: Users,
      roles: ['OWNER'],
    },
    {
      label: '審計日志',
      href: '/audit-logs',
      icon: FileText,
      roles: ['OWNER'],
    },
  ]

  const visibleItems = menuItems.filter((item) =>
    userRole ? item.roles.includes(userRole) : false
  )

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    router.push('/login')
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12 text-muted-foreground">
        載入中...
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      {/* Page Header */}
      <div>
        <h1 className="text-xl font-bold">更多</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {userRole === 'OWNER'
            ? '創辦人 / 總管理'
            : userRole === 'MANAGER'
              ? '診所經理'
              : userRole === 'ACCOUNTANT'
                ? '會計'
                : ''}
        </p>
      </div>

      {/* Menu Items */}
      <div className="space-y-2">
        {visibleItems.map((item) => {
          const Icon = item.icon
          return (
            <Link key={item.href} href={item.href}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                    <Icon size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{item.label}</div>
                    {item.warning && (
                      <div className="flex items-center gap-1 text-xs text-amber-600 mt-0.5">
                        <AlertTriangle size={12} />
                        {item.description}
                      </div>
                    )}
                  </div>
                  <svg
                    className="w-5 h-5 text-muted-foreground flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>

      {/* Logout */}
      <div className="pt-4">
        <button
          className="w-full flex items-center gap-3 px-4 py-3 bg-red-50 text-red-600 rounded-xl hover:bg-red-100 transition-colors min-h-[48px]"
          onClick={handleLogout}
        >
          <LogOut size={20} />
          <span className="font-medium">登出</span>
        </button>
      </div>
    </div>
  )
}
