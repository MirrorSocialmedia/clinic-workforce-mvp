/**
 * ★ 2026-08-22：「我的」清單單一事實來源（MY_NAV）。
 *
 * 之前三處硬編碼（mobile-more / my/more / layout navItems），
 * 加一頁要改三處，實際漏咗兩次（雜費入口）。
 * ⚠️ 加新頁只改呢度；三個消費者各自補自己需要嘅欄：
 *   - mobile-more/page.tsx「我的」區 → 直接 MY_NAV.map（只需 href/label）
 *   - my/more/page.tsx            → MY_NAV.filter(EXTRA)（額外有 emoji icon + desc，由 href 對照）
 *   - layout.tsx navItems         → MY_NAV.map + MY_ICONS（額外有 icon component，fallback ClipboardList）
 *
 * ⚠️ my/more 刻意只列五項（dashboard／schedule 喺底部 nav、改密碼喺其他位）——
 *    用 EXTRA filter 保持五項，唔好令佢變晒晒 MY_NAV 八項。
 * ⚠️ `as const` 令 MY_NAV readonly：展開（...MY_NAV）/ .map 冇問題，.push 會 TS error（好事）。
 */
export const MY_NAV = [
  { href: '/my/dashboard', label: '我的首頁' },
  { href: '/my/schedule', label: '我的班表' },
  { href: '/my/leave', label: '我的假期' },
  { href: '/my/punches', label: '我的打卡記錄' },
  { href: '/my/expenses', label: '雜項報銷' },
  { href: '/my/face-enroll', label: '人臉登記' },
  { href: '/my/notifications', label: '通知' },
  { href: '/my/change-password', label: '修改密碼' },
] as const

export type MyNavItem = (typeof MY_NAV)[number]
export type MyNavHref = MyNavItem['href']
