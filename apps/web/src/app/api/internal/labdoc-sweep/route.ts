export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { runLabDocSweep } from '@/lib/labdoc/extract'

// ============================================================
// POST /api/internal/labdoc-sweep — 讀單背景工作 sweep（§5.1）
// ★ cwm-labdoc P2 — cron 每 5 分鐘觸發（scripts/README-CRONTAB.md）
//
//  - EXTRACTING AND heartbeatAt < now-5min → 當失敗
//    （attempts+1；=3 → EXTRACT_FAILED；<3 → 回 UPLOADED 30 秒後重讀）
//  - UPLOADED AND createdAt < now-2min → 再觸發
//  - EXTRACT_FAILED 唔會自動再試（T17）— 人手 POST /api/lab-docs/:id/retry
//
// 守門同 labdoc-purge 完全一致（x-cron-key / APRICOT_CRON_KEY；
// key 未設 = 503 fail closed，唔啱 = 403）。
// 🔴 只回結構計數 — 零單據內容。
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
    console.error('[labdoc-sweep] APRICOT_CRON_KEY 未設')
    return NextResponse.json({ error: 'cron key not configured' }, { status: 503 })
  }
  if (!safeTokenEqual(req.headers.get('x-cron-key'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // e2e/dev hook：x-cron-now（只在已過 cron key 守門之後先生效；生產 cron 唔傳）
  const nowHeader = req.headers.get('x-cron-now')
  const now = nowHeader ? new Date(nowHeader) : new Date()

  const result = await runLabDocSweep(now)
  return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } })
}
