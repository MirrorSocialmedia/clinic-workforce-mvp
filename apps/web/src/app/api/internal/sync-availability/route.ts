export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import {
  runAvailabilitySync,
  type ApricotCallFn,
} from '@/lib/apricot/sync-availability'

// ============================================================
// POST /api/internal/sync-availability — cron 觸發嘅 internal sync
// Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §4（排程）
//
// ★ 唔經 RBAC/session —— shared secret（X-Internal-Token header）。
//   冇 fallback 預設值：INTERNAL_SYNC_TOKEN 未設 = 503（fail closed）。
// ★ 同步引擎 runAvailabilitySync 本身已包外層 advisory lock（776001，攞唔到
//   → { ok:false, skipped } 唔會 crash）+ 逐間 try/catch（一間失敗唔中斷其餘）。
// ★ 🔴 只回傳結構統計（open/bookings/unknown/error + 行數）—— 零病人資料。
// ============================================================

// ─── 測試注入（acceptance only）────────────────────────────────────
// p3-acceptance.ts 注入 mock callFn 做離線 200 路徑驗證。
// 生產永遠 null → runAvailabilitySync 用預設（真 Apricot API）。
let testCallFn: ApricotCallFn | null = null
export function __setTestCallFn(fn: ApricotCallFn | null): void {
  testCallFn = fn
}

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
  const expected = process.env.INTERNAL_SYNC_TOKEN
  if (!expected) {
    console.error('[sync-availability] INTERNAL_SYNC_TOKEN 未設')
    return NextResponse.json({ error: 'sync token not configured' }, { status: 503 })
  }
  if (!safeTokenEqual(req.headers.get('x-internal-token'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const t0 = Date.now()
  const outcome = await runAvailabilitySync(testCallFn ? { callFn: testCallFn } : {})
  return NextResponse.json({ ...outcome, durationMs: Date.now() - t0 })
}
