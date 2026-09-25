export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
  isValidDateStr,
  dateDiffDays,
} from '@/lib/external-api'
import { basePrisma } from '@/lib/prisma'
import { resolveClinicByCode } from '@/lib/external-clinic'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/patients/visits — C/D/E 觸發來源（MD §2.6 #1）
// ★ cwi-followup-p1-20260915
//
//   Query: clinicCode（必填） from / to（YYYY-MM-DD，必填，≤ 366 日）
//          reasonCodes[]（可選，repeatable） bookingStatus[]（可選，repeatable）
//   Header: X-Api-Key（scope: patients）
//
//   200: { v:1, visits:[{ visitId, patientApricotId, patientCode, phoneHashes,
//          visitDate, clinicCode, bookingStatus, visitReasonCodes, providerCode,
//          hasNote, quotedItems, rxCodes: [{ code, name, isAntibiotic }],
//          billTtlAmt, billOsAmt }] }
//
// 讀索引（ClinicalRecordIndex）— 唔打 Apricot。
// 🔴 只回 phoneHashes[]（永不回原始電話）；零 note 內容（全文走 #5）。
// 🔴 rxCodes audit（cwi-followup-p4 S4 — 規則同 P1 EXTERNAL_NOTE_VIEWED 一致）：
//    任何一行 rxCodes 非空 → 回內容之前先寫 EXTERNAL_RX_VIEWED（零藥物內容）；
//    audit 寫入失敗 → 500 唔出內容。
// ============================================================

const MAX_RANGE_DAY_DIFF = 365 // 366 日含首尾（同回填 365 日範圍同口徑）

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/patients/visits', async (ctx) => {
    const key = await requireExternalKey(req, 'patients')
    ctx.setKey(key.name)

    const params = new URL(req.url).searchParams
    const clinicCode = (params.get('clinicCode') ?? '').trim()
    const from = params.get('from')
    const to = params.get('to')
    if (!clinicCode) throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
    if (!from || !to || !isValidDateStr(from) || !isValidDateStr(to)) {
      throw new ExternalApiError(400, 'invalid date range', 'BAD_REQUEST')
    }
    const diff = dateDiffDays(from, to)
    if (diff < 0 || diff > MAX_RANGE_DAY_DIFF) {
      throw new ExternalApiError(400, 'date range must be ≤ 366 days', 'BAD_REQUEST')
    }
    const reasonCodes = params.getAll('reasonCodes').map(s => s.trim()).filter(Boolean)
    const bookingStatuses = params.getAll('bookingStatus').map(s => Number(s)).filter(n => Number.isInteger(n))

    const clinic = await resolveClinicByCode(clinicCode)

    const rows = await basePrisma.clinicalRecordIndex.findMany({
      where: {
        clinicId: clinic.id,
        visitDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        ...(reasonCodes.length ? { visitReasonCodes: { hasSome: reasonCodes } } : {}),
        ...(bookingStatuses.length ? { bookingStatus: { in: bookingStatuses } } : {}),
      },
      orderBy: [{ visitDate: 'desc' }, { patientApricotId: 'asc' }],
    })

    // S4：藥物 code → 顯示名 + 抗生素旗（C 類判定用；零全文）
    const staffId = (req.headers.get('x-staff-id') ?? '').trim() || 'anonymous'
    const rxRows = await basePrisma.clinicalRxCode.findMany({ select: { code: true, nameCn: true, nameEn: true, isAntibiotic: true } })
    const rxInfo = new Map(rxRows.map(r => [r.code, { name: r.nameCn || r.nameEn || r.code, isAntibiotic: r.isAntibiotic }]))
    const visits = rows.map(r => ({
      visitId: r.id,
      patientApricotId: r.patientApricotId,
      patientCode: r.patientCode,
      phoneHashes: r.phoneHashes,
      visitDate: r.visitDate.toISOString().slice(0, 10),
      clinicCode,
      bookingStatus: r.bookingStatus,
      visitReasonCodes: r.visitReasonCodes,
      providerCode: r.providerCode,
      hasNote: r.hasNote,
      quotedItems: r.quotedItems,
      rxCodes: r.rxCodes.map(c => ({ code: c, name: rxInfo.get(c)?.name ?? c, isAntibiotic: rxInfo.get(c)?.isAntibiotic ?? false })),
      billTtlAmt: r.billTtlAmt,
      billOsAmt: r.billOsAmt,
    }))

    // 🔴 rxCodes 非空 → 先 audit 後出內容（同 P1 EXTERNAL_NOTE_VIEWED 規則）
    const withRx = visits.filter(v => v.rxCodes.length > 0)
    if (withRx.length) {
      try {
        await basePrisma.auditLog.create({
          data: {
            actorId: null,
            action: 'EXTERNAL_RX_VIEWED',
            entity: 'ClinicalRecordIndex',
            entityId: withRx[0].visitId,
            clinicId: clinic.id,
            notes: JSON.stringify({ staffId, clinicCode, visits: withRx.map(v => v.visitId), rxCount: withRx.reduce((s2, v) => s2 + v.rxCodes.length, 0) }),
          },
        })
      } catch (err) {
        console.error('[visits-batch-rx] EXTERNAL_RX_VIEWED audit 寫入失敗（唔出內容）:', err)
        throw new ExternalApiError(500, 'audit write failed', 'INTERNAL')
      }
    }

    return jsonNoStore({ v: 1, visits })
  })
}
