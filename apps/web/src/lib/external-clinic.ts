// ============================================================
// external clinic 解析共用 helper — cwi-final S5-5（W-6）
//
// 問題：舊口徑 `findFirst({ OR: [{ shortName: code }, { id: code }] })`
//   兩間店同一簡稱（例如兩間「旺」）→ findFirst 隨機揀一間 → 落錯店。
//
// 新口徑（resolveClinicByCode）：
//   1) findUnique(id) — cuid 精確匹配（無歧義）
//   2) 冇 → findMany(shortName, take 2)：
//      - 0 行 → 404 CLINIC_NOT_FOUND
//      - >1 行 → 400 AMBIGUOUS_CLINIC_CODE（逼 consumer 改用 cuid）
//      - 1 行 → 200
//   DB 層另有 partial unique index（Clinic_shortName_unique — 防新增重複；
//   見 migration；已有重複時 index 建唔到 = 部署前人手改名）。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import { ExternalApiError } from '@/lib/external-api'

export interface ResolvedClinic {
  id: string
  shortName: string | null
  apricotClinicId: string | null
}

/**
 * clinicCode 解析：cuid（精確）優先，shortName（唯一先過；重複 → 400）。
 * @throws ExternalApiError(404, 'CLINIC_NOT_FOUND') ｜ ExternalApiError(400, 'AMBIGUOUS_CLINIC_CODE')
 */
export async function resolveClinicByCode(code: string): Promise<ResolvedClinic> {
  const byId = await basePrisma.clinic.findUnique({
    where: { id: code },
    select: { id: true, shortName: true, apricotClinicId: true },
  })
  if (byId) return byId

  const rows = await basePrisma.clinic.findMany({
    where: { shortName: code },
    select: { id: true, shortName: true, apricotClinicId: true },
    take: 2,
  })
  if (rows.length === 0) {
    throw new ExternalApiError(404, 'clinic not found', 'CLINIC_NOT_FOUND')
  }
  if (rows.length > 1) {
    throw new ExternalApiError(400, 'clinic code ambiguous — use clinic id', 'AMBIGUOUS_CLINIC_CODE')
  }
  return rows[0]
}
