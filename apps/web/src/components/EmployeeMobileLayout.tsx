'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 pb-16">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between">
        <h1 className="text-base font-bold text-gray-900 dark:text-white">🏥 診所系統</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">{user.name}</span>
          <button
            onClick={onLogout}
            className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
          >
            登出
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="px-4 py-3">{children}</div>

      {/* Bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 h-16 safe-area-bottom">
        <div className="flex items-center justify-around h-full">
          {TABS.map(tab => {
            const active = pathname === tab.path || pathname.startsWith(tab.path + '/')
            return (
              <Link
                key={tab.path}
                href={tab.path}
                className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full
                  ${
                    active
                      ? 'text-brand dark:text-teal-400 font-semibold'
                      : 'text-gray-400 dark:text-gray-500'
                  }`}
              >
                <span className="text-xl">{tab.icon}</span>
                <span className="text-[11px]">{tab.label}</span>
              </Link>
            )
          })}
        </div>
      </nav>

      <PWAPrompt />
    </div>
  )
}
