export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import {
  runAvailabilitySync,
} from '@/lib/apricot/sync-availability'
import { runAvailabilityCacheSync } from '@/lib/apricot/sync-availability-cache'
import { getTestCallFn } from './test-call-fn'

// ============================================================
// POST /api/internal/sync-availability — cron 觸發嘅 internal sync
// Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §4（排程）
//
// ★ 唔經 RBAC/session —— shared secret（x-cron-key header）。
//   ★ 2026-08-21（cw-pta）：改用現成 APRICOT_CRON_KEY（同 /api/apricot/sync/cron
//   同一個 key）—— 唔開第二個 secret。compose 已經有 APRICOT_CRON_KEY env。
//   冇 fallback 預設值：APRICOT_CRON_KEY 未設 = 503（fail closed）。
// ★ 同步引擎 runAvailabilitySync 本身已包外層 advisory lock（776001，攞唔到
//   → { ok:false, skipped } 唔會 crash）+ 逐間 try/catch（一間失敗唔中斷其餘）。
// ★ cw-extapi-20260823-a1：同一個 cron 入口順帶跑 runAvailabilityCacheSync
//   （external API v1 數據源，today → +30 日 slot grid）—— 兩個 engine 各自
//   withApricotLock 序列化（铁律），一次 cron tick 做晒兩樣。
// ★ 🔴 只回傳結構統計（open/bookings/unknown/error + 行數）—— 零病人資料。
// ============================================================

// ─── 測試注入（acceptance only）────────────────────────────────────
// p3-acceptance.ts 注入 mock callFn 做離線 200 路徑驗證。
// 生產永遠 null → runAvailabilitySync 用預設（真 Apricot API）。
// ★ 注入點移咗去 ./test-call-fn（Next.js 14 唔允許 route.ts export 非 HTTP
//   symbol —— 直接 export 會令 next build fail；cw-pa P4 修復，行為零改變）。

/**
 * timing-safe token 比較。
 * header 為 null / 長短唔同 → 一律 false（唔好 early-return 洩漏長度資訊以外嘅東西，
 * 亦符合 spec「length mismatch 都算 fail」）。
 */
function safeTokenEqual(header: string | null, expected: string): boolean {
  if (!header) return false
  const a = Buffer.from(header, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  // ★ 同 /api/apricot/sync/cron 用同一個 key —— 唔好開第二個 secret（cw-pta spec §1.3）
  const expected = process.env.APRICOT_CRON_KEY
  if (!expected) {
    console.error('[sync-availability] APRICOT_CRON_KEY 未設')
    return NextResponse.json({ error: 'cron key not configured' }, { status: 503 })
  }
  if (!safeTokenEqual(req.headers.get('x-cron-key'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const t0 = Date.now()
  const hook = getTestCallFn()
  const outcome = await runAvailabilitySync(hook ? { callFn: hook } : {})
  // ★ cw-extapi-20260823-a1：cache sync（external API v1）—— 同一 hook（test 時 mock 共用）
  const cache = await runAvailabilityCacheSync(hook ? { callFn: hook } : {})
  return NextResponse.json({ ...outcome, cache, durationMs: Date.now() - t0 })
}
