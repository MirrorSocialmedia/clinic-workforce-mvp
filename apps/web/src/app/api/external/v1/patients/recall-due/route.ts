export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { todayHK } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/patients/recall-due — D 類召回（MD §2.6 #2）
// ★ cwi-followup-p1-20260915
//
//   Query: clinicCode（必填） reasonCode（必填） months（必填，1..24）
//   Header: X-Api-Key（scope: patients）
//
//   200: { v:1, asOf, reasonCode, months, cutoff,
//          due:[{ patientApricotId, patientCode, phoneHashes, lastVisitDate }] }
//
// 邏輯：索引上 group by patient 取 max(visitDate)（MD §2.6），
// max ≤ cutoff（今日 − months 個月，日曆月、末日 clamp）→ due。
// 只讀索引（回填限制：lastVisitDate 口徑 — 見 docs/clinical-index-backfill.md）。
// 🔴 只回 phoneHashes[]；零原始電話、零 note。
// ============================================================

/** 今日 − n 個月（日曆月；1/31 − 1 個月 → 12/31 clamp）。 */
export function monthsAgoStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1 - n, d))
  if (base.getUTCDate() !== d) base.setUTCDate(0) // 溢出 → 上個月末日
  return base.toISOString().slice(0, 10)
}

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/patients/recall-due', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const params = new URL(req.url).searchParams
    const clinicCode = (params.get('clinicCode') ?? '').trim()
    const reasonCode = (params.get('reasonCode') ?? '').trim()
    const months = Number(params.get('months'))
    if (!clinicCode) throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
    if (!reasonCode) throw new ExternalApiError(400, 'reasonCode required', 'BAD_REQUEST')
    if (!Number.isInteger(months) || months < 1 || months > 24) {
      throw new ExternalApiError(400, 'months must be an integer 1..24', 'BAD_REQUEST')
    }

    const clinic = await basePrisma.clinic.findFirst({
      where: { OR: [{ shortName: clinicCode }, { id: clinicCode }] },
      select: { id: true },
    })
    if (!clinic) throw new ExternalApiError(404, 'clinic not found', 'NOT_FOUND')

    const asOf = todayHK()
    const cutoff = monthsAgoStr(asOf, months)

    // group by patient → max(visitDate)（只取必要欄；行數 = 該 reason 全部歷史）
    const rows = await basePrisma.clinicalRecordIndex.findMany({
      where: {
        clinicId: clinic.id,
        visitReasonCodes: { has: reasonCode },
        visitDate: { lte: new Date(`${asOf}T00:00:00Z`) },
      },
      orderBy: { visitDate: 'desc' },
      select: {
        patientApricotId: true,
        patientCode: true,
        phoneHashes: true,
        visitDate: true,
      },
    })
    const maxByPatient = new Map<string, { maxRow: (typeof rows)[number]; hashes: Set<string> }>()
    for (const r of rows) {
      const e = maxByPatient.get(r.patientApricotId)
      if (!e) {
        maxByPatient.set(r.patientApricotId, { maxRow: r, hashes: new Set(r.phoneHashes) }) // desc → 首見即 max
      } else {
        for (const h of r.phoneHashes) e.hashes.add(h) // phoneHashes = 全部行 union（max 行可能空）
      }
    }

    const due = [...maxByPatient.values()]
      .filter(e => e.maxRow.visitDate.toISOString().slice(0, 10) <= cutoff)
      .sort((a, b) => a.maxRow.visitDate.toISOString().localeCompare(b.maxRow.visitDate.toISOString())) // 最舊（最急）排前

    return jsonNoStore({
      v: 1,
      asOf,
      reasonCode,
      months,
      cutoff,
      due: due.map(e => ({
        patientApricotId: e.maxRow.patientApricotId,
        patientCode: e.maxRow.patientCode,
        phoneHashes: [...e.hashes],
        lastVisitDate: e.maxRow.visitDate.toISOString().slice(0, 10),
      })),
    })
  })
}
