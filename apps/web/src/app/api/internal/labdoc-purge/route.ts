export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { runLabDocPurge } from '@/lib/labdoc/purge'

// ============================================================
// POST /api/internal/labdoc-purge — Lab 單據保留 purge（B8，§4.4）
// ★ cwm-labdoc P1 — 每晚 03:30 cron 觸發（scripts/README-CRONTAB.md）
//
// 7 年保留（purgeAt = uploadedAt + 7 年）到期：逐個檔刪碟上全部 key
// （原檔＋顯示圖＋縮圖，全部 AES-256-GCM 加密落地）→ purgedAt = now；
// 單據**所有頁**檔都 purged 先清 PII 姓名欄（金額／單號／病人編號保留）。
// 孤兒 sweep（§4.1，碟有 DB 冇 >24h）併入同一 run（gen1 決定 4）。
// 冪等：逐個檔條件 commit；中途死咗下次接住做（T16）。
// 守門同 clinical-index-nightly 完全一致（x-cron-key / APRICOT_CRON_KEY；
// key 未設 = 503 fail closed，唔啱 = 403）。
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
    console.error('[labdoc-purge] APRICOT_CRON_KEY 未設')
    return NextResponse.json({ error: 'cron key not configured' }, { status: 503 })
  }
  if (!safeTokenEqual(req.headers.get('x-cron-key'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // e2e/dev hook：x-cron-now（只在已過 cron key 守門之後先生效；生產 cron 唔傳）
  const nowHeader = req.headers.get('x-cron-now')
  const now = nowHeader ? new Date(nowHeader) : new Date()
  if (Number.isNaN(now.getTime())) {
    return NextResponse.json({ error: 'bad x-cron-now' }, { status: 400 })
  }

  const outcome = await runLabDocPurge({ now })
  return NextResponse.json(outcome)
}
