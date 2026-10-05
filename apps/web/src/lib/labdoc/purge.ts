/**
 * cwm-labdoc P1 — 保留同 purging（B8，§4.4）＋ 孤兒 sweep（§4.1，gen1 決定 4）
 *
 * 每晚 03:30 cron → POST /api/internal/labdoc-purge（x-cron-key，
 * 守門同 clinical-index-nightly 一致）。
 *
 * 語義（施工單 §4.4 逐字）：
 *   1. 搵 `purgeAt <= now AND purgedAt IS NULL`，逐個：刪碟上全部 key → `purgedAt = now`。
 *   2. 只有當一張單據**所有頁**嘅檔都 purged，先清嗰張單據嘅 PII：
 *      `extractedJson` 入面所有 `patientNameRaw`、`patientRaw` 設 null；
 *      `LabDocumentLine.patientNameRaw`、`LabStatementLine.patientRaw` 設 null。
 *   3. 逐個檔 commit；中途停咗下次可以接住做。
 *   4. audit `LAB_DOC_IMAGE_PURGE`：notes 記檔數、單據數、清咗幾多個姓名欄（唔記姓名）。
 *
 * **金額、單號、病人編號、配對紀錄保留**（§4.4）。
 *
 * 冪等：
 *   - 檔級：條件更新 `updateMany where { id, purgedAt: null }`（0 行 = 另一 run 先清咗，skip）
 *   - 碟刪：ENOENT 容忍（重跑 = no-op）
 *   - 單據級：清姓名只計非 null 欄（重跑 = 計 0、唔再 update）
 * Crash recovery：檔 commit 咗但單據 PII 未清（清之前 crash）→ 下次 run 嘅
 *   step 2 重新核「所有頁已 purged」嘅單據並清（唔需要額外狀態旗）。
 *
 * 🔴 零 PII 流出：outcome／audit 只記數量，姓名一律唔入。
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { labdocAudit, NAME_FIELD_KEYS } from './audit'
import { deleteEncrypted, sweepOrphans } from './storage'

export interface PurgeOutcome {
  now: string
  /** 到期（purgeAt <= now 且未 purged）檔數 */
  dueFiles: number
  /** 呢次 run 實際 purged 嘅檔數（檔級 commit 成功） */
  filesPurged: number
  /** 呢次 run 真刪咗嘅碟上 key 數（原檔＋顯示圖＋縮圖） */
  diskFilesDeleted: number
  /** 呢次 run 實際清咗 PII 嘅單據數 */
  docsPiiCleared: number
  /** 清咗幾多個姓名欄（extractedJson ＋ 行 ＋ P3 statement 行） */
  nameFieldsCleared: number
  /** 孤兒 sweep 刪咗幾多（§4.1） */
  orphansSwept: number
  /** 逐個檔／單據隔離嘅錯誤訊息（冇姓名） */
  errors: string[]
}

export interface PurgeOptions {
  /** cron 固定時點／e2e 注入（預設 new Date()） */
  now?: Date
  /** 跳過 audit 寫入（單位測試 seam；預設寫） */
  audit?: boolean
}

/**
 * 遞迴將所有姓名欄（NAME_FIELD_KEYS）設 null。
 * 回傳 [cleaned, 清咗幾多個**非 null** 姓名欄]。
 * 純函數（冇 prisma）— 單測直接打。
 */
export function stripNameFields(value: unknown): [unknown, number] {
  let count = 0
  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (NAME_FIELD_KEYS.has(k)) {
          if (val !== null && val !== undefined) count++
          out[k] = null
        } else {
          out[k] = walk(val)
        }
      }
      return out
    }
    return v
  }
  return [walk(value), count]
}

/**
 * 清一張單據嘅 PII（只喺「所有頁檔已 purged」時 call）。
 * 🔴 只清姓名欄；金額、單號、病人編號、配對紀錄（costCaseId）保留。
 * 回傳清咗幾多欄（0 = 已經清過／冇姓名 → 冪等 no-op）。
 * P3 表 LabStatementLine：P1 未建 → 表唔存在就 skip（to_regclass 檢查）。
 */
async function clearDocPII(documentId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    let cleared = 0

    const doc = await tx.labDocument.findUnique({
      where: { id: documentId },
      select: { id: true, extractedJson: true },
    })
    if (doc && doc.extractedJson != null) {
      const [cleaned, n] = stripNameFields(doc.extractedJson)
      if (n > 0) {
        await tx.labDocument.update({
          where: { id: documentId },
          data: { extractedJson: cleaned as Prisma.InputJsonValue },
        })
        cleared += n
      }
    }

    const lines = await tx.labDocumentLine.updateMany({
      where: { documentId, patientNameRaw: { not: null } },
      data: { patientNameRaw: null },
    })
    cleared += lines.count

    // P3：LabStatementLine（P1 未建表 — 不存在就 skip，唔會 throw）
    const t = (await tx.$queryRaw`
      SELECT to_regclass('"LabStatementLine"') IS NOT NULL AS "exists"
    `) as Array<{ exists: boolean }>
    if (t.length > 0 && t[0].exists) {
      const n = await tx.$executeRaw`
        UPDATE "LabStatementLine" SET "patientRaw" = NULL
        WHERE "documentId" = ${documentId} AND "patientRaw" IS NOT NULL
      `
      cleared += Number(n)
    }

    return cleared
  })
}

