import { NextResponse } from 'next/server'

/**
 * GET 回應統一加 no-store。
 * ★ Next 嘅 `export const dynamic = 'force-dynamic'` 只管伺服器渲染，
 *   唔會叫瀏覽器唔好快取。PUT/POST 同 GET 共用 URL 嘅 route 尤其要小心。
 */
export const jsonNoStore = (data: any, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...(init?.headers || {}), 'Cache-Control': 'no-store, must-revalidate' },
  })
