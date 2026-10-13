// ============================================================
// ★ cwm-chequemanual-20261013：手動開票（老闆自己輸入抬頭＋金額）—— 驗證＋寫入規則（唯一來源）
//
//   - 出票診所必填：每間診所嘅公司戶口唔同 → 診所決定用邊本支票簿（ChequeAccountClinic），
//     而且一定要係而家揀緊嗰本支票簿嘅診所。
//   - 未出票（或者張票已作廢）先可以改／刪；已出票要先作廢。刪除 = 軟刪除（deletedAt），
//     舊支票紀錄仲搵到用途。
//   - 併發：改／刪喺 transaction 入面 `SELECT … FOR UPDATE` 鎖住嗰行先查有冇出票；
//     出票（issue）亦鎖同一行再核對抬頭／金額 → 兩邊一定一先一後：
//       改先 → 出票核對唔夾 → 409（唔會印舊數）；出票先 → 改嗰邊見到已出票 → 409。
// ============================================================
import { cleanPayee } from './content'

const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

export const MANUAL_MAX_AMOUNT = 9_999_999.99
export const PAYEE_MAX = 100
export const PURPOSE_MAX = 200

export class ManualChequeError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export interface ManualInput {
  accountId: string
  clinicId: string
  payeeName: string
  amount: number
  purpose: string
}

// 控制字元（換行、tab…）一律唔准；抬頭唔准 *（打印時抬頭前後會加 ** 防加字，唔可以俾人自己砌）
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 純驗證（新增／修改共用）。錯就回中文 error。 */
export function validateManualInput(raw: any): { ok: true; data: ManualInput } | { ok: false; error: string } {
  const b = raw ?? {}
  if (typeof b.accountId !== 'string' || !b.accountId) return { ok: false, error: '請揀出票戶口' }
  if (typeof b.clinicId !== 'string' || !b.clinicId) return { ok: false, error: '請揀出票診所' }

  if (typeof b.payeeName !== 'string') return { ok: false, error: '請輸入支票抬頭' }
  if (CTRL.test(b.payeeName)) return { ok: false, error: '抬頭有唔准用嘅字元（換行／控制字元）' }
  const payeeName = collapse(b.payeeName)
  if (!payeeName || !cleanPayee(payeeName)) return { ok: false, error: '請輸入支票抬頭' }
  if (payeeName.includes('*')) return { ok: false, error: '抬頭唔可以有「*」' }
  if (payeeName.length > PAYEE_MAX) return { ok: false, error: `抬頭最多 ${PAYEE_MAX} 字` }

  if (b.amount === null || b.amount === undefined || b.amount === '' || typeof b.amount === 'boolean') return { ok: false, error: '請輸入金額' }
  if (typeof b.amount !== 'number' && typeof b.amount !== 'string') return { ok: false, error: '金額格式唔啱' }
  if (typeof b.amount === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(b.amount.replace(/,/g, ''))) return { ok: false, error: '金額格式唔啱' }
  const amt = Number(typeof b.amount === 'string' ? b.amount.replace(/,/g, '') : b.amount)
  if (!Number.isFinite(amt)) return { ok: false, error: '金額格式唔啱' }
  if (amt <= 0) return { ok: false, error: '金額要大過 0' }
  if (Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) return { ok: false, error: '金額最多兩個小數位' }
  const amount = Math.round(amt * 100) / 100
  if (amount > MANUAL_MAX_AMOUNT) return { ok: false, error: `金額太大（上限 HK$${MANUAL_MAX_AMOUNT.toLocaleString('en-US')}）` }

  if (typeof b.purpose !== 'string' || CTRL.test(b.purpose.replace(/[\r\n\t]/g, ' '))) return { ok: false, error: '請輸入用途／備註' }
  const purpose = collapse(b.purpose)
  if (!purpose) return { ok: false, error: '請輸入用途／備註' }
  if (purpose.length > PURPOSE_MAX) return { ok: false, error: `用途／備註最多 ${PURPOSE_MAX} 字` }

  return { ok: true, data: { accountId: b.accountId, clinicId: b.clinicId, payeeName, amount, purpose } }
}

/** 戶口要開緊，診所要係用緊呢本支票簿 */
async function assertClinicOnAccount(db: any, accountId: string, clinicId: string): Promise<void> {
  const acc = await db.chequeAccount.findUnique({ where: { id: accountId }, select: { isActive: true } })
  if (!acc || !acc.isActive) throw new ManualChequeError(404, '戶口已停用或者唔存在')
  const map = await db.chequeAccountClinic.findUnique({ where: { clinicId }, select: { accountId: true } })
  if (!map || map.accountId !== accountId) throw new ManualChequeError(400, '呢間診所唔係用呢本支票簿（請喺支票設定揀診所）')
}

async function activeChequeOf(db: any, id: string): Promise<{ chequeNo: string } | null> {
  return db.cheque.findFirst({ where: { sourceType: 'MANUAL', sourceId: id, status: { not: 'VOID' } }, select: { chequeNo: true } })
}

const snap = (m: any) => ({ clinicId: m.clinicId, periodMonth: m.periodMonth, payeeName: m.payeeName, amount: String(m.amount), purpose: m.purpose })

/** 鎖住呢行（transaction 入面用）；冇／已刪 → 404 */
async function lockRow(tx: any, id: string): Promise<any> {
  await tx.$queryRaw`SELECT id FROM "ManualCheque" WHERE id = ${id} FOR UPDATE`
  const row = await tx.manualCheque.findUnique({ where: { id } })
  if (!row || row.deletedAt) throw new ManualChequeError(404, '呢張手動票唔存在（可能已經刪咗）')
  return row
}

