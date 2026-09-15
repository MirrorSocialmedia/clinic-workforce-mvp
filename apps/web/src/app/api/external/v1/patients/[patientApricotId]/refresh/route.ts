export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import {
  takeRefreshTokens,
  refreshPatientIndex,
  ApricotUnavailableError,
} from '@/lib/clinical-index/refresh'
import { getTestCallFn } from '@/app/api/internal/clinical-index/test-call-fn'

// ============================================================
// POST /api/external/v1/patients/{patientApricotId}/refresh — 手動刷新
// （MD §2.6 #8 + §2.8）— cwi-followup-p1-20260915
//
//   200: { v:1, syncedAt, visits, balance:{ ttlAmt, osAmt } }
//   429: { error:'rate limited', code:'RATE_LIMITED', retryAfterSec }
//   404: PATIENT_NOT_FOUND（無 appointment 又無索引行）
//   503: { error:'APRICOT_UNAVAILABLE', lastSyncedAt } — 唔扮成功
//
// 四層保護（§2.8）：層 1/2 = token bucket（同 lib/clinical-index/refresh.ts）；
// 層 3 = consumer 睇 syncedAt > 24h 自動跑（本端只暴露 syncedAt）；
// 層 4 = Apricot 斷 → 503 + lastSyncedAt。
//
// 共用 upsert：refreshPatientIndex 內部 call upsertVisitIndex() — 同夜跑
// 同一個 function（鐵律 6；S7 grep 驗證）。
//
// Audit：PATIENT_RECORD_REFRESHED（staffId + cpId + 結果，零病人內容）。
// 🔴 回應零原始電話、零 note 內容。
// ============================================================

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ patientApricotId: string }> },
) {
  return withExternalAudit(req, '/api/external/v1/patients/[patientApricotId]/refresh', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const { patientApricotId: cpId } = await params
    const staffId = (req.headers.get('x-staff-id') ?? '').trim() || 'anonymous'

    // 保護 1+2：token bucket（patient 60s / clinic 20 per min）
    // clinic 層 key：最新索引行嘅 clinic；無行 → 以 cpId 做 key（每人獨立 bucket，唔會繞）
    const anyRow = await basePrisma.clinicalRecordIndex.findFirst({
      where: { patientApricotId: cpId },
      orderBy: { visitDate: 'desc' },
      select: { clinicId: true, syncedAt: true },
    })
    const clinicKey = anyRow?.clinicId ?? cpId
    const token = takeRefreshTokens(clinicKey, cpId)
    if (!token.ok) {
      throw new ExternalApiError(429, 'rate limited', 'RATE_LIMITED', { retryAfterSec: token.retryAfterSec })
    }

    const lastSyncedAt = anyRow?.syncedAt?.toISOString() ?? null
    let outcome
    try {
      // e2e/dev hook：in-process 決定性 stub（生產 getTestCallFn()=null → 真 apricotCall）
      const hook = getTestCallFn()
      outcome = await refreshPatientIndex(cpId, hook ? { callFn: hook } : {})
    } catch (e) {
      if (e instanceof ApricotUnavailableError) {
        // 保護 4：唔扮成功 — 503 + lastSyncedAt（UI 顯示「Apricot 未接通，顯示緊 {日期} 嘅資料」）
        await writeRefreshAudit(staffId, cpId, 'apricot_unavailable')
        throw new ExternalApiError(503, 'APRICOT_UNAVAILABLE', 'APRICOT_UNAVAILABLE', { lastSyncedAt })
      }
      throw e
    }

    if (!outcome.ok) {
      throw new ExternalApiError(404, 'patient not found', 'PATIENT_NOT_FOUND')
    }

    await writeRefreshAudit(staffId, cpId, 'ok', outcome.visitDate)

    return jsonNoStore({
      v: 1,
      syncedAt: outcome.syncedAt,
      visits: outcome.visits,
      balance: outcome.balance,
    })
  })
}

/** PATIENT_RECORD_REFRESHED audit（零病人內容：staffId + cpId + 結果 + 日期）。 */
async function writeRefreshAudit(staffId: string, cpId: string, result: string, visitDate?: string): Promise<void> {
  try {
    await basePrisma.auditLog.create({
      data: {
        actorId: null, // 系統身份（external API key lane）
        action: 'PATIENT_RECORD_REFRESHED',
        entity: 'ClinicalRecordIndex',
        entityId: cpId,
        notes: JSON.stringify({ staffId, patientApricotId: cpId, result, visitDate: visitDate ?? null }),
      },
    })
  } catch (err) {
    // audit 失敗唔阻回應（refresh 本身已成功）— 但必須留痕跟進
    console.error('[refresh] PATIENT_RECORD_REFRESHED audit 寫入失敗:', err)
  }
}
