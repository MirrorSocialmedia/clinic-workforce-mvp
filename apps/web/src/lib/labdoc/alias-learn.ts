/**
 * cwm-labdoc P2 — §6 alias 學習（確認頭部時觸發）
 *
 * spec 口徑（逐字）：
 * - §6.1.3（Lab）：AI 唔中 → 員工揀；**確認後寫 LabAlias**（nameRaw、nameCnRaw 各一條，有值先寫），audit LAB_ALIAS_LEARN。
 * - §6.2.7（診所）：員工確認或改咗：有 customerNoRaw → upsert LabCustomerNo；
 *   依據係 NAME／MANUAL 而有 clinicRaw → upsert ClinicNameAlias。覆蓋已存在 alias → 先彈確認（前端行為；server 最後寫贏）。
 * - §6.3.4（醫生）：AI 唔中 → 員工揀；**確認後寫 ProviderNameAlias**，audit LAB_ALIAS_LEARN。
 *
 * 保守決定（decision log）：
 * - Lab／醫生「學習」觸發條件 = 確認值 ≠ AI 原值（員工改咗／AI 冇認到嗰個 raw 先要記）。
 *   AI 認到（ALIAS/NAME/CUSTOMER_NO basis）且員工照單全收 → 無新資訊，唔寫（少咗冏樣 alias 增殖）。
 * - 診所跟 §6.2.7 字面：customerNoRaw 路徑每次確認都 upsert（冪等）；
 *   ClinicNameAlias 只喺 basis ∈ {NAME, MANUAL} 或有 clinicRaw 可寫時。
 * - upsert 撞（同 rawNorm 已指另一目標）= 最後確認贏（spec：「以後 {原文} 都當係 {新}？」係前端彈框）。
 * - 任何一條 alias 寫失敗唔會回滾頭部確認（try/catch + log；alias 係最佳努力學習，非核心狀態）。
 */
import type { Prisma } from '@prisma/client'
import { normLabName, normClinicName, normDoctor, normCustomerNo } from './identify'
import { assertAuditInputClean, LabDocAuditPIIError } from './audit-pii'

type Tx = Prisma.TransactionClient

export interface AliasLearnInput {
  /** AI 識別後嘅 Lab（確認前 DB 值）*/
  aiLabId: string | null
  aiLabBasis: string | null
  /** AI 诊所 / 醫生 */
  aiClinicId: string | null
  aiClinicBasis: string | null
  aiProviderId: string | null
  aiProviderBasis: string | null
  /** 員工確認後 */
  labId: string | null
  labNameRaw: string | null
  labNameCnRaw: string | null
  clinicId: string | null
  providerId: string | null
  customerNoRaw: string | null
  /** AI 抽出嘅 clinic raw（extractedJson billTo.nameRaw / clinicRaw）*/
  clinicRaw: string | null
  /** AI 抽出嘅 doctor raw */
  doctorRaw: string | null
  actorId: string
  docId: string
}

export interface AliasLearnResult {
  /** 實際寫入嘅 alias（audit 用）*/
  learned: Array<{ kind: string; raw: string; targetId: string }>
}

async function auditAlias(tx: Tx, input: AliasLearnResult['learned'][number] & { docId: string; actorId: string }): Promise<void> {
  const payload = {
    action: 'LAB_ALIAS_LEARN',
    entity: 'LabAlias',
    entityId: input.targetId,
    notes: input.docId,
    after: { kind: input.kind, raw: input.raw, targetId: input.targetId },
  }
  assertAuditInputClean(payload)
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      action: payload.action,
      entity: payload.entity,
      entityId: payload.entityId,
      clinicId: null,
      beforeJson: null,
      afterJson: JSON.stringify(payload.after),
      notes: payload.notes,
      ipAddress: null,
      userAgent: null,
    },
  })
}

