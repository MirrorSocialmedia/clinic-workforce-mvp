/**
 * cwm-labdoc — audit 姓名欄 guard（§14），純函數、冇任何 import。
 *
 * 由 audit.ts 拆出嚟：scripts/check-pii.sh 喺 deploy.sh 嘅 git worktree 入面跑（冇 node_modules），
 * 一 import audit.ts 就會拉 @prisma/client → MODULE_NOT_FOUND → 守門失敗。
 * audit.ts 照 re-export，其他地方唔使改。
 */

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

/** labdocAudit 寫入前嘅全部檢查（notes 粗檢＋before/after 遞迴掃描） */
export function assertAuditInputClean(input: { notes?: string | null; before?: unknown; after?: unknown }): void {
  // notes 先 scan（string 內含姓名欄字串都會被 check-pii 視作洩漏風險 — 用 includes 粗檢）
  if (input.notes) {
    for (const k of PII_NAME_KEYS) {
      if (input.notes.includes(k)) throw new LabDocAuditPIIError('notes 含姓名欄名')
    }
  }
  if (input.before !== undefined) assertNoNameFields(input.before, 'before')
  if (input.after !== undefined) assertNoNameFields(input.after, 'after')
}
