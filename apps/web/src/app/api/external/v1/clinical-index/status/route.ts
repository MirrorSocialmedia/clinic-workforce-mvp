/**
 * GET /api/external/v1/clinical-index/status — cwi-followup-p4-20260916 S6
 *
 * 俾 wa-inbox hub「主動跟進」tab 健康警示用（MD §5.4 健康警示 5 項其中 2 項）：
 * - lastNightly： ClinicalIndexJob 最近一次 NIGHTLY（status / finishedAt / errors / lastError）
 *   → 「索引 job 昨晚失敗」判定（W 端：status=FAILED 且 finishedAt 喺 36h 內 → 警示）
 *   ★ cwi-qa FX-30：RUNNING > 6 小時 = deploy 殺 request 殘留 → 回報當 FAILED（ABANDONED）
 * - phoneNormalize：ClinicalRecordIndex phoneHashes 正規化率
 *   → 「電話正規化率 < 90%」判定（total=0 唔計 — 新 clinic 未跑過索引）
 * - backfill：★ cwi-qa FX-30 回填進度欄（cursor / 日數進度 / apiCalls — 運維睇進度用）
 *
 * scope = patients（零內容 — 只回狀態/計數，無 PII、無臨床數據）。
 */
import { type NextRequest } from "next/server";
import { withExternalAudit, requireExternalKey } from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { basePrisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const DAY_MS = 86_400_000
// ★ cwi-qa FX-30：同 nightly 補掃口徑一致（RUNNING > 6h = 已死）
const STALE_RUNNING_MS = 6 * 3_600_000
const iso = (dt: Date | null): string | null => (dt ? dt.toISOString() : null)

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/clinical-index/status', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const [job, backfillJob] = await Promise.all([
      basePrisma.clinicalIndexJob.findFirst({
        where: { kind: 'NIGHTLY', account: 'MAIN' }, // ★ cwm-apricotty：頂層 = 原帳號（舊口徑）；其他帳號見 accounts[]
        orderBy: { finishedAt: 'desc' },
        select: { status: true, finishedAt: true, startedAt: true, errors: true, lastError: true },
      }),
      basePrisma.clinicalIndexJob.findFirst({
        where: { kind: 'BACKFILL', account: 'MAIN' },
        orderBy: { startedAt: 'desc' },
        select: {
          status: true, rangeFrom: true, rangeTo: true, cursorDate: true,
          patients: true, apiCalls: true, errors: true, lastError: true,
          startedAt: true, finishedAt: true,
        },
      }),
    ])

    // ★ cwi-qa FX-30：RUNNING > 6 小時 = deploy 殺 request 殘留（finally 冇行）→ 回報當失敗，唔好當「進行中」瞞人
    let nightlyStatus = job?.status ?? null
    let nightlyLastError = job?.lastError ?? null
    if (job && job.status === 'RUNNING' && job.startedAt && Date.now() - job.startedAt.getTime() > STALE_RUNNING_MS) {
      nightlyStatus = 'FAILED'
      nightlyLastError = 'ABANDONED (RUNNING > 6h)'
    }

    // 回填進度：日數口徑（cursorDate = 下一個未處理日 → 已完成日數 = cursor - rangeFrom）
    let backfillOut: Record<string, unknown> | null = null
    if (backfillJob) {
      const totalDays = Math.max(1, Math.round((backfillJob.rangeTo.getTime() - backfillJob.rangeFrom.getTime()) / DAY_MS))
      const doneDays =
        backfillJob.status === 'DONE'
          ? totalDays
          : Math.min(totalDays, Math.max(0, Math.round((((backfillJob.cursorDate ?? backfillJob.rangeTo).getTime()) - backfillJob.rangeFrom.getTime()) / DAY_MS)))
      backfillOut = {
        status: backfillJob.status,
        rangeFrom: iso(backfillJob.rangeFrom),
        rangeTo: iso(backfillJob.rangeTo),
        cursorDate: iso(backfillJob.cursorDate),
        daysTotal: totalDays,
        daysDone: doneDays,
        progressPct: Math.round((doneDays / totalDays) * 1000) / 10,
        patients: backfillJob.patients,
        apiCalls: backfillJob.apiCalls,
        errors: backfillJob.errors,
        lastError: backfillJob.lastError,
        startedAt: iso(backfillJob.startedAt),
        finishedAt: iso(backfillJob.finishedAt),
      }
    }

    // phoneHashes 係 array 欄 — 正規化率 = 非空 hash 行數 / 總行數
    const [total, withHash] = await Promise.all([
      basePrisma.clinicalRecordIndex.count(),
      basePrisma.clinicalRecordIndex.count({ where: { phoneHashes: { isEmpty: false } } }),
    ])

    // ★ cwm-apricotty-20261001：其他 Apricot 帳號（青衣 TY…）摘要 — additive，舊 consumer 唔受影響
    const otherAccounts = (await basePrisma.clinicalIndexJob.findMany({
      where: { account: { not: 'MAIN' } }, select: { account: true }, distinct: ['account'],
    })).map(r => r.account)
    const accounts = await Promise.all(otherAccounts.map(async (account) => {
      const [n, b] = await Promise.all([
        basePrisma.clinicalIndexJob.findFirst({
          where: { kind: 'NIGHTLY', account }, orderBy: { finishedAt: 'desc' },
          select: { status: true, finishedAt: true, startedAt: true, errors: true, lastError: true },
        }),
        basePrisma.clinicalIndexJob.findFirst({
          where: { kind: 'BACKFILL', account }, orderBy: { startedAt: 'desc' },
          select: { status: true, cursorDate: true, rangeFrom: true, rangeTo: true, patients: true, lastError: true },
        }),
      ])
      const nStale = n && n.status === 'RUNNING' && n.startedAt && Date.now() - n.startedAt.getTime() > STALE_RUNNING_MS
      return {
        account,
        lastNightly: n ? { status: nStale ? 'FAILED' : n.status, finishedAt: iso(n.finishedAt), errors: n.errors, lastError: nStale ? 'ABANDONED (RUNNING > 6h)' : n.lastError } : null,
        backfill: b ? { status: b.status, rangeFrom: iso(b.rangeFrom), rangeTo: iso(b.rangeTo), cursorDate: iso(b.cursorDate), patients: b.patients, lastError: b.lastError } : null,
      }
    }))

    return jsonNoStore({
      v: 1,
      accounts,
      lastNightly: job
        ? {
            status: nightlyStatus,
            finishedAt: iso(job.finishedAt),
            startedAt: iso(job.startedAt),
            errors: job.errors,
            lastError: nightlyLastError,
          }
        : null,
      backfill: backfillOut,
      phoneNormalize:
        total === 0
          ? { total: 0, withHash: 0, rate: null }
          : { total, withHash, rate: Math.round((withHash / total) * 1000) / 1000 },
    })
  })
}