export async function createManualCheque(db: any, input: ManualInput, month: string, actorId: string) {
  if (!isMonth(month)) throw new ManualChequeError(400, '月份格式錯（YYYY-MM）')
  await assertClinicOnAccount(db, input.accountId, input.clinicId)
  return db.$transaction(async (tx: any) => {
    const row = await tx.manualCheque.create({
      data: {
        clinicId: input.clinicId, periodMonth: month, payeeName: input.payeeName, amount: input.amount.toFixed(2),
        purpose: input.purpose, createdBy: actorId, updatedBy: actorId,
      },
    })
    await tx.auditLog.create({
      data: {
        actorId, action: 'MANUAL_CHEQUE_CREATE', entity: 'ManualCheque', entityId: row.id, clinicId: input.clinicId,
        notes: `手動開票：${month} · ${input.payeeName} · HK$${input.amount.toFixed(2)} · ${input.purpose}`,
        afterJson: JSON.stringify(snap(row)),
      },
    })
    return row
  })
}

export async function updateManualCheque(db: any, id: string, input: ManualInput, actorId: string) {
  await assertClinicOnAccount(db, input.accountId, input.clinicId)
  return db.$transaction(async (tx: any) => {
    const cur = await lockRow(tx, id)
    const issued = await activeChequeOf(tx, id)
    if (issued) throw new ManualChequeError(409, `已經出咗票 #${issued.chequeNo}，要改請先作廢張票`)
    const row = await tx.manualCheque.update({
      where: { id },
      data: { clinicId: input.clinicId, payeeName: input.payeeName, amount: input.amount.toFixed(2), purpose: input.purpose, updatedBy: actorId },
    })
    await tx.auditLog.create({
      data: {
        actorId, action: 'MANUAL_CHEQUE_UPDATE', entity: 'ManualCheque', entityId: id, clinicId: input.clinicId,
        notes: `修改手動票：${cur.payeeName} HK$${Number(cur.amount).toFixed(2)} → ${input.payeeName} HK$${input.amount.toFixed(2)}`,
        beforeJson: JSON.stringify(snap(cur)),
        afterJson: JSON.stringify(snap(row)),
      },
    })
    return row
  })
}

export async function deleteManualCheque(db: any, id: string, actorId: string): Promise<void> {
  await db.$transaction(async (tx: any) => {
    const cur = await lockRow(tx, id)
    const issued = await activeChequeOf(tx, id)
    if (issued) throw new ManualChequeError(409, `已經出咗票 #${issued.chequeNo}，要刪請先作廢張票`)
    await tx.manualCheque.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId } })
    await tx.auditLog.create({
      data: {
        actorId, action: 'MANUAL_CHEQUE_DELETE', entity: 'ManualCheque', entityId: id, clinicId: cur.clinicId,
        notes: `刪除手動票：${cur.periodMonth} · ${cur.payeeName} · HK$${Number(cur.amount).toFixed(2)} · ${cur.purpose}`,
        beforeJson: JSON.stringify(snap(cur)),
      },
    })
  })
}

/**
 * 出票前（transaction 外）：搵返呢張手動票嘅抬頭同金額。
 * 要：未刪、月份一樣、診所用緊呢本支票簿、未出票。
 */
export async function resolveManual(db: any, id: string, accountId: string, month: string): Promise<{ ok: true; payee: string; amount: number; clinicId: string } | { ok: false; error: string }> {
  const row = await db.manualCheque.findUnique({ where: { id } })
  if (!row || row.deletedAt) return { ok: false, error: '呢張手動票唔存在（可能已經刪咗）' }
  if (row.periodMonth !== month) return { ok: false, error: '搵唔到呢筆（月份唔啱）' }
  const map = await db.chequeAccountClinic.findUnique({ where: { clinicId: row.clinicId }, select: { accountId: true } })
  if (!map || map.accountId !== accountId) return { ok: false, error: '呢張手動票嘅診所唔係用呢本支票簿' }
  const issued = await activeChequeOf(db, id)
  if (issued) return { ok: false, error: `已經出咗票 #${issued.chequeNo}` }
  return { ok: true, payee: cleanPayee(row.payeeName), amount: Number(row.amount), clinicId: row.clinicId }
}

/**
 * 出票 transaction 入面：鎖住手動票，再核對同 resolveManual 讀到嘅一樣（防「讀完先俾人改」）。
 * 唔夾 → throw ManualChequeError(409)。
 */
export async function lockManualForIssue(tx: any, id: string, accountId: string, month: string, expected: { payee: string; amount: number; clinicId: string | null }): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "ManualCheque" WHERE id = ${id} FOR UPDATE`
  const row = await tx.manualCheque.findUnique({ where: { id } })
  const map = row ? await tx.chequeAccountClinic.findUnique({ where: { clinicId: row.clinicId }, select: { accountId: true } }) : null
  if (
    !row || row.deletedAt || row.periodMonth !== month || !map || map.accountId !== accountId ||
    row.clinicId !== expected.clinicId || cleanPayee(row.payeeName) !== expected.payee ||
    Math.abs(Number(row.amount) - expected.amount) > 0.001
  ) {
    throw new ManualChequeError(409, '呢張手動票啱啱改咗或者刪咗，請重新載入再印')
  }
}
