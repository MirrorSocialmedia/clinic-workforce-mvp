export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { runAvailabilityHistorySync } from '@/lib/apricot/sync-availability-cache'
import { getTestCallFn } from '../sync-availability/test-call-fn'

// ============================================================
// POST /api/internal/sync-availability-history — 低頻 history sync
// ★ cwc-rdchain-20260823-a1（read-chain MD §3.2）
//
// 每晚 03:00 cron 觸發（scripts/sync-availability-history.sh + crontab 行，
// 掛現有 cron 機制 — 同 /api/internal/sync-availability 同一入路 pattern）。
//
// 範圍 -7 → 昨日，只追 status 變化（0→4／負數）：
// AppointmentIndex / PatientIndex upsert（withApricotLock 照鎖，六店順序）。
// AvailabilityCache 唔寫歷史日（偏離已註記 — 過去 slot grid 無 consumer，
// 15 分鐘全範圍 run 每次都會先剷走歷史 cache 行）。
//
// ★ 守門同 sibling 完全一致：唔經 RBAC/session —— shared secret
//   （x-cron-key header，APRICOT_CRON_KEY；key 未設 = 503 fail closed，
//   唔啱 = 403）。
// ★ 🔴 只回傳結構統計（indexRows/error）—— 零病人資料。
// ============================================================

function safeTokenEqual(header: string | null, expected: string): boolean {
  if (!header) return false
  const a = Buffer.from(header, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const expected = process.env.APRICOT_CRON_KEY
  if (!expected) {
    console.error('[sync-availability-history] APRICOT_CRON_KEY 未設')
    return NextResponse.json({ error: 'cron key not configured' }, { status: 503 })
  }
  if (!safeTokenEqual(req.headers.get('x-cron-key'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const t0 = Date.now()
  const hook = getTestCallFn()
  const outcome = await runAvailabilityHistorySync(hook ? { callFn: hook } : {})
  return NextResponse.json({ ...outcome, durationMs: Date.now() - t0 })
}
