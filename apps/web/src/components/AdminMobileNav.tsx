'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CalendarDays, LayoutDashboard, CheckSquare, ClipboardList, Menu, QrCode } from 'lucide-react'
import { useTodoCount } from '@/lib/use-todo-count'
import { hasPermission } from '@/lib/permissions'

export default function AdminMobileNav({
  role, grant, deny,
}: { role: string; grant: string[]; deny: string[] }) {
  const pathname = usePathname()
  const todoCount = useTodoCount()

  const allItems = [
    { href: '/dashboard', label: '今日', Icon: LayoutDashboard, perm: null },
    { href: '/punch', label: '打卡', Icon: QrCode, perm: null },
    { href: '/todo', label: '待辦', Icon: CheckSquare, perm: ['scheduling', 'leave_approve', 'attendance_manage'], badge: todoCount.total },
    { href: '/attendance', label: '考勤', Icon: ClipboardList, perm: 'attendance_manage' },
    { href: '/scheduling', label: '排班', Icon: CalendarDays, perm: 'scheduling' },
    { href: '/mobile-more', label: '更多', Icon: Menu, perm: null },
  ]

  // 按權限過濾，「更多」永遠在最後，上限 5 個
  const more = allItems[allItems.length - 1]
  const rest = allItems
    .filter(i => {
      if (i.href === '/mobile-more') return false
      if (!i.perm) return true
      // 陣列 = 有其中一個就得（2026-08-03，同 layout.tsx nav filter 一致）
      const ps = Array.isArray(i.perm) ? i.perm : [i.perm]
      return ps.some(p => hasPermission(role as any, p as any, grant, deny))
    })
    .slice(0, 4)
  const items = [...rest, more]

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t flex md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {items.map(({ href, label, Icon, badge }) => (
        <Link
          key={href}
          href={href}
          className={`flex-1 flex flex-col items-center py-2 text-[10px] ${
            pathname === href
              ? 'text-primary font-semibold'
              : 'text-muted-foreground'
          }`}
        >
          <span className="relative">
            <Icon size={18} />
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
