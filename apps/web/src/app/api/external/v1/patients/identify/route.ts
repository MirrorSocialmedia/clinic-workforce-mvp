export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { identifyPatientByPhone } from '@/lib/patient-identify'

// ============================================================
// POST /api/external/v1/patients/identify — 用電話認病人（新客／舊客判定）
// cwi-patient-identify-20261017（擁有人拍板：唔使有預約、掃晒全部 Apricot 帳號）
//
//   Header: X-Api-Key（scope: patients）
//   body: { phone: string }（WhatsApp waId 或任何寫法；香港 8 位／852／內地 11 位／86）
//   200: { v:1, status:'FOUND'|'NOT_FOUND'|'PARTIAL', patients:[{ patientApricotId, patientCode,
//          patientName, source, clinicId, clinicLabel }], sources:[{ label, ok, found, error? }] }
//   400: BAD_PHONE
//
// 🔴 原始電話只喺 body（唔入 URL／log／DB）；ExternalApiAudit 只記 path／status／latency。
// 🔴 回應唔含電話；patientName 同 patient-lookup 一致（inbox 已有顯示病人名嘅權限）。
// ============================================================

export async function POST(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/patients/identify', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)
    const body = (await req.json().catch(() => null)) as { phone?: unknown } | null
    const phone = typeof body?.phone === 'string' ? body.phone : ''
    const result = phone ? await identifyPatientByPhone(phone) : null
    if (!result) throw new ExternalApiError(400, 'phone 格式認唔到', 'BAD_PHONE')
    return jsonNoStore({ v: 1, ...result })
  })
}
