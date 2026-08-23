export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
  isValidDateStr,
} from '@/lib/external-api'
import { fetchDutyRoster } from '@/lib/external-duty-roster'
import { todayHK } from '@/lib/hk-date'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/external/v1/duty-roster — 外部當值狹窄 API（MD §C.2 / §A.4）
// cw-extapi-20260823-a1
//
//   GET /api/external/v1/duty-roster?clinicCode=<店代號或 cuid>&date=YYYY-MM-DD
//   Header: X-Api-Key（scope: duty-roster — §A.2 守門）
//
// 由舊 /api/external/duty-roster 遷移：
//   - 守門由「IP allowlist + env key」換做 DB key + scope（§A.2）
//   - response 由裸陣列升級 { v: 1, staff: [...] }（MD §C.2 — wa-inbox 同步改 parser）
//   - audit 由 AuditLog（EXTERNAL_DUTY_ROSTER_*）改走 ExternalApiAudit（零 PII metadata）
//   - 舊 path 302 redirect 保留（wa-inbox 未切，下一階段先切，唔准刪）
//
// 回覆白名單（PII 鐵律 — 只准四欄）：
//   { v: 1, staff: [{ staffName, role, shiftStart, shiftEnd }] }
//   冇 id、冇 payroll、冇打卡、冇 email/phone。無當值 → 200 { v:1, staff: [] }。
//   未知 clinicCode → 404 { error, code: 'CLINIC_NOT_FOUND' }。
// ============================================================

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/duty-roster', async (ctx) => {
    const key = await requireExternalKey(req, 'duty-roster')
    ctx.setKey(key.name)

    const params = new URL(req.url).searchParams
    // clinicId = compat alias（舊 path 302 直接 passthrough 舊 query）
    const clinicCode = params.get('clinicCode') ?? params.get('clinicId')
    if (!clinicCode) {
      throw new ExternalApiError(400, 'clinicCode required', 'BAD_REQUEST')
    }
    const dateStr = params.get('date') ?? todayHK()
    if (!isValidDateStr(dateStr)) {
      throw new ExternalApiError(400, 'invalid date', 'BAD_REQUEST')
    }

    const { clinic, rows } = await fetchDutyRoster(clinicCode, dateStr)
    if (!clinic) {
      throw new ExternalApiError(404, 'clinic not found', 'CLINIC_NOT_FOUND')
    }

    return jsonNoStore({ v: 1, staff: rows })
  })
}
