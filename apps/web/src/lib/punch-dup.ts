// ============================================================
// ★ 2026-09-30 F-08：管理端唔准造出同日同店同類型「有效」重複卡
//   員工 QR 打卡路徑已有防重複（/api/punch tx 內鎖後檢查）；
//   管理端（改卡／批補登類型變更／補登建卡）之前冇呢道檢查 →
//   可以將 LUNCH_START 改做 CLOCK_IN，令當日出現兩張有效上班卡。
//   統一喺 lockEmployee 之後（tx 內）查：有 → 409 DUP_PUNCH。
//   注意：作廢舊筆喺同一 tx 內先做，`void: { is: null }` 會自動排除舊筆。
// ============================================================
import { HttpError } from './emp-lock'
import { toHKDateStr, hkDateStart, hkDateEnd, fmtTime } from './hk-date'
import { punchLabel } from './punch-label'

/** 管理端寫卡前（lockEmployee 之後）檢查同日同店同類型有冇有效卡 */
export async function assertNoDupPunchTx(tx: any, a: {
  employeeId: string; clinicId: string; punchType: string; punchTime: Date; excludeIds?: string[]
}) {
  const day = toHKDateStr(a.punchTime)
  const dup = await tx.punchRecord.findFirst({
    where: {
      employeeId: a.employeeId, clinicId: a.clinicId, punchType: a.punchType,
      punchTime: { gte: hkDateStart(day), lte: hkDateEnd(day) }, void: { is: null },
      ...(a.excludeIds?.length ? { id: { notIn: a.excludeIds } } : {}),
    },
    select: { id: true, punchTime: true },
  })
  if (dup) {
    throw new HttpError(409, `${day} 已經有一張有效嘅${punchLabel(a.punchType as any)}卡（${fmtTime(dup.punchTime)}），請改嗰張或者先作廢`, { code: 'DUP_PUNCH', dupId: dup.id })
  }
}
