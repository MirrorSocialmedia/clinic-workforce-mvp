export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import {
  removeBooking,
  mapWriteErrorToExternal,
} from '@/lib/apricot/write-booking'
import { requireWriteEnabled, parseMutationQuery } from '../../guards'

// ============================================================
// PUT /api/external/v1/bookings/{apricotApptId}/remove
//     ?date=YYYY-MM-DD&clinicCode=<店代號>
// （MD §5，scope bookings）— cw-apricotwrite-20260823-a1
//
// §0 實測：刪單 method 係 **PUT**（唔係 POST），body ["<id>"] —
//   contract test 釘住 method（POST/DELETE → 405）。
//
//   200 { v:1, removed:true, dayRefreshed:true, syncedAt }
//   503 WRITE_DISABLED ｜ 502 APRICOT_ERROR:{step}
// ============================================================

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  return withExternalAudit(req, '/api/external/v1/bookings/[id]/remove', async (ctx) => {
    const key = await requireExternalKey(req, 'bookings')
    ctx.setKey(key.name)
    requireWriteEnabled()

    const apricotApptId = params.id
    if (!apricotApptId || apricotApptId.length > 128 || /[^\w-]/.test(apricotApptId)) {
      throw new ExternalApiError(400, 'invalid apricotApptId', 'BAD_REQUEST')
    }
    const { dateHk, clinic } = await parseMutationQuery(req)

    try {
      const result = await removeBooking(apricotApptId, {
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
