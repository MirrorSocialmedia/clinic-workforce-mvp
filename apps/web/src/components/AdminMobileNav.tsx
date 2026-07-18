'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, CheckSquare, ClipboardList, Menu } from 'lucide-react'
import { useTodoCount } from '@/lib/use-todo-count'

export default function AdminMobileNav() {
  const pathname = usePathname()
  const todoCount = useTodoCount()

  const items = [
    { href: '/dashboard', label: '今日', Icon: LayoutDashboard },
    { href: '/todo', label: '待辦', Icon: CheckSquare, badge: todoCount.total },
    { href: '/attendance', label: '考勤', Icon: ClipboardList },
    { href: '/mobile-more', label: '更多', Icon: Menu },
  ]

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t flex md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {items.map(({ href, label, Icon, badge }) => (
        <Link
          key={href}
          href={href}
          className={`flex-1 flex flex-col items-center py-2 text-xs ${
            pathname === href
              ? 'text-primary font-semibold'
              : 'text-muted-foreground'
          }`}
        >
          <span className="relative">
            <Icon size={20} />
            {!!badge && badge > 0 && (
              <span className="absolute -top-1 -right-2 bg-red-500 text-white rounded-full text-[10px] px-1 min-w-[16px] text-center">
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </span>
          {label}
        </Link>
      ))}
    </nav>
  )
}
