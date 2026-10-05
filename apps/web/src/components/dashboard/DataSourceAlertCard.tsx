'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, XCircle } from 'lucide-react'

/**
 * ★ cwm-datasource-20261003：資料來源憑證警告（老闆儀表板頂）
 * 憑證失效／就快過期／超過一日冇成功連線 → 紅／黃條，撳入「資料來源」更新。冇問題就唔出。
 */
export function DataSourceAlertCard() {
  const [alerts, setAlerts] = useState<{ displayName: string; level: 'warn' | 'error'; text: string }[]>([])

  useEffect(() => {
    fetch('/api/apricot-sources/health', { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { alerts: [] }))
      .then(d => setAlerts(d.alerts || []))
      .catch(() => setAlerts([]))
  }, [])

  if (!alerts.length) return null
  return (
    <div className="space-y-2">
      {alerts.map(a => {
        const err = a.level === 'error'
        const Icon = err ? XCircle : AlertTriangle
        return (
          <Link key={a.displayName} href="/data-sources"
            className={`flex items-center gap-2 text-sm px-4 py-3 rounded-lg border ${err ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
            <Icon size={16} className="shrink-0" />
            <span className="flex-1"><b>{a.displayName}</b> 資料來源：{a.text}{err ? ' —— 病人搜尋、收款同步、醫生時間表會讀唔到' : ''}</span>
            <span className="text-xs underline shrink-0">去更新 →</span>
          </Link>
        )
      })}
    </div>
  )
}
