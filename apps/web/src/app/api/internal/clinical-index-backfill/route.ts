export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { runClinicalIndexBackfill } from '@/lib/clinical-index/backfill'
import { runExclusive } from '@/lib/clinical-index/job-lock'
import { getTestCallFn } from '../clinical-index/test-call-fn'

// ============================================================
// POST /api/internal/clinical-index-backfill — 365 日回填（MD §2.5）
//
// 一次性 4 晚：每晚 ≤90 日（cursorDate 續）；maxCalls=30000 + maxHours=4
// 護欄；APRICOT_RATE_LIMITED / APRICOT_BUSY → 停當晚第二晚續。
// 守門同 sibling 一致（x-cron-key / APRICOT_CRON_KEY）。
// ★ cwi-qa FX-30：job 級排他鎖 — 並發（cron + 手動 curl）→ 409 ALREADY_RUNNING；
//   DONE 後唔自動開新一輪 — 要 ?restart=1（cron key 守門之内）先重開。
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
  // ★ cwi-qa FX-30：?restart=1 先開新一輪（喺 cron key 守門之後先讀 — 無 key 觸發唔到）
  const restart = req.nextUrl.searchParams.get('restart') === '1'
  const r = await runExclusive('BACKFILL', () =>
    runClinicalIndexBackfill(hook ? { callFn: hook, now, restart } : { now, restart }),
  )
  if (r.running) {
    return NextResponse.json({ error: 'ALREADY_RUNNING' }, { status: 409 })
  }
  return NextResponse.json(r.result)
}
