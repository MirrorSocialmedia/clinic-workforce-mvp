'use client'

/**
 * ★ cwm-labdoc P1（CHUNK 6）：/lab-docs 分頁 shell（§12.1、§10.5、gen1 決定 2）
 *
 * - P1 兩個分頁：到貨單｜檔案庫（月結單／待處理 P2/P3 先開）
 * - 權限 gate（§10.2）：要有 lab_invoice 或 lab_statement 先見到內容；
 *   冇權限直接撳入 URL → 顯示 403 提示（API 層亦會 403）
 * - 選單入口：layout.tsx / mobile-more/page.tsx（perm: ['lab_invoice','lab_statement']）
 */

import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { hasPermission } from '@/lib/permissions'
import InvoiceList from './InvoiceList'
import ArchiveList from './ArchiveList'

export type LabDocTab = 'invoices' | 'archive'

export interface LabDocsMe {
  role: string
  grant: string[]
  deny: string[]
}

interface Props {
  me: LabDocsMe
  tab: LabDocTab
  /** /lab-docs/archive route：內容固定 archive；撳「到貨單」由 page 層 router.replace('/lab-docs') */
  fixedArchive?: boolean
  onTabChange: (t: LabDocTab) => void
}

export default function LabDocsTabs({ me, tab, fixedArchive, onTabChange }: Props) {
  const [clinicNames, setClinicNames] = useState<Record<string, string>>({})
  const [providerNames, setProviderNames] = useState<Record<string, string>>({})

  // 名稱對照（graceful：失敗就「未識別」）
  useEffect(() => {
    let alive = true
    apiFetch<{ clinics: Array<{ id: string; name: string }> }>('/api/clinics')
      .then((d) => alive && setClinicNames(Object.fromEntries((d.clinics || []).map((c) => [c.id, c.name]))))
      .catch(() => { /* graceful */ })
    apiFetch<{ providers: Array<{ id: string; name: string }> }>('/api/providers')
      .then((d) => alive && setProviderNames(Object.fromEntries((d.providers || []).map((p) => [p.id, p.name]))))
      .catch(() => { /* graceful */ })
    return () => { alive = false }
  }, [])

  // §10.2：lab_invoice 或 lab_statement 都有得用（檔案庫、睇檔、下載、上傳 ✅✅）
  const allowed =
    hasPermission(me.role, 'lab_invoice', me.grant, me.deny) ||
    hasPermission(me.role, 'lab_statement', me.grant, me.deny)

  if (!allowed) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center gap-3 py-20 text-center">
        <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center">
          <ShieldAlert size={28} className="text-red-500" />
        </div>
        <h2 className="text-lg font-semibold">冇權限</h2>
        <p className="text-sm text-muted-foreground">
          查看 Lab 單據需要 <code className="bg-muted px-1 py-0.5 rounded">lab_invoice</code> 或{' '}
          <code className="bg-muted px-1 py-0.5 rounded">lab_statement</code> 權限。
          請聯絡經理喺帳號管理開通。
        </p>
      </div>
    )
  }

  const tabCls = (active: boolean) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      active ? 'bg-brand text-white' : 'bg-card border text-muted-foreground hover:bg-accent'
    }`

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-bold">Lab 單據</h1>
        <p className="text-sm text-muted-foreground mt-0.5">到貨單上傳同檔案庫（存底 7 年）</p>
      </div>

      {/* 分頁（§12.1：P1 = 到貨單｜檔案庫）— archive route 上撳「到貨單」= 跳 /lab-docs（page 層處理） */}
      <div className="flex gap-2">
        <button className={tabCls(tab === 'invoices')} onClick={() => onTabChange('invoices')}>
          到貨單
        </button>
        <button className={tabCls(tab === 'archive')} onClick={() => onTabChange('archive')}>
          檔案庫
        </button>
      </div>

      {tab === 'invoices' ? (
        <InvoiceList clinicNames={clinicNames} providerNames={providerNames} />
      ) : (
        <ArchiveList clinicNames={clinicNames} providerNames={providerNames} />
      )}
    </div>
  )
}
