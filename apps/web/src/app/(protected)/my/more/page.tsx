'use client'

import Link from 'next/link'
import { MY_NAV } from '@/lib/my-nav'

// ★ 2026-08-22：href/label 單一事實來源 = MY_NAV（lib/my-nav.ts），防三份清單再分家。
// ⚠️ 呢個頁額外有 emoji icon + desc，由 href 對照（唔喺共用常數放）。
// ★ 原本刻意只列五項（dashboard／班表喺底部 nav、改密碼喺其他位）——
//   filter(EXTRA) 保持五項，唔好令佢突然多咗三項。
const EXTRA: Record<string, { icon: string; desc?: string }> = {
  '/my/leave': { icon: '🏖', desc: '申請假期、查看餘額' },
  '/my/punches': { icon: '📋', desc: '查看我的打卡歷史' },
  '/my/expenses': { icon: '💰', desc: '申請雜項報銷、查看記錄' },
  '/my/face-enroll': { icon: '📸', desc: '登記/更新人臉' },
  '/my/notifications': { icon: '🔔', desc: '查看通知' },
}

const MENU = MY_NAV.filter(m => EXTRA[m.href]).map(m => ({ ...m, ...EXTRA[m.href] }))

export default function MyMorePage() {
  return (
    <div className="p-4 space-y-2">
      <h1 className="text-lg font-semibold mb-3">更多</h1>
      {MENU.map(m => (
        <Link
          key={m.href}
          href={m.href}
          className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 active:bg-accent"
        >
          <span className="text-2xl">{m.icon}</span>
          <div>
            <div className="font-medium">{m.label}</div>
            {m.desc && <div className="text-xs text-muted-foreground">{m.desc}</div>}
          </div>
        </Link>
      ))}
    </div>
  )
}
