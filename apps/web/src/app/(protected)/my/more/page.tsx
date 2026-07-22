'use client'

import Link from 'next/link'

const MENU = [
  { href: '/my/leave', label: '假期', icon: '🏖', desc: '申請假期、查看餘額' },
  { href: '/my/punches', label: '打卡記錄', icon: '📋', desc: '查看我的打卡歷史' },
  { href: '/my/face-enroll', label: '人臉登記', icon: '📸', desc: '登記/更新人臉' },
  { href: '/my/notifications', label: '通知', icon: '🔔', desc: '查看通知' },
]

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
