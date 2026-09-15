export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { runClinicalIndexBackfill } from '@/lib/clinical-index/backfill'
import { getTestCallFn } from '../clinical-index/test-call-fn'

// ============================================================
// POST /api/internal/clinical-index-backfill — 365 日回填（MD §2.5）
//
// 一次性 4 晚：每晚 ≤90 日（cursorDate 續）；maxCalls=30000 + maxHours=4
// 護欄；APRICOT_RATE_LIMITED → 停當晚第二晚續。
// 守門同 sibling 一致（x-cron-key / APRICOT_CRON_KEY）。
// 🔴 只回結構統計 — 零病人資料。
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
    console.error('[clinical-index-backfill] APRICOT_CRON_KEY 未設')
    return NextResponse.json({ error: 'cron key not configured' }, { status: 503 })
  }
  if (!safeTokenEqual(req.headers.get('x-cron-key'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const hook = getTestCallFn()
  // e2e/dev hook：x-cron-now（只在已過 cron key 守門之後先生效；生產 cron 唔傳）
  const nowHeader = req.headers.get('x-cron-now')
  const now = nowHeader ? new Date(nowHeader) : new Date()
  const outcome = await runClinicalIndexBackfill(hook ? { callFn: hook, now } : { now })
  return NextResponse.json(outcome)
}
