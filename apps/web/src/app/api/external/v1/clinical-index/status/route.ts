/**
 * GET /api/external/v1/clinical-index/status — cwi-followup-p4-20260916 S6
 *
 * 俾 wa-inbox hub「主動跟進」tab 健康警示用（MD §5.4 健康警示 5 項其中 2 項）：
 * - lastNightly： ClinicalIndexJob 最近一次 NIGHTLY（status / finishedAt / errors / lastError）
 *   → 「索引 job 昨晚失敗」判定（W 端：status=FAILED 且 finishedAt 喺 36h 內 → 警示）
 * - phoneNormalize：ClinicalRecordIndex phoneHashes 正規化率
 *   → 「電話正規化率 < 90%」判定（total=0 唔計 — 新 clinic 未跑過索引）
 *
 * scope = patients（零內容 — 只回狀態/計數，無 PII、無臨床數據）。
 */
import { type NextRequest } from "next/server";
import { withExternalAudit, requireExternalKey } from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { basePrisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/clinical-index/status', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const job = await basePrisma.clinicalIndexJob.findFirst({
      where: { kind: 'NIGHTLY' },
      orderBy: { finishedAt: 'desc' },
      select: { status: true, finishedAt: true, errors: true, lastError: true },
    })

    // phoneHashes 係 array 欄 — 正規化率 = 非空 hash 行數 / 總行數
    const [total, withHash] = await Promise.all([
      basePrisma.clinicalRecordIndex.count(),
      basePrisma.clinicalRecordIndex.count({ where: { phoneHashes: { isEmpty: false } } }),
    ])

    return jsonNoStore({
      v: 1,
      lastNightly: job
        ? {
            status: job.status,
            finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
            errors: job.errors,
            lastError: job.lastError,
          }
        : null,
      phoneNormalize:
        total === 0
          ? { total: 0, withHash: 0, rate: null }
          : { total, withHash, rate: Math.round((withHash / total) * 1000) / 1000 },
    })
  })
}