export async function learnAliases(tx: Tx, input: AliasLearnInput): Promise<AliasLearnResult> {
  const learned: AliasLearnResult['learned'] = []

  try {
    // ── Lab（§6.1.3）：確認值 ≠ AI 原值（改咗／AI 冇認到）先學習 ──
    const labChanged = input.labId !== null && input.labId !== input.aiLabId
    const labUnidentified = input.labId !== null && (input.aiLabBasis === null || input.aiLabBasis === 'MANUAL')
    if ((labChanged || labUnidentified) && input.labId) {
      const en = normLabName(input.labNameRaw)
      const cn = normLabName(input.labNameCnRaw)
      if (en) {
        await tx.labAlias.upsert({
          where: { kind_rawNorm: { kind: 'NAME_EN', rawNorm: en } },
          create: { labId: input.labId, kind: 'NAME_EN', rawNorm: en, createdBy: input.actorId },
          update: { labId: input.labId },
        })
        learned.push({ kind: 'LabAlias:NAME_EN', raw: input.labNameRaw as string, targetId: input.labId })
      }
      if (cn && cn !== en) {
        await tx.labAlias.upsert({
          where: { kind_rawNorm: { kind: 'NAME_CN', rawNorm: cn } },
          create: { labId: input.labId, kind: 'NAME_CN', rawNorm: cn, createdBy: input.actorId },
          update: { labId: input.labId },
        })
        learned.push({ kind: 'LabAlias:NAME_CN', raw: input.labNameCnRaw as string, targetId: input.labId })
      }
    }

    // ── 診所（§6.2.7）──
    if (input.customerNoRaw && input.labId && input.clinicId) {
      const no = normCustomerNo(input.customerNoRaw)
      if (no) {
        await tx.labCustomerNo.upsert({
          where: { labId_customerNo: { labId: input.labId, customerNo: no } },
          create: {
            labId: input.labId,
            customerNo: no,
            clinicId: input.clinicId,
            providerId: input.providerId,
            createdBy: input.actorId,
          },
          update: { clinicId: input.clinicId, providerId: input.providerId ?? undefined },
        })
        learned.push({ kind: 'LabCustomerNo', raw: input.customerNoRaw, targetId: input.clinicId })
      }
    }
    const basisNameOrManual = input.aiClinicBasis === 'NAME' || input.aiClinicBasis === 'MANUAL' || input.aiClinicBasis === null
    if (input.clinicId && input.clinicRaw && (basisNameOrManual || input.clinicId !== input.aiClinicId)) {
      const raw = normClinicName(input.clinicRaw)
      if (raw) {
        await tx.clinicNameAlias.upsert({
          where: { rawNorm: raw },
          create: { rawNorm: raw, clinicId: input.clinicId, createdBy: input.actorId },
          update: { clinicId: input.clinicId },
        })
        learned.push({ kind: 'ClinicNameAlias', raw: input.clinicRaw, targetId: input.clinicId })
      }
    }

    // ── 醫生（§6.3.4）──
    const providerChanged = input.providerId !== null && input.providerId !== input.aiProviderId
    const providerUnidentified = input.providerId !== null && (input.aiProviderBasis === null || input.aiProviderBasis === 'MANUAL')
    if ((providerChanged || providerUnidentified) && input.providerId && input.doctorRaw) {
      const raw = normDoctor(input.doctorRaw)
      if (raw) {
        await tx.providerNameAlias.upsert({
          where: { rawNorm: raw },
          create: { rawNorm: raw, providerId: input.providerId, createdBy: input.actorId },
          update: { providerId: input.providerId },
        })
        learned.push({ kind: 'ProviderNameAlias', raw: input.doctorRaw, targetId: input.providerId })
      }
    }

    for (const l of learned) {
      await auditAlias(tx, { ...l, docId: input.docId, actorId: input.actorId })
    }
  } catch (e) {
    // alias 學習係最佳努力（唔回滾頭部確認）；但 PII guard throw 要傳出去（fail-closed）
    if (e instanceof LabDocAuditPIIError) throw e
    console.error('[labdoc] alias learn failed (best-effort, header confirm proceeds)', {
      err: String(e instanceof Error ? e.message : e),
      docId: input.docId,
    })
  }

  return { learned }
}
