import { HttpError } from './emp-lock'
import { toHKDateStr, hkDateStart, hkDateEnd, fmtTime } from './hk-date'
import { punchLabel } from './punch-label'

/** ★ 2026-09-30 F-08：管理端寫卡前（lockEmployee 之後）檢查同日同店同類型有冇有效卡 */
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
