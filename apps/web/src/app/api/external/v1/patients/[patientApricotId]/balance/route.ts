export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { todayHK } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/patients/{patientApricotId}/balance — F 類 + 側欄
// （MD §2.6 #6）— cwi-followup-p1-20260915
//
//   200: { v:1, patientCode, asOf, balance:{ ttlAmt, osAmt }, syncedAt }
//   404: PATIENT_NOT_FOUND（無索引行）
//
// 讀最新 past 索引行（≤ today）嘅 billTtlAmt / billOsAmt（P1 口徑 =
// 該次到訪當日非 void bill 合計 — 見 progress 設計決定 #3）。
// 🔴 零電話（病人已鎖定）、零 note。
// ============================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ patientApricotId: string }> },
) {
  return withExternalAudit(req, '/api/external/v1/patients/[patientApricotId]/balance', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const { patientApricotId } = await params
    const row = await basePrisma.clinicalRecordIndex.findFirst({
      where: {
        patientApricotId,
        visitDate: { lte: new Date(`${todayHK()}T00:00:00Z`) },
      },
      orderBy: { visitDate: 'desc' },
    })
    if (!row) throw new ExternalApiError(404, 'patient not found', 'PATIENT_NOT_FOUND')

    return jsonNoStore({
      v: 1,
      patientCode: row.patientCode,
      asOf: row.visitDate.toISOString().slice(0, 10),
      balance: { ttlAmt: row.billTtlAmt, osAmt: row.billOsAmt },
      syncedAt: row.syncedAt.toISOString(),
    })
  })
}
