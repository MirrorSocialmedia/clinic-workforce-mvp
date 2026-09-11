'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { Toaster } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import PWAPrompt from '@/components/PWAPrompt'
import EmployeeMobileLayout from '@/components/EmployeeMobileLayout'
import { LayoutDashboard, Calendar, ClipboardList, Palmtree, Bell, Smartphone, Monitor, BarChart3, Building2, FileText, Wallet, Users, ShieldCheck, KeyRound, UserCircle, Stethoscope, CreditCard, Receipt } from 'lucide-react'
import AdminMobileNav from '@/components/AdminMobileNav'
import { hasPermission, MGMT_PERMS } from '@/lib/permissions'
import { MY_NAV } from '@/lib/my-nav'

type Role = 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'EMPLOYEE' | 'KIOSK'

interface UserData {
  id: string
  name: string
  phone: string
  role: Role
  clinics: any[]
  grant?: string[]
  deny?: string[]
}

const ROLE_BADGE_VARIANT: Record<Role, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  OWNER: { variant: 'default', label: 'Owner' },
  MANAGER: { variant: 'secondary', label: 'Mgr' },
  ACCOUNTANT: { variant: 'outline', label: 'Acct' },
  EMPLOYEE: { variant: 'secondary', label: 'Emp' },
  KIOSK: { variant: 'outline', label: 'Kiosk' },
}

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<UserData | null>(null)
  const [loading, setLoading] = useState(true)
  const [unreadCount, setUnreadCount] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [grant, setGrant] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (!res.ok) {
        router.push('/login')
        return
      }
      const data = await res.json()
      setUser(data.user)
      setGrant(data.user?.grant ?? [])
      setDeny(data.user?.deny ?? [])
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

  // SW cleanup: unregister stale service workers + clear caches
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(r => r.unregister())
      })
    }
    if (window.caches) {
      caches.keys().then(keys => keys.forEach(k => caches.delete(k)))
    }
  }, [])

  useEffect(() => {
    if (!user) return
    fetchUnreadCount()
    const interval = setInterval(fetchUnreadCount, 60000)
    return () => clearInterval(interval)
  }, [user, fetchUnreadCount])

  // ★ 縮放偵測器：?debug=1 時顯示視口/撐破元素資訊
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!new URLSearchParams(window.location.search).has('debug')) return
    const t = setTimeout(() => {
      const bad: string[] = []
      document.querySelectorAll('*').forEach(el => {
        const e = el as HTMLElement
        if (e.scrollWidth > window.innerWidth + 5) {
          const cls = (typeof e.className === 'string' ? e.className : '').slice(0, 50)
          bad.push(`${e.tagName}${e.id ? '#' + e.id : ''}.${cls} → ${e.scrollWidth}px`)
        }
      })
      const div = document.createElement('div')
      div.style.cssText = 'position:fixed;bottom:70px;left:8px;right:8px;z-index:99999;background:#fef2f2;border:2px solid #dc2626;font-size:11px;padding:8px;max-height:45vh;overflow:auto;white-space:pre-wrap;border-radius:8px'
      div.textContent = `視口 ${window.innerWidth}px · body ${document.body.scrollWidth}px\n` +
        (bad.length ? `撐破元素(${bad.length}):\n${bad.join('\n')}`
          : '無元素撐破 → 是瀏覽器縮放記憶/設定,請查「電腦版網站」勾選')
      div.onclick = () => div.remove()
      document.body.appendChild(div)
    }, 1500)
    return () => clearTimeout(t)
  }, [])

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
  const myRoles = ['MANAGER', 'ACCOUNTANT', 'EMPLOYEE'] as const
  const mgmtRoles = ['OWNER', 'MANAGER'] as const
  const viewRoles = ['OWNER', 'MANAGER', 'ACCOUNTANT'] as const

  // ★ 2026-08-22：「我的」清單單一事實來源 = MY_NAV（lib/my-nav.ts）—— 之前三處硬編碼（mobile-more / my/more / 呢度），
  //   加一頁要改三處（實際漏咗兩次）。加新頁只改 my-nav.ts；icon 由 MY_ICONS 按 href 對照，
  //   漏一個 → fallback ClipboardList（防 React <undefined /> crash）
  const MY_ICONS: Record<string, any> = {
    '/my/dashboard': LayoutDashboard,
    '/my/schedule': Calendar,
    '/my/leave': Palmtree,
    '/my/punches': ClipboardList,
    '/my/expenses': Receipt,
    '/my/face-enroll': Palmtree,
    '/my/notifications': Bell,
    '/my/change-password': KeyRound,
  }

  const navItems = [
    // My section items (perm: null → visible to all non-OWNER via sidebar filter; perm check allows mgmt-EMPLOYEE)
    ...MY_NAV.map(m => ({
      path: m.href,
      label: m.label,
      icon: MY_ICONS[m.href] ?? ClipboardList,
      roles: allRoles,
      perm: null,
    })),

    // Punch (all non-owner)
    { path: '/punch', label: '我要打卡', icon: Smartphone, roles: myRoles },

    // System management
    { path: '/clinic/qr', label: '診所打卡螢幕', icon: Monitor, roles: mgmtRoles },
    { path: '/dashboard', label: '儀表板', icon: BarChart3, roles: viewRoles, perm: [...MGMT_PERMS] },
    { path: '/attendance', label: '考勤', icon: ClipboardList, roles: viewRoles, perm: 'attendance_manage' },
    { path: '/scheduling', label: '排班管理', icon: Calendar, roles: mgmtRoles, perm: 'scheduling' },
    { path: '/providers', label: '醫生管理', icon: Stethoscope, roles: mgmtRoles, perm: 'scheduling' },
    { path: '/provider-schedule', label: '醫生當值表', icon: Stethoscope, roles: mgmtRoles, perm: 'provider_schedule' },
    // ★ cw-pa P4: 醫生時間表（Apricot 實際開診/預約）—— 同上面「醫生當值表」（人手排更）係兩樣嘢（spec §6.4）
    // ★ 2026-08-22：KIOSK 冇 scheduling（佢含員工時間帳戶／假期餘額）——用 provider_schedule，同 config.ts:490 override 一致
    { path: '/provider-availability', label: '醫生時間表（Apricot）', icon: Stethoscope, roles: mgmtRoles, perm: ['provider_schedule', 'scheduling'] },
    { path: '/leave', label: '假期管理', icon: Palmtree, roles: mgmtRoles, perm: ['leave_approve', 'timebank_ops'] },
    { path: '/payroll', label: '計糧管理', icon: Wallet, roles: viewRoles, perm: ['payroll_view', 'payroll_generate'] },
    // ★ 員工總覽 —— OWNER + MANAGER（ACCOUNTANT 唔包，佢只需要計糧）
    //   保密員工由 API 層隔離（employees/:id/overview:46），MANAGER 睇唔到
    //   perm: 'employee_overview' allows EMPLOYEE with this perm to also see it
    { path: '/employees', label: '員工總覽', icon: UserCircle, roles: ['OWNER', 'MANAGER'], perm: 'employee_overview' },
    { path: '/accounts', label: '帳號管理', icon: Users, roles: ['OWNER'] },
    { path: '/clinics', label: '診所管理', icon: Building2, roles: ['OWNER'] },
    { path: '/audit-logs', label: '審計日志', icon: FileText, roles: ['OWNER'] },
    { path: '/face-review', label: '臉部覆核', icon: FileText, roles: ['OWNER', 'MANAGER'] },
    { path: '/hash', label: '完整性驗證', icon: ShieldCheck, roles: ['OWNER'] },
    // ★ 2026-08-22：新開咗 apricot_sync key（permissions.ts:19），同 POST /api/apricot/sync route 一致
    { path: '/apricot-sync', label: 'Apricot 同步', icon: CreditCard, roles: ['OWNER'], perm: ['apricot_sync', 'provider_payout'] },
    // ★ MD-E: 月報對數
    { path: '/reconciliation', label: '月報對數', icon: CreditCard, roles: ['OWNER'], perm: 'provider_payout' },
    // ★ P3-deploy: 成本錄入 (MANAGER + OWNER) + 醫生月結 (OWNER only)
    { path: '/cost-entry', label: '成本錄入', icon: FileText, roles: ['OWNER', 'MANAGER'], perm: 'cost_entry' },
    { path: '/payout', label: '醫生月結', icon: Receipt, roles: ['OWNER'], perm: 'provider_payout' },
  ]

  const visibleNav = navItems.filter(item => {
    // ① role 白名單直接放行
    if (item.roles.includes(user.role as any)) return true
    // ② 冇 perm 就淨係睇 role
    if (!item.perm) return false
    // ③ 有 perm：陣列 = 有其中一個就得（2026-08-03）
    const perms = Array.isArray(item.perm) ? item.perm : [item.perm]
    return perms.some(p => hasPermission(user.role, p as any, grant, deny))
  })

  const isActive = (itemPath: string) => {
    if (!pathname) return false
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

  // KIOSK: world is only one page — QR, no navigation
  if (user.role === 'KIOSK') {
    const onQr = pathname?.startsWith('/clinic/qr')

    // ★ 2026-08-22：KIOSK 可 grant 權限（成本錄入／醫生月結／時間表／同步）
    // 重用 navItems + hasPermission（同一套判斷），唔好另寫清單
    const KIOSK_PATHS = ['/provider-schedule', '/provider-availability',
      '/cost-entry', '/payout', '/apricot-sync', '/reconciliation']
    const kioskLinks = navItems.filter(item =>
      KIOSK_PATHS.includes(item.path) &&
      (Array.isArray(item.perm) ? item.perm : [item.perm])
        .filter(Boolean)
        .some(p => hasPermission(user.role, p as any, grant, deny)),
    )

    // 雙態 bar：QR 全螢幕 = fixed 透明浮層（唔破壞全黑畫面）；其餘 = sticky 自然佔位
    const barStyle: React.CSSProperties = onQr
      ? { position: 'fixed', top: 10, right: 10, zIndex: 50 }
      : { position: 'sticky', top: 0, zIndex: 50,
          padding: '8px 10px', background: 'rgba(255,255,255,.95)',
          borderBottom: '1px solid #e5e7eb' }

    return (
      <div className="min-h-screen bg-background">
        <div style={{ ...barStyle, display: 'flex', gap: 6, flexWrap: 'wrap',
          justifyContent: 'flex-end',
          maxWidth: onQr ? 'calc(100vw - 20px)' : undefined }}>
          {!onQr && (
            <Link href="/clinic/qr"
              className="text-xs px-3 py-1.5 border rounded bg-background/90 whitespace-nowrap">
              ← 打卡屏
            </Link>
          )}
          {kioskLinks
            .filter(l => !pathname?.startsWith(l.path))
            .map(l => (
              <Link key={l.path} href={l.path}
                className="text-xs px-3 py-1.5 border rounded bg-background/90 whitespace-nowrap">
                {l.label.replace('（Apricot）', '')}
              </Link>
            ))}
          <button
            onClick={() => { if (confirm('確定登出打卡屏？登出後需要管理員重新登入。')) handleLogout() }}
            className="text-xs px-3 py-1.5 border rounded bg-background/90 text-gray-500 whitespace-nowrap"
          >登出</button>
        </div>
        {children}
      </div>
    )
  }

  // 有管理權限的 EMPLOYEE → 走桌面側邊欄；普通 EMPLOYEE → 手機佈局

  const hasAnyMgmtPerm = MGMT_PERMS.some(p => hasPermission(user.role, p as any, grant, deny))

  if (user.role === 'EMPLOYEE' && !hasAnyMgmtPerm) {
    return (
      <EmployeeMobileLayout user={{ name: user.name, role: user.role }} onLogout={handleLogout}>
        {children}
      </EmployeeMobileLayout>
    )
  }

  const roleBadge = ROLE_BADGE_VARIANT[user.role]

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar — hidden on mobile, visible on md+ */}
      <aside
        className={`fixed top-0 left-0 z-50 hidden md:flex flex-col bg-gradient-to-b from-slate-900 to-slate-950 text-gray-100 h-screen transition-all duration-300 ease-in-out border-r border-gray-700
          ${collapsed ? 'w-20' : 'w-64'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          {!collapsed && (
            <div>
              <h1 className="text-lg font-bold text-white flex items-center gap-2"><Building2 size={22} /> 診所系統</h1>
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
          {/* My section — hidden for OWNER */}
          {user.role !== 'OWNER' && (
            <>
              <div>
                {!collapsed && (
                  <div className="px-3 mb-2 text-xs uppercase text-gray-500 tracking-wider">我的</div>
                )}
                <div className="space-y-1">
                  {visibleNav.filter(item => item.path.startsWith('/my')).map(item => {
                    const Icon = item.icon
                    return (
                      <Link
                        key={item.path}
                        href={item.path}
                        className={`flex items-center px-3 py-2 rounded-lg text-sm transition-colors relative gap-2.5
                          ${isActive(item.path)
                            ? 'bg-brand/90 text-white font-medium shadow-sm'
                            : 'text-gray-300 hover:bg-slate-800/50 hover:text-white'
                          }`}
                        title={item.label}
                      >
                        <Icon size={18} className="flex-shrink-0" />
                        {!collapsed && (
                          <>
                            {isActive(item.path) && (
                              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-white rounded-r" />
                            )}
                            {item.label}
                          </>
                        )}
                        {item.path === '/my/notifications' && unreadCount > 0 && (
                          <Badge variant="destructive" className="ml-auto text-xs px-1.5 min-w-[22px] justify-center">
                            {unreadCount}
                          </Badge>
                        )}
                      </Link>
                    )
                  })}
                  {/* Punch button in My section */}
                  {visibleNav.filter(item => item.path === '/punch').map(item => {
                    const Icon = item.icon
                    return (
                      <Link
                        key={item.path}
                        href={item.path}
                        className={`flex items-center px-3 py-2 rounded-lg text-sm transition-colors relative gap-2.5
                          ${isActive(item.path)
                            ? 'bg-brand/90 text-white font-medium shadow-sm'
                            : 'text-gray-300 hover:bg-slate-800/50 hover:text-white'
                          }`}
                        title={item.label}
                      >
                        <Icon size={18} className="flex-shrink-0" />
                        {!collapsed && item.label}
                      </Link>
                    )
                  })}
                </div>
              </div>

              {/* Divider */}
              <div className="border-t border-gray-700" />
            </>
          )}

          {/* System section */}
          <div>
            {!collapsed && (
              <div className="px-3 mb-2 text-xs uppercase text-gray-500 tracking-wider">系統</div>
            )}
            <div className="space-y-1">
              {visibleNav.filter(item => !item.path.startsWith('/my') && item.path !== '/punch').map(item => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.path}
                    href={item.path}
                    className={`flex items-center px-3.5 py-2.5 rounded-lg text-[13.5px] transition-colors gap-2.5
                      ${isActive(item.path)
                        ? 'bg-brand/90 text-white font-medium shadow-sm'
                        : 'text-gray-300 hover:bg-slate-800/50 hover:text-white'
                      }`}
                    title={item.label}
                  >
                    <Icon size={18} className="flex-shrink-0" />
                    {!collapsed && (
                      <>
                        {isActive(item.path) && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-white rounded-r" />
                        )}
                        {item.label}
                      </>
                    )}
                  </Link>
                )
              })}
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
      {/* ★ min-w-0 唔可以刪 —— flex 子項預設 min-width:auto（唔可以細過內容），
      會令闊表格（例如排班月視圖 1814px）撐大 <main>，
      內部嘅 overflow-x:auto 容器就冇嘢好捲，變成成個頁面橫捲。（2026-08-03） */}
      <main
        className={`flex-1 min-w-0 transition-[margin] duration-300 ml-0 ${collapsed ? 'md:ml-20' : 'md:ml-64'}`}
      >
        <div className="main-content pb-16 md:pb-0">
        {children}
        <PWAPrompt />
        </div>
        {/* ★ 有管理權限的 EMPLOYEE 會跌落這個 layout（見 :198），role 寫死會令兩個導覽都沒有 */}
        {hasAnyMgmtPerm && <AdminMobileNav role={user.role} grant={grant} deny={deny} />}
      </main>

      {/* Toast notifications */}
      <Toaster position="top-right" theme="light" />
    </div>
  )
}
