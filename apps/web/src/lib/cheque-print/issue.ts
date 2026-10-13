// ============================================================
// ★ cwm-chequeprint-20261005：出票 transaction（攞下一個支票號碼＋記錄）
//   ★ cwm-chequemanual-20261013：由 issue route 抽出嚟（真 DB 測試直接行呢段），行為不變，
//     另加人手來源（手動票／Lab 金額）鎖行再核對。
// ============================================================
import { formatNo, type SourceType } from './server'
import { lockManualForIssue } from './manual'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export interface IssueArgs {
  accountId: string
  month: string
  chequeDate: string
  sourceType: SourceType
  sourceId: string
  actorId: string
}

/** src = resolveSource 讀到嘅抬頭／金額（transaction 外讀，transaction 入面再核對人手來源） */
export async function issueCheque(db: any, a: IssueArgs, src: { payee: string; amount: number; clinicId: string | null }) {
  const { accountId, month, chequeDate, sourceType, sourceId, actorId } = a
  return db.$transaction(async (tx: any) => {
    // 鎖住戶口行，兩個分頁同時印都唔會撞號
    await tx.$queryRaw`SELECT id FROM "ChequeAccount" WHERE id = ${accountId} FOR UPDATE`
    const acc = await tx.chequeAccount.findUnique({ where: { id: accountId } })
    if (!acc || !acc.isActive) throw new HttpError(404, '戶口已停用或者唔存在')
    if (acc.nextNo == null) throw new HttpError(409, '未設定支票簿號碼（支票設定）')
    const used = new Set((await tx.cheque.findMany({ where: { accountId }, select: { chequeNo: true } })).map((c: { chequeNo: string }) => c.chequeNo))
    let n = acc.nextNo
    while (used.has(formatNo(n, acc.noWidth))) n++
    if (acc.bookLastNo != null && n > acc.bookLastNo) throw new HttpError(409, '支票簿用完，請喺支票設定換新簿')
    // ★ cwm-chequemanual-20261013：人手輸入嘅來源（手動票／Lab 金額）讀完到寫之間可能俾人改咗
    //   → 鎖住來源行再核對一次；唔夾就唔出票（唔會印舊數）。改／刪嗰邊亦鎖同一行，一定一先一後。
    if (sourceType === 'MANUAL') {
      await lockManualForIssue(tx, sourceId, accountId, month, { payee: src.payee, amount: src.amount, clinicId: src.clinicId })
    } else if (sourceType === 'LAB_AMOUNT') {
      await tx.$queryRaw`SELECT id FROM "LabChequeAmount" WHERE id = ${sourceId} FOR UPDATE`
      const lab = await tx.labChequeAmount.findUnique({ where: { id: sourceId }, select: { amount: true, clinicId: true, periodMonth: true } })
      if (!lab || Math.abs(Number(lab.amount) - src.amount) > 0.001 || lab.clinicId !== src.clinicId || lab.periodMonth !== month) {
        throw new HttpError(409, 'Lab 月結金額啱啱改咗，請重新載入再印')
      }
    }
    const chequeNo = formatNo(n, acc.noWidth)
    const row = await tx.cheque.create({
      data: {
        accountId, chequeNo, sourceType, sourceId, periodMonth: month, clinicId: src.clinicId,
        payeeName: src.payee, amount: src.amount, chequeDate, printedBy: actorId,
      },
    })
    await tx.chequeAccount.update({ where: { id: accountId }, data: { nextNo: n + 1 } })
    if (sourceType === 'PAYROLL_ITEM') {
      await tx.payrollItem.update({ where: { id: sourceId }, data: { chequeNo } })
    }
    await tx.auditLog.create({
      data: {
        actorId: actorId, action: 'CHEQUE_ISSUE', entity: 'Cheque', entityId: row.id, clinicId: src.clinicId,
        notes: `${acc.label} #${chequeNo} · ${sourceType} · HK$${src.amount.toFixed(2)} · ${chequeDate}`,
      },
    })
    return row
  })
}