/**
 * 主入口：一跑晒 §4.4 四步（＋ §4.1 orphan sweep）。
 * 唔會 throw（逐個檔／單據 try/catch 隔離）— 錯誤入 outcome.errors，下次 run 接住做。
 */
export async function runLabDocPurge(opts: PurgeOptions = {}): Promise<PurgeOutcome> {
  const now = opts.now ?? new Date()
  const outcome: PurgeOutcome = {
    now: now.toISOString(),
    dueFiles: 0,
    filesPurged: 0,
    diskFilesDeleted: 0,
    docsPiiCleared: 0,
    nameFieldsCleared: 0,
    orphansSwept: 0,
    errors: [],
  }

  // ── Step 1：到期檔逐個：刪碟上全部 key → purgedAt = now（逐個 commit；中途死接得住）──
  const due = await prisma.labFile.findMany({
    where: { purgeAt: { lte: now }, purgedAt: null },
    select: { id: true, storageKey: true, pagesJson: true },
  })
  outcome.dueFiles = due.length
  for (const f of due) {
    const keys: string[] = [f.storageKey]
    for (const p of (f.pagesJson ?? []) as Array<{ displayKey?: string | null; thumbKey?: string | null }>) {
      if (p.displayKey) keys.push(p.displayKey)
      if (p.thumbKey) keys.push(p.thumbKey)
    }
    try {
      let deleted = 0
      for (const key of keys) {
        if (await deleteEncrypted(key)) deleted++
      }
      const res = await prisma.labFile.updateMany({
        where: { id: f.id, purgedAt: null },
        data: { purgedAt: now },
      })
      // count === 1 → 呢個 run purged；count === 0 → 並行 run 先做咗（冪等 skip）
      if (res.count === 1) {
        outcome.filesPurged++
        outcome.diskFilesDeleted += deleted
      }
    } catch (e: any) {
      // 逐個檔隔離：一個檔失敗唔阻其余；purgedAt 未 set → 下次 run 重試（T16）
      outcome.errors.push(`file ${f.id}: ${e?.message ?? String(e)}`)
    }
  }

  // ── Step 2：「所有頁檔已 purged」嘅單據 → 清 PII（金額／單號／病人編號保留）──
  // AND 合併（Prisma 唔准同一 relation 喺同一 where 出現兩次）：
  //   some {} = 至少 1 頁（防 0 頁單據 vacuous match）；
  //   every = 全部頁嘅檔都已 purged。
  const candidates = await prisma.labDocument.findMany({
    where: {
      AND: [
        { pages: { some: {} } },
        { pages: { every: { file: { purgedAt: { not: null } } } } },
      ],
    },
    select: { id: true, clinicId: true },
  })
  for (const doc of candidates) {
    try {
      const n = await clearDocPII(doc.id)
      if (n > 0) {
        outcome.docsPiiCleared++
        outcome.nameFieldsCleared += n
      }
    } catch (e: any) {
      // PII 清失敗唔阻 run；下次 run 重試（所有頁仍全部 purged → 仍然 candidate）
      outcome.errors.push(`doc ${doc.id}: ${e?.message ?? String(e)}`)
    }
  }

  // ── Step 3：孤兒 sweep（§4.1，gen1 決定 4 併入呢個 cron）──
  try {
    outcome.orphansSwept = await sweepOrphans(now)
  } catch (e: any) {
    outcome.errors.push(`orphan-sweep: ${e?.message ?? String(e)}`)
  }

  // ── Step 4：audit（§14 EXEMPT — 數量；姓名一律唔記）──
  const did = outcome.filesPurged > 0 || outcome.docsPiiCleared > 0 || outcome.orphansSwept > 0
  if (did && opts.audit !== false) {
    await labdocAudit({
      action: 'LAB_DOC_IMAGE_PURGE',
      entity: 'LabDocPurge',
      entityId: 'nightly',
      notes: `labdoc purge: files=${outcome.filesPurged}/${outcome.dueFiles} docs=${outcome.docsPiiCleared} nameFields=${outcome.nameFieldsCleared} orphans=${outcome.orphansSwept} errors=${outcome.errors.length}`,
      after: {
        filesPurged: outcome.filesPurged,
        dueFiles: outcome.dueFiles,
        diskFilesDeleted: outcome.diskFilesDeleted,
        docsPiiCleared: outcome.docsPiiCleared,
        nameFieldsCleared: outcome.nameFieldsCleared,
        orphansSwept: outcome.orphansSwept,
        errors: outcome.errors,
      },
    })
  }

  if (outcome.errors.length > 0) {
    // 🔴 errors 只有 fileId／訊息（無姓名）
    console.error(`[labdoc-purge] ${outcome.errors.length} error(s) this run:`, outcome.errors)
  } else {
    console.log(
      `[labdoc-purge] done: files=${outcome.filesPurged}/${outcome.dueFiles} ` +
        `docs=${outcome.docsPiiCleared} nameFields=${outcome.nameFieldsCleared} orphans=${outcome.orphansSwept}`,
    )
  }
  return outcome
}
