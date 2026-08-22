'use client'

import { useEffect, useState } from 'react'
import { hasPermission } from '@/lib/permissions'

/**
 * ★ 2026-08-22：頁面層權限 gate（cw-pagateg-20260822-a1）。
 *   側欄 navItems 有 roles/perm，但直接打網址繞得過 —— 呢個補返中間層。
 *   ⚠️ API 側仍然係最後防線，呢個只係「唔好畀人入到」。
 *
 * 用法（★一定要拆 Inner，hooks 唔可以有條件執行）：
 *   export default function XxxPage() {
 *     return <RequireRole roles={['OWNER']} perms={[...]}>
 *       <XxxPageInner />
 *     </RequireRole>
 *   }
 *
 * 行為：
 *   - loading 時 return null（★唔 render children，唔好閃內容，唔好發 API request）
 *   - roleOk || permOk 先 render（同 require-auth.ts 語義一致）
 *   - perm 判斷用 hasPermission（含 ROLE_DEFAULTS，deny 優先）—— 同全站同一套
 *   - /api/me 失敗 → denied（fail-closed）
 *   - denied 時 Inner 根本唔會 mount → 零 API request（MD 驗收 #2 核心價值）
 */
export function RequireRole({
  roles, perms, onLoad, children,
}: {
  roles?: string[]
  perms?: string[]
  /** fetch /api/me 成功後調一次（fail-closed：失敗唔會調，role 攞唔到 = 攞唔到） */
  onLoad?: (u: { role: string; grant: string[]; deny: string[] }) => void
  children: React.ReactNode
}) {
  const [state, setState] = useState<'loading' | 'ok' | 'denied'>('loading')

  useEffect(() => {
    let live = true
    fetch('/api/me', { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!live) return
        const role: string = d?.user?.role ?? ''
        const grant: string[] = d?.user?.grant ?? []
        const deny: string[] = d?.user?.deny ?? []
        const roleOk = !roles || roles.includes(role)
        // ★ MD §2.2：用 hasPermission（同全站同一套判斷，唔會分家）
        const permOk = !perms || perms.some(p => hasPermission(role, p as any, grant, deny))
        onLoad?.({ role, grant, deny })
        setState(roleOk || permOk ? 'ok' : 'denied')
      })
      .catch(() => { if (live) setState('denied') })
    return () => { live = false }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ★ loading 時唔好 render children（會閃真實內容而且會發 API request）
  if (state === 'loading') return null
  if (state === 'denied') {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <div style={{ fontSize: 15, color: '#b45309', marginBottom: 6 }}>⚠️ 冇權限</div>
        <div style={{ fontSize: 13, color: '#94a3b8' }}>呢個頁面需要更高權限</div>
      </div>
    )
  }
  return <>{children}</>
}
