export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { runClinicalIndexNightly } from '@/lib/clinical-index/nightly'
import { getTestCallFn } from '../clinical-index/test-call-fn'

// ============================================================
// POST /api/internal/clinical-index-nightly — 臨床索引夜跑
// ★ cwi-followup-p1-20260915（MD §2.3）— 每晚 03:00 cron 觸發
//
// 昨日 scan（page size 50 固定）+ 逐病人 3 call + 未來 7 日 + 7 日重掃。
// 守門同 sync-availability-history 完全一致（x-cron-key / APRICOT_CRON_KEY；
// key 未設 = 503 fail closed，唔啱 = 403）。
// 🔴 只回結構統計 — 零病人資料（零原始電話、零 note 內容）。
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
    console.error('[clinical-index-nightly] APRICOT_CRON_KEY 未設')
    return NextResponse.json({ error: 'cron key not configured' }, { status: 503 })
  }
  if (!safeTokenEqual(req.headers.get('x-cron-key'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const hook = getTestCallFn()
  // e2e/dev hook：x-cron-now（只在已過 cron key 守門之後先生效；生產 cron 唔傳）
  const nowHeader = req.headers.get('x-cron-now')
  const now = nowHeader ? new Date(nowHeader) : new Date()
  const outcome = await runClinicalIndexNightly(hook ? { callFn: hook, now } : { now })
  return NextResponse.json(outcome)
}
