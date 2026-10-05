/**
 * cwm-labdoc — audit 寫入 helper（§14）
 *
 * 🔴 任何 audit、console log 都唔准有 patientNameRaw／patientRaw／原檔內容。
 * `labdocAudit()` 係 labdoc 唯一 audit 寫入口：寫入前遞迴掃描 payload，
 * 發現病人姓名欄就 throw（防手誤把姓名帶入 audit JSON）。
 *
 * guard 本身喺 audit-pii.ts（純函數）；scripts/check-pii.sh（test-patient-pii.ts）驗佢。
 */
import { prisma } from '@/lib/prisma'
import { assertAuditInputClean } from './audit-pii'

export { LabDocAuditPIIError, NAME_FIELD_KEYS, findNameFieldPath, assertNoNameFields, assertAuditInputClean } from './audit-pii'

export interface LabDocAuditInput {
  action: string
  entity: string
  entityId: string
  /** audit clinicId — 文件或成本嘅診所（§14） */
  clinicId?: string | null
  actorId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  notes?: string | null
  before?: unknown
  after?: unknown
}

/**
 * labdoc audit 唯一寫入口。
 * before/after 會 JSON.stringify 前 scan；notes 要人手淨化（名字一律唔准入）。
 */
export async function labdocAudit(input: LabDocAuditInput): Promise<void> {
  assertAuditInputClean(input)

  await prisma.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      clinicId: input.clinicId ?? null,
      beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
      afterJson: input.after === undefined ? null : JSON.stringify(input.after),
      notes: input.notes ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  })
}
