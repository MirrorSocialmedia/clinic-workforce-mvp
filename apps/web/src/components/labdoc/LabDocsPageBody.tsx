'use client'

/**
 * ★ cwm-labdoc P1（CHUNK 6）：/lab-docs 頁面 body（兩個 route 共用）
 *
 * - /lab-docs?tab=archive ｜ /lab-docs/archive 兩入口（Kairo subtask 明確要 /lab-docs/archive route）
 * - 分頁記住：URL ?tab= 優先；冇就 localStorage（try/catch — §12.1）；再冇 = 到貨單
 * - /api/me 攞 role/grant/deny → LabDocsTabs 做 §10.2 gate（冇權限 = 403 提示）
 */

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import LabDocsTabs, { type LabDocTab, type LabDocsMe } from './LabDocsTabs'

const LS_KEY = 'labdocs-tab'

function readStoredTab(): LabDocTab | null {
  try {
    const s = localStorage.getItem(LS_KEY)
    return s === 'archive' || s === 'invoices' ? s : null
  } catch {
    return null
  }
}

function Body({ mode }: { mode: 'main' | 'archive' }) {
  const router = useRouter()
  const sp = useSearchParams()
  const [me, setMe] = useState<LabDocsMe | null>(null)
  const [meErr, setMeErr] = useState(false)

  const urlTab: LabDocTab | null =
    sp?.get('tab') === 'archive' ? 'archive' : sp?.get('tab') === 'invoices' ? 'invoices' : null

  const [tab, setTab] = useState<LabDocTab>(() =>
    mode === 'archive' ? 'archive' : urlTab ?? readStoredTab() ?? 'invoices',
  )

  // URL 改動（back/forward、深連結）→ 跟 URL
  useEffect(() => {
    if (mode !== 'archive' && urlTab) setTab(urlTab)
  }, [mode, urlTab])

  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) {
          setMeErr(true)
          return
        }
        const d = await r.json()
        setMe({ role: d.user.role, grant: d.user.grant ?? [], deny: d.user.deny ?? [] })
      })
      .catch(() => setMeErr(true))
  }, [])

  const onTabChange = useCallback(
    (t: LabDocTab) => {
      if (mode === 'archive') {
        // archive route 上撳「到貨單」→ 跳返主頁
        if (t === 'invoices') router.replace('/lab-docs')
        return
      }
      setTab(t)
      try {
        localStorage.setItem(LS_KEY, t)
      } catch {
        /* private mode */
      }
      // ?tab= 保持 URL 與顯示一致（deep-linkable）
      if (t === 'archive') router.replace('/lab-docs?tab=archive')
      else router.replace('/lab-docs')
    },
    [mode, router],
  )

  if (meErr) {
    return (
      <div className="flex justify-center py-16 text-sm text-muted-foreground">
        登入狀態過期，請重新登入
      </div>
    )
  }
  if (!me) {
    return (
      <div className="flex justify-center py-16 text-sm text-muted-foreground">載入中…</div>
    )
  }

  return <LabDocsTabs me={me} tab={tab} fixedArchive={mode === 'archive'} onTabChange={onTabChange} />
}

export default function LabDocsPageBody({ mode }: { mode: 'main' | 'archive' }) {
  // useSearchParams 要 Suspense 包（Next 15 靜態渲染要求）
  return (
    <Suspense fallback={<div className="flex justify-center py-16 text-sm text-muted-foreground">載入中…</div>}>
      <Body mode={mode} />
    </Suspense>
  )
}
