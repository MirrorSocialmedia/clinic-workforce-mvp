export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import { requireExternalKey, withExternalAudit, ExternalApiError } from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/patient-lookup?phoneHash= — 病人查詢 API（read-chain MD §4.1）
// cwc-rdchain-20260823-b1
//
//   Query: phoneHash（必填，64-hex HMAC-SHA256 — 同 wa-inbox 用同一條 PHONE_HASH_KEY）
//   Header: X-Api-Key（scope: patients — §A.2 守門）
//
//   200: { v:1, matches:[{ patientApricotId, patientCode, patientName,
//          lastVisit: { date, providerName, visitReasons } | null }] }
//   多 match 全回（同一 phoneHash 可对应多病人）；零 match → 200 空陣列；
//   lastVisit = 該病人 AppointmentIndex 最近過去行（date ≤ 今日 HK 日界；冇 → null）。
//
// 🔴 Response 只係白名單 v2：id/code/fullName + visitReasons[].des。
//    raw phoneNum / HKID / address / medicalHistory 永唔出現
//    （sync 端白名單 pickup + contract test 負面 PII 斷言兜底）。
// ============================================================

const PHONE_HASH_RE = /^[0-9a-f]{64}$/i

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/patient-lookup', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const params = new URL(req.url).searchParams
    const phoneHash = (params.get('phoneHash') ?? '').trim().toLowerCase()
    if (!PHONE_HASH_RE.test(phoneHash)) {
      throw new ExternalApiError(400, 'phoneHash required (64-char hex)', 'BAD_REQUEST')
    }

    const matches = await basePrisma.patientIndex.findMany({
      where: { phoneHash },
      select: { patientApricotId: true, patientCode: true, patientName: true },
      orderBy: [{ patientCode: 'asc' }, { patientApricotId: 'asc' }],
    })
    if (matches.length === 0) {
      return jsonNoStore({ v: 1, matches: [] })
    }

    // lastVisit = 該病人最近過去行（date ≤ 今日，HK 日界 — date 欄本身係 HK YYYY-MM-DD）
    // 一 query 攞全部 match 嘅過去行，group by patient（避免 N+1）
    const today = toHKDateStr(new Date())
    const lastRows = await basePrisma.appointmentIndex.findMany({
      where: {
        patientApricotId: { in: matches.map(m => m.patientApricotId) },
        date: { lte: today },
      },
      select: { patientApricotId: true, date: true, providerName: true, visitReasons: true, startTime: true },
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    })
    const lastByPatient = new Map<string, { date: string; providerName: string; visitReasons: string[] }>()
    for (const r of lastRows) {
      if (!lastByPatient.has(r.patientApricotId)) {
        lastByPatient.set(r.patientApricotId, { date: r.date, providerName: r.providerName, visitReasons: r.visitReasons })
      }
    }

    return jsonNoStore({
      v: 1,
      matches: matches.map(m => ({
        patientApricotId: m.patientApricotId,
        patientCode: m.patientCode,
        patientName: m.patientName,
        lastVisit: lastByPatient.get(m.patientApricotId) ?? null,
      })),
    })
  })
}
