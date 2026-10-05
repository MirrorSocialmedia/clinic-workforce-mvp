export const dynamic = 'force-dynamic'
import { NextRequest } from 'next/server'
import {
  requireExternalKey,
  withExternalAudit,
  ExternalApiError,
} from '@/lib/external-api'
import { jsonNoStore } from '@/lib/api-response'
import { basePrisma } from '@/lib/prisma'
import { DICTIONARY_KINDS } from '@/lib/apricot/write-booking'
import { resolveClinicByCode } from '@/lib/external-clinic'
import { normalizeApricotAccount, APRICOT_MAIN } from '@/lib/apricot/account'

// ============================================================
// GET /api/external/v1/dictionaries?kind=VISIT_REASON|BOOKING_TYPE[&clinicCode=]
// （MD §5，scope bookings）— cw-apricotwrite-20260823-a1
//
//   200 { v:1, kind, items: [{ apricotId, code, des }] } — isRemoved 剔走
//   400 kind 錯｜401/403/429 §A.2
//
// 數據源 = ApricotDictionary（nightly sync 掛現有 cron tick）。
// ★ cwm-apricotty-20261001：每個 Apricot 帳號一套字典（青衣 TY 嘅 id 唔同）——
//   帶 clinicCode → 回該店帳號嘅字典（response 加 apricotAccount）；唔帶 = 原帳號 MAIN（舊 consumer 零改變）。
// 只係代碼表 — 零病人資料；唔受 APRICOT_WRITE 總閘控制（只讀本系統 cache）。
// ============================================================

export async function GET(req: NextRequest) {
  return withExternalAudit(req, '/api/external/v1/dictionaries', async (ctx) => {
    const key = await requireExternalKey(req, 'bookings')
    ctx.setKey(key.name)

    const kind = new URL(req.url).searchParams.get('kind')
    if (!kind || !DICTIONARY_KINDS.includes(kind as (typeof DICTIONARY_KINDS)[number])) {
      throw new ExternalApiError(400, 'kind must be VISIT_REASON or BOOKING_TYPE', 'BAD_REQUEST')
    }

    const clinicCode = new URL(req.url).searchParams.get('clinicCode')
    const apricotAccount = clinicCode
      ? normalizeApricotAccount((await resolveClinicByCode(clinicCode)).apricotAccount)
      : APRICOT_MAIN

    const rows = await basePrisma.apricotDictionary.findMany({
      where: { kind, isRemoved: false, apricotAccount },
      select: { apricotId: true, code: true, des: true },
      orderBy: { code: 'asc' },
    })

    return jsonNoStore({
      v: 1,
      kind,
      // 只喺帶 clinicCode 先回（唔帶 = 舊 response 形狀一字不改）
      ...(clinicCode ? { apricotAccount } : {}),
      items: rows.map((r) => ({ apricotId: r.apricotId, code: r.code, des: r.des })),
    })
  })
}
