'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import PWAPrompt from './PWAPrompt'

const TABS = [
  { path: '/my/dashboard', label: '首頁', icon: '🏠' },
  { path: '/punch', label: '打卡', icon: '📱' },
  { path: '/my/schedule', label: '班表', icon: '📅' },
  { path: '/my/leave', label: '假期', icon: '🏖' },
]

export default function EmployeeMobileLayout({
  children,
  user,
  onLogout,
}: {
  children: React.ReactNode
  user: { name: string; role: string }
  onLogout: () => void
}) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-background pb-16">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-card border-b border-border px-4 py-3 flex items-center justify-between">
        <h1 className="text-base font-bold text-foreground">🏥 診所系統</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{user.name}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onLogout}
            className="text-xs h-7 px-2"
          >
            登出
          </Button>
        </div>
      </header>

      {/* Content */}
      <div className="px-4 py-3">{children}</div>

      {/* Bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border h-16 safe-area-bottom">
        <div className="flex items-center justify-around h-full">
          {TABS.map(tab => {
            const active = pathname === tab.path || pathname.startsWith(tab.path + '/')
            return (
              <Link
                key={tab.path}
                href={tab.path}
                className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full relative
                  ${
                    active
                      ? 'text-brand dark:text-teal-400 font-semibold'
                      : 'text-muted-foreground'
                  }`}
              >
                <span className="text-xl">{tab.icon}</span>
                <span className="text-[11px]">{tab.label}</span>
                {active && (
                  <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-brand rounded-full" />
                )}
              </Link>
            )
          })}
        </div>
      </nav>

      <PWAPrompt />
    </div>
  )
}
