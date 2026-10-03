'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { toHKDateStr } from '@/lib/hk-date'
import { probationDueList, probationDueLabel, type ProbationDue } from '@/lib/probation'

/**
 * ★ cwm-probation-20261003：試用期將滿提醒（儀表板／待辦共用）
 * 列最後一日喺「今日 −14 ～ +30 日」嘅在職員工；冇人就唔出卡。
 * compact = 待辦頁 section 樣式（唔包 Card）。
 */
export function ProbationDueCard({ compact = false }: { compact?: boolean }) {
  const [items, setItems] = useState<ProbationDue[] | null>(null)

  useEffect(() => {
    fetch('/api/employees?all=1', { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { employees: [] }))
      .then(d => {
        const emps = Array.isArray(d) ? d : (d.employees || [])
        setItems(probationDueList(emps, toHKDateStr(new Date())))
      })
      .catch(() => setItems([]))
  }, [])

  if (!items || items.length === 0) return null

  const list = (
    <div className="space-y-1.5">
      {items.map(p => {
        const urgent = p.daysLeft <= 7
        const passed = p.daysLeft < 0
        return (
          <Link key={p.id} href={`/employees/${p.id}/overview`}
            className="flex items-center justify-between gap-2 text-sm px-3 py-2 rounded-lg border hover:bg-muted/40"
            style={{ borderColor: passed ? '#e5e7eb' : urgent ? '#fca5a5' : '#fde68a', background: passed ? undefined : urgent ? '#fef2f2' : '#fffbeb' }}>
            <span className="min-w-0">
              <span className="font-medium">{p.name}</span>
              {p.clinicName && <span className="ml-1 text-xs text-muted-foreground">{p.clinicName}</span>}
              <span className="ml-1 text-xs text-muted-foreground">· {p.joinDate} 入職</span>
            </span>
            <span className="text-xs shrink-0" style={{ color: passed ? '#6b7280' : urgent ? '#b91c1c' : '#92400e' }}>
              {probationDueLabel(p)}
            </span>
          </Link>
        )
      })}
      <div className="text-[11px] text-muted-foreground">
        試用期 = 入職起 3 個月。滿之前記得評估（確認轉正／延長／終止），同埋通知員工。
      </div>
    </div>
  )

  if (compact) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          ⏳ 試用期將滿 ({items.length})
        </h2>
        {list}
      </section>
    )
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">⏳ 試用期將滿（{items.length}）</CardTitle>
      </CardHeader>
      <CardContent>{list}</CardContent>
    </Card>
  )
}
