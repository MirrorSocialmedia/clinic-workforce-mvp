/**
 * cwm-labdoc P3 — §8.1 月結單分段：建行 + 重複偵測
 *
 * 用家：
 *  - extract.ts finishSuccess（STATEMENT 讀單成功 → 每 section 建 LabStatementSection/Line）
 *  - GET /api/lab-docs/:id（section 重複擋提示 — 畫面「取代舊版」）
 *  - reconcile／confirm route（重複擋 409 守門）
 *
 * 狀態（§3.4 分段）：PENDING（識別齊）｜NEEDS_ASSIGN（診所或醫生未識別）
 * 重複（§8.1）：同 Lab＋診所＋醫生＋月，有另一份未作廢／未取代嘅月結單分段 → 擋該分段
 *   （只讀計算 — 冇 DB 欄；reconcile/confirm 實時再查一次兜住並發）。
 */
import { normDocNo, type SectionIdentifyResult } from './identify'

/** §8.1：statementMonth 由邊度嚟（UI 標黃 = LINES）。 */
export type StatementMonthSource = 'AI' | 'PRESELECTED' | 'LINES'

/**
 * §8.1：AI 值 → 冇則上傳時預選 → 冇則 section 行最遲日期月份（＋標黃）。
 * 回 { month, source }（month = null 係三邊都冇）。
 */
export function resolveStatementMonth(args: {
  aiMonth: string | null
  preselected: string | null
  latestLineMonth: string | null
}): { month: string | null; source: StatementMonthSource | null } {
  if (args.aiMonth) return { month: args.aiMonth, source: 'AI' }
  if (args.preselected) return { month: args.preselected, source: 'PRESELECTED' }
  if (args.latestLineMonth) return { month: args.latestLineMonth, source: 'LINES' }
  return { month: null, source: null }
}

/**
 * §8.1：在 transaction 內為每個 section 建 LabStatementSection + LabStatementLine。
 * - section status：識別齊 → PENDING；否則 NEEDS_ASSIGN
 * - line result 一律 PENDING（配對結果 CHUNK 3 先寫）
 * - patientCode：有 clinic 先正規化（normPatientCode 需要 shortName 補前綴）
 * 回建好嘅 section ids（順序同 sections 一致）。
 */
export async function createStatementSections(
  tx: any,
  docId: string,
  args: {
    /** AI 輸出 sections（順序即 sectionIndex） */
    sections: Array<{
      clinicRaw: string | null
      doctorRaw: string | null
      customerNoRaw: string | null
      pageFrom: number | null
      pageTo: number | null
      total: number | null
      currentTotal: number | null
      lines: Array<{
        lineType: string
        docNoRaw: string | null
        date: string | null
        patientRaw: string | null
        patientCodeRaw: string | null
        labCaseRef: string | null
        description: string | null
        toothRaw: string | null
        qty: number | null
        unitPrice: number | null
        amount: number
        agingBucket: string | null
      }>
    }>
    /** 逐段識別結果（同序） */
    idents: SectionIdentifyResult[]
    /** 逐段 clinic shortName（patientCode 正規化用；null = 未識別 clinic） */
    clinicShortNames: Array<string | null>
    normPatientCode: (raw: string | null, shortName: string | null) => string | null
  },
): Promise<string[]> {
  const ymdToDate = (s: string | null): Date | undefined => (s ? new Date(`${s}T00:00:00Z`) : undefined)
  const ids: string[] = []
  for (let si = 0; si < args.sections.length; si++) {
    const s = args.sections[si]
    const ident = args.idents[si]
    const section = await tx.labStatementSection.create({
      data: {
        documentId: docId,
        sectionIndex: si,
        pageFrom: s.pageFrom ?? null,
        pageTo: s.pageTo ?? null,
        clinicRaw: s.clinicRaw,
        doctorRaw: s.doctorRaw,
        customerNoRaw: s.customerNoRaw,
        clinicId: ident.clinicId,
        providerId: ident.providerId,
        clinicBasis: ident.clinicBasis,
        providerBasis: ident.providerBasis,
        statedTotal: s.total,
        statedCurrent: s.currentTotal,
        status: ident.complete ? 'PENDING' : 'NEEDS_ASSIGN',
      },
    })
    ids.push(section.id)
    if (s.lines.length === 0) continue
    const creates = s.lines.map((l, li) => {
      const date = ymdToDate(l.date)
      return {
        sectionId: section.id,
        lineIndex: li,
        lineType: l.lineType,
        docNoRaw: l.docNoRaw,
        docNo: normDocNo(l.docNoRaw),
        date: date ?? null,
        patientRaw: l.patientRaw,
        patientCode: args.normPatientCode(l.patientCodeRaw, args.clinicShortNames[si] ?? null),
        labCaseRef: l.labCaseRef,
        description: l.description,
        toothRaw: l.toothRaw,
        qty: l.qty,
        unitPrice: l.unitPrice,
        amount: l.amount,
        agingBucket: l.agingBucket,
      }
    })
    await tx.labStatementLine.createMany({ data: creates })
  }
  return ids
}

