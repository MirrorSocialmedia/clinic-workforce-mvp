export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import {
  updateBookingStatus,
  mapWriteErrorToExternal,
} from '@/lib/apricot/write-booking'
import { requireWriteEnabled, parseMutationQuery } from '../../guards'

// ============================================================
// PUT /api/external/v1/bookings/{apricotApptId}/status?status=102|-7
//     &date=YYYY-MM-DD&clinicCode=<店代號>
// （MD §5，scope bookings）— cw-apricotwrite-20260823-a1
//
// 白名單（§0 實測）：只准 102（改期標記）/ -7（取消）— 其他值一律 400。
//
//   200 { v:1, bookingStatus, dayRefreshed:true, syncedAt }
//   400 白名單外 / 參數錯 ｜ 503 WRITE_DISABLED ｜ 502 APRICOT_ERROR:{step}
//
// ⚠️ MD 延伸（報告已註記）：date/clinicCode 參數係為 §4 single-day sync 加嘅
//    （MD §5 原簽名冇）— consumer 落單時已知該單日期/店，直接傳入。
// ============================================================

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  return withExternalAudit(req, '/api/external/v1/bookings/[id]/status', async (ctx) => {
    const key = await requireExternalKey(req, 'bookings')
    ctx.setKey(key.name)
    requireWriteEnabled()

    const apricotApptId = params.id
    if (!apricotApptId || apricotApptId.length > 128 || /[^\w-]/.test(apricotApptId)) {
      throw new ExternalApiError(400, 'invalid apricotApptId', 'BAD_REQUEST')
    }
    const statusParam = new URL(req.url).searchParams.get('status')
    // 白名單鎖死：只收字面 "102" / "-7"（status=4 等 → 400，contract test 釘住）
    if (statusParam !== '102' && statusParam !== '-7') {
      throw new ExternalApiError(400, 'status must be 102 or -7', 'BAD_REQUEST')
    }
    const status = Number(statusParam)

    const { dateHk, clinic } = await parseMutationQuery(req)

    try {
      const result = await updateBookingStatus(apricotApptId, status, {
        requestedBy: key.name,
        clinicCuid: clinic.id,
        apricotClinicId: clinic.apricotClinicId,
        dateHk,
      })
      return jsonNoStore({ v: 1, ...result })
    } catch (e) {
      throw mapWriteErrorToExternal(e)
    }
  })
}
