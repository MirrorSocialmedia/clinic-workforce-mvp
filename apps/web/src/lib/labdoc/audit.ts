/**
 * cwm-labdoc — audit 寫入 helper（§14）
 *
 * 🔴 任何 audit、console log 都唔准有 patientNameRaw／patientRaw／原檔內容。
 * `labdocAudit()` 係 labdoc 唯一 audit 寫入口：寫入前遞迴掃描 payload，
 * 發現病人姓名欄就 throw（防手誤把姓名帶入 audit JSON）。
 *
 * scripts/check-pii.sh 嘅 test-labdoc-audit-pii.ts 驗呢個 guard。
 */
import { prisma } from '@/lib/prisma'

export class LabDocAuditPIIError extends Error {
  constructor(path: string) {
    super(`labdocAudit: payload 含病人姓名欄（${path}）— §14 禁止姓名入 audit`)
    this.name = 'LabDocAuditPIIError'
  }
}

/** 病人姓名欄 blacklist（key 名，遞迴匹配）— purge 清姓名（§4.4）共用同一份 */
export const NAME_FIELD_KEYS = new Set([
  'patientNameRaw',
  'patientRaw',
  'patientName',
  'patientFullName',
])
const PII_NAME_KEYS = NAME_FIELD_KEYS

/**
 * 遞迴掃描 object／array，回傳第一個命中 PII_NAME_KEYS 嘅 path；冇命中回 null。
 * （string/number 等 primitive 值唔 scan — 欄位名先係規則。）
 */
export function findNameFieldPath(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNameFieldPath(value[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_NAME_KEYS.has(k)) return `${path}.${k}`
      const hit = findNameFieldPath(v, `${path}.${k}`)
      if (hit) return hit
    }
  }
  return null
}

/** 寫入前 guard：payload 任何位置有姓名欄 → throw */
export function assertNoNameFields(payload: unknown, label = 'payload'): void {
  const hit = findNameFieldPath(payload)
  if (hit) throw new LabDocAuditPIIError(hit)
  void label
}

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
  // notes 先 scan（string 內含姓名欄字串都會被 check-pii 視作洩漏風險 — 用 includes 粗檢）
  if (input.notes) {
    for (const k of PII_NAME_KEYS) {
      if (input.notes.includes(k)) throw new LabDocAuditPIIError('notes 含姓名欄名')
    }
  }
  if (input.before !== undefined) assertNoNameFields(input.before, 'before')
  if (input.after !== undefined) assertNoNameFields(input.after, 'after')

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