/** 重複衝突（另一份未作廢／未取代月結單嘅同 Lab＋診所＋醫生＋月分段）。 */
export interface StatementDuplicate {
  docId: string
  uploadedAt: Date
  uploadedBy: string
}

/**
 * §8.1 重複偵測（只讀）。clinicId/providerId 任一 null → 無法比對 → null（唔擋；
 * assign 完再查）。statementMonth null → 唔比對。
 */
export async function findStatementSectionDuplicate(
  prisma: any,
  args: {
    labId: string | null
    clinicId: string | null
    providerId: string | null
    statementMonth: string | null
    selfDocId: string
    /** 只當「早過自己上傳」嘅為重複（後上傳嗰份先係重複；原本嗰份唔使擋） */
    selfCreatedAt?: Date | null
  },
): Promise<StatementDuplicate | null> {
  if (!args.labId || !args.clinicId || !args.providerId || !args.statementMonth) return null
  const hit = await prisma.labStatementSection.findFirst({
    where: {
      clinicId: args.clinicId,
      providerId: args.providerId,
      document: {
        id: { not: args.selfDocId },
        ...(args.selfCreatedAt ? { createdAt: { lt: args.selfCreatedAt } } : {}),
        kind: 'STATEMENT',
        labId: args.labId,
        statementMonth: args.statementMonth,
        status: { notIn: ['VOID', 'SUPERSEDED', 'DUPLICATE'] },
      },
    },
    select: {
      document: { select: { id: true, status: true, createdAt: true, uploadedBy: true } },
    },
    orderBy: { document: { createdAt: 'asc' } }, // ★ section 表冇 createdAt — 排序經 document.createdAt（E2E-2 regression）
  })
  if (!hit) return null
  return {
    docId: hit.document.id,
    uploadedAt: hit.document.createdAt,
    uploadedBy: hit.document.uploadedBy,
  }
}

/** readIssues 機器可讀標記（UI 解析）：第 si 段撞咗 docId（HK 日期）。 */
export function sectionDuplicateIssue(si: number, dup: StatementDuplicate): string {
  const hkDay = new Date(dup.uploadedAt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  return `SECTION_DUPLICATE:si=${si};doc=${dup.docId};date=${hkDay}`
}

/**
 * §8.1 擋重複分段（confirm／resolve 用）：有早過自己上傳、仲生效嘅同 Lab＋診所＋醫生＋月月結單 → 回錯誤訊息；
 * 要先「取代舊版」（supersede）。冇重複 → null。
 */
export async function sectionDuplicateBlock(
  prisma: any,
  doc: { id: string; labId: string | null; statementMonth: string | null; createdAt: Date },
  section: { clinicId: string | null; providerId: string | null },
): Promise<string | null> {
  const dup = await findStatementSectionDuplicate(prisma, {
    labId: doc.labId,
    clinicId: section.clinicId,
    providerId: section.providerId,
    statementMonth: doc.statementMonth,
    selfDocId: doc.id,
    selfCreatedAt: doc.createdAt,
  })
  if (!dup) return null
  const hkDay = new Date(dup.uploadedAt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  return `${doc.statementMonth} 呢段（同 Lab、診所、醫生）嘅月結單已經喺 ${hkDay} 上傳 — 要先「取代舊版」先可以處理`
}
