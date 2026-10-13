// ============================================================
// ★ cwm-chequemanual-20261013：手動開票 —— 真 Postgres 對抗式測試（CRUD 狀態機＋併發）
//   跑法: CWM_TEST_DATABASE_URL=postgres://… TZ=UTC npx tsx --test src/lib/cheque-print/manual-db.test.ts
//
//   直接行 production 嘅 lib（manual.ts 新增／修改／刪除／resolveManual、issue.ts 出票 transaction），
//   用自己嘅 fixture（e2emc- 前綴：2 個戶口、3 間診所），after() 必清 + 零殘留 assert。
//   AuditLog append-only（trigger 擋刪）→ 審計行同固定測試用戶會留低（同 t623 一樣，按設計）。
//   ⚠️ tsx 跑 CJS：prisma 要喺 DATABASE_URL 設定之後先 import（.env auto-load 陷阱），全部 import 入 before()。
// ============================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const P = 'e2emc-'
const ACTOR = `${P}actor`
const ACC_X = `${P}acc-x`
const ACC_Y = `${P}acc-y`
const ACC_OFF = `${P}acc-off`
const CL_A = `${P}clinic-a` // 用 X
const CL_B = `${P}clinic-b` // 用 X
const CL_C = `${P}clinic-c` // 用 Y
const MONTH = '2031-07' // 遠未來月份，唔會撞真數據

let db: any
let M: typeof import('./manual')
let I: typeof import('./issue')
let R: typeof import('./records')
let dbDown = false

async function cleanup() {
  const manualIds = (await db.manualCheque.findMany({ where: { clinicId: { startsWith: P } }, select: { id: true } })).map((m: any) => m.id)
  await db.cheque.deleteMany({ where: { accountId: { startsWith: P } } })
  await db.manualCheque.deleteMany({ where: { id: { in: manualIds } } })
  await db.labChequeAmount.deleteMany({ where: { clinicId: { startsWith: P } } })
  await db.chequeAccountClinic.deleteMany({ where: { clinicId: { startsWith: P } } })
  await db.chequeAccount.deleteMany({ where: { id: { startsWith: P } } })
  await db.clinic.deleteMany({ where: { id: { startsWith: P } } })
}

before(async () => {
  process.env.DATABASE_URL = process.env.CWM_TEST_DATABASE_URL ?? 'postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce?schema=public'
  const [pm, m, i, r] = await Promise.all([import('@/lib/prisma'), import('./manual'), import('./issue'), import('./records')])
  db = pm.basePrisma
  M = m; I = i; R = r
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    dbDown = true
    return
  }
  await cleanup()
  await db.user.upsert({ where: { id: ACTOR }, create: { id: ACTOR, name: 'E2E 手動票', phone: '90000000-e2emc', password: 'x', role: 'OWNER' }, update: {} })
  await db.clinic.createMany({ data: [{ id: CL_A, name: 'E2E 甲店' }, { id: CL_B, name: 'E2E 乙店' }, { id: CL_C, name: 'E2E 丙店' }] })
  await db.chequeAccount.createMany({
    data: [
      { id: ACC_X, label: 'E2E 甲乙 匯豐', bookFirstNo: 500001, bookLastNo: 500200, nextNo: 500001 },
      { id: ACC_Y, label: 'E2E 丙 匯豐', bookFirstNo: 700001, bookLastNo: 700050, nextNo: 700001 },
      { id: ACC_OFF, label: 'E2E 停用', isActive: false, nextNo: 1 },
    ],
  })
  await db.chequeAccountClinic.createMany({ data: [{ clinicId: CL_A, accountId: ACC_X }, { clinicId: CL_B, accountId: ACC_X }, { clinicId: CL_C, accountId: ACC_Y }] })
})

after(async () => {
  if (!dbDown && db) {
    await cleanup()
    const left = await Promise.all([
      db.manualCheque.count({ where: { clinicId: { startsWith: P } } }),
      db.cheque.count({ where: { accountId: { startsWith: P } } }),
      db.chequeAccount.count({ where: { id: { startsWith: P } } }),
      db.clinic.count({ where: { id: { startsWith: P } } }),
    ])
    assert.deepEqual(left, [0, 0, 0, 0], '零殘留')
  }
  await db?.$disconnect()
})

const input = (o: any = {}) => {
  const v = M.validateManualInput({ accountId: ACC_X, clinicId: CL_A, payeeName: 'Hongkong Electric Co Ltd', amount: 3486.2, purpose: '電費', ...o })
  assert.ok(v.ok, JSON.stringify(o))
  return v.data
}
const status = async (p: Promise<unknown>) => {
  try { await p; return 'ok' } catch (e: any) { return e instanceof M.ManualChequeError || e instanceof I.HttpError ? e.status : (e?.code ?? String(e)) }
}
async function issue(id: string, accountId = ACC_X) {
  const src = await M.resolveManual(db, id, accountId, MONTH)
  if (!src.ok) throw new M.ManualChequeError(409, src.error)
  return I.issueCheque(db, { accountId, month: MONTH, chequeDate: '2031-07-31', sourceType: 'MANUAL', sourceId: id, actorId: ACTOR }, src)
}
const nextNo = async (acc = ACC_X) => (await db.chequeAccount.findUnique({ where: { id: acc } })).nextNo

test('新增：寫入正確（Decimal 精度）＋審計；診所唔屬呢本支票簿／戶口停用／錯月份 → 擋，唔寫任何嘢', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const row = await M.createManualCheque(db, input({ amount: 0.07 }), MONTH, ACTOR)
  const back = await db.manualCheque.findUnique({ where: { id: row.id } })
  assert.equal(back.amount.toString(), '0.07')
  assert.equal(back.periodMonth, MONTH)
  assert.equal(back.createdBy, ACTOR)
  const audit = await db.auditLog.findFirst({ where: { entityId: row.id, action: 'MANUAL_CHEQUE_CREATE' } })
  assert.ok(audit && audit.clinicId === CL_A)

  const big = await M.createManualCheque(db, input({ amount: M.MANUAL_MAX_AMOUNT }), MONTH, ACTOR)
  assert.equal((await db.manualCheque.findUnique({ where: { id: big.id } })).amount.toString(), '9999999.99')

  const before = await db.manualCheque.count({ where: { clinicId: { startsWith: P } } })
  assert.equal(await status(M.createManualCheque(db, input({ clinicId: CL_C }), MONTH, ACTOR)), 400) // 丙店用 Y 簿
  assert.equal(await status(M.createManualCheque(db, input({ clinicId: `${P}no-such` }), MONTH, ACTOR)), 400)
  assert.equal(await status(M.createManualCheque(db, input({ accountId: ACC_OFF }), MONTH, ACTOR)), 404)
  assert.equal(await status(M.createManualCheque(db, input(), '2031-13', ACTOR)), 400)
  assert.equal(await status(M.createManualCheque(db, input(), undefined as any, ACTOR)), 400)
  assert.equal(await db.manualCheque.count({ where: { clinicId: { startsWith: P } } }), before, '擋咗嘅唔可以寫入')

  // DB 層 CHECK：就算繞過驗證，金額 ≤ 0 都入唔到
  await assert.rejects(db.manualCheque.create({ data: { clinicId: CL_A, periodMonth: MONTH, payeeName: 'X', amount: '0', purpose: 'x', createdBy: ACTOR, updatedBy: ACTOR } }))
  await assert.rejects(db.manualCheque.create({ data: { clinicId: CL_A, periodMonth: MONTH, payeeName: 'X', amount: '-1', purpose: 'x', createdBy: ACTOR, updatedBy: ACTOR } }))
})

test('修改／刪除：未出票可以；出咗票 409（金額唔郁）；作廢後可以再改再出，舊票保留舊金額', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const row = await M.createManualCheque(db, input({ amount: 100 }), MONTH, ACTOR)
  const upd = await M.updateManualCheque(db, row.id, input({ amount: 120.5, payeeName: 'ABC Ltd', clinicId: CL_B }), ACTOR)
  assert.equal(upd.amount.toString(), '120.5')
  assert.equal(upd.clinicId, CL_B)
  assert.equal(upd.periodMonth, MONTH, '月份唔會俾修改改到')
  const ua = await db.auditLog.findFirst({ where: { entityId: row.id, action: 'MANUAL_CHEQUE_UPDATE' } })
  assert.equal(JSON.parse(ua.beforeJson).amount, '100')
  assert.equal(JSON.parse(ua.afterJson).amount, '120.5')
  // 改去另一本支票簿嘅診所 → 擋
  assert.equal(await status(M.updateManualCheque(db, row.id, input({ clinicId: CL_C }), ACTOR)), 400)

  const n0 = await nextNo()
  const c1 = await issue(row.id)
  assert.equal(c1.sourceType, 'MANUAL')
  assert.equal(c1.payeeName, 'ABC LTD', '抬頭出票時轉大階')
  assert.equal(Number(c1.amount), 120.5)
  assert.equal(c1.clinicId, CL_B)
  assert.equal(await nextNo(), n0 + 1)

  assert.equal(await status(M.updateManualCheque(db, row.id, input({ amount: 999 }), ACTOR)), 409)
  assert.equal(await status(M.deleteManualCheque(db, row.id, ACTOR)), 409)
  assert.equal((await db.manualCheque.findUnique({ where: { id: row.id } })).amount.toString(), '120.5')
  assert.equal(await status(issue(row.id)), 409, '同一張唔可以出兩次')
  assert.equal(await nextNo(), n0 + 1, '擋咗唔會用號碼')

  await db.cheque.update({ where: { id: c1.id }, data: { status: 'VOID', voidReason: '測試', voidedAt: new Date() } })
  await M.updateManualCheque(db, row.id, input({ amount: 130, payeeName: 'ABC Ltd', clinicId: CL_B }), ACTOR)
  const c2 = await issue(row.id)
  assert.notEqual(c2.chequeNo, c1.chequeNo)
  assert.equal(Number(c2.amount), 130)
  assert.equal(Number((await db.cheque.findUnique({ where: { id: c1.id } })).amount), 120.5, '作廢嗰張保留當時金額')
})

test('軟刪除：唔再出現、唔出到票、再改再刪 404；支票紀錄仲搵到用途', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const row = await M.createManualCheque(db, input({ purpose: '裝修按金退還' }), MONTH, ACTOR)
  const c = await issue(row.id)
  await db.cheque.update({ where: { id: c.id }, data: { status: 'VOID', voidReason: '唔使開', voidedAt: new Date() } })
  await M.deleteManualCheque(db, row.id, ACTOR)
  const gone = await db.manualCheque.findUnique({ where: { id: row.id } })
  assert.ok(gone.deletedAt && gone.deletedBy === ACTOR, '軟刪除')
  assert.equal(await status(M.updateManualCheque(db, row.id, input(), ACTOR)), 404)
  assert.equal(await status(M.deleteManualCheque(db, row.id, ACTOR)), 404)
  assert.equal(await status(issue(row.id)), 409)
  assert.equal(await status(M.updateManualCheque(db, `${P}nope`, input(), ACTOR)), 404)
  assert.ok(await db.auditLog.findFirst({ where: { entityId: row.id, action: 'MANUAL_CHEQUE_DELETE' } }))

  const { rows } = await R.loadChequeRecords({ from: MONTH, to: MONTH, accountId: ACC_X, kind: 'MANUAL', status: null, q: null })
  const rec = rows.find(r => r.id === c.id)
  assert.ok(rec, '支票紀錄搵到')
  assert.equal(rec!.kind, 'MANUAL')
  assert.equal(rec!.refLabel, '裝修按金退還', '已刪嘅手動票仲顯示用途')
  assert.equal(rec!.status, 'VOID')
})

test('出票：錯戶口／錯月份 → 擋；中文抬頭原樣', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const row = await M.createManualCheque(db, input({ payeeName: '香港電燈有限公司' }), MONTH, ACTOR)
  assert.equal((await M.resolveManual(db, row.id, ACC_Y, MONTH)).ok, false)
  assert.equal((await M.resolveManual(db, row.id, ACC_X, '2031-08')).ok, false)
  const c = await issue(row.id)
  assert.equal(c.payeeName, '香港電燈有限公司')
})

test('race：讀完抬頭金額之後先俾人改 → 出票核對唔夾 409，唔會印舊數、唔用號碼', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const row = await M.createManualCheque(db, input({ amount: 500 }), MONTH, ACTOR)
  const stale = await M.resolveManual(db, row.id, ACC_X, MONTH)
  assert.ok(stale.ok && stale.amount === 500)
  await M.updateManualCheque(db, row.id, input({ amount: 5000 }), ACTOR)
  const n0 = await nextNo()
  const args = { accountId: ACC_X, month: MONTH, chequeDate: '2031-07-31', sourceType: 'MANUAL' as const, sourceId: row.id, actorId: ACTOR }
  assert.equal(await status(I.issueCheque(db, args, stale)), 409)
  assert.equal(await db.cheque.count({ where: { sourceId: row.id } }), 0)
  assert.equal(await nextNo(), n0)
  // 讀完先俾人刪
  const row2 = await M.createManualCheque(db, input(), MONTH, ACTOR)
  const stale2 = await M.resolveManual(db, row2.id, ACC_X, MONTH)
  await M.deleteManualCheque(db, row2.id, ACTOR)
  assert.ok(stale2.ok)
  assert.equal(await status(I.issueCheque(db, { ...args, sourceId: row2.id }, stale2)), 409)
  // 讀完先俾人將診所改去另一間（同一本簿）→ 都要擋（記錄嘅診所會錯）
  const row3 = await M.createManualCheque(db, input(), MONTH, ACTOR)
  const stale3 = await M.resolveManual(db, row3.id, ACC_X, MONTH)
  await M.updateManualCheque(db, row3.id, input({ clinicId: CL_B }), ACTOR)
  assert.ok(stale3.ok)
  assert.equal(await status(I.issueCheque(db, { ...args, sourceId: row3.id }, stale3)), 409)
})

test('真併發 × 30 輪：出票 vs 修改金額／刪除 —— 已出嘅票一定同記錄一致，刪咗嘅一定冇有效票', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  let issuedWins = 0, editWins = 0
  for (let i = 0; i < 30; i++) {
    const row = await M.createManualCheque(db, input({ amount: 1000 + i }), MONTH, ACTOR)
    // 出票嗰邊先讀好抬頭金額（同 route 一樣），之後兩邊同時衝；改／刪嗰邊隨機遲 0–25ms → 兩個次序都會出現
    const src = await M.resolveManual(db, row.id, ACC_X, MONTH)
    assert.ok(src.ok)
    const args = { accountId: ACC_X, month: MONTH, chequeDate: '2031-07-31', sourceType: 'MANUAL' as const, sourceId: row.id, actorId: ACTOR }
    const delay = (i * 7) % 26
    const action = new Promise(r => setTimeout(r, delay)).then(() => i % 3 === 2
      ? M.deleteManualCheque(db, row.id, ACTOR)
      : M.updateManualCheque(db, row.id, input({ amount: 2000 + i, payeeName: `Edited ${i}` }), ACTOR))
    const [iss, act] = await Promise.all([status(I.issueCheque(db, args, src)), status(action)])
    const m = await db.manualCheque.findUnique({ where: { id: row.id } })
    const live = await db.cheque.findMany({ where: { sourceType: 'MANUAL', sourceId: row.id, status: { not: 'VOID' } } })
    assert.ok(!(iss === 'ok' && act === 'ok'), `第 ${i} 輪：出票同改／刪唔可以兩樣都成功`)
    assert.ok(iss === 'ok' || act === 'ok', `第 ${i} 輪：至少一樣成功（${iss} / ${act}）`)
    if (iss === 'ok') {
      issuedWins++
      assert.equal(live.length, 1)
      assert.equal(m.deletedAt, null, '有有效票就唔可以被刪')
      assert.equal(Number(live[0].amount), Number(m.amount), `第 ${i} 輪：票面金額 = 記錄金額`)
      assert.equal(live[0].payeeName, m.payeeName.toUpperCase())
    } else {
      editWins++
      assert.equal(live.length, 0)
    }
  }
  t.diagnostic(`出票贏 ${issuedWins} 輪、改／刪贏 ${editWins} 輪`)
  assert.equal(issuedWins + editWins, 30)
  assert.ok(issuedWins > 0 && editWins > 0, '兩個次序都要測到')
})

test('真併發：同一張手動票同時出 5 次 → 只會有 1 張有效票、號碼冇重複', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const row = await M.createManualCheque(db, input({ amount: 77.7 }), MONTH, ACTOR)
  const res = await Promise.all(Array.from({ length: 5 }, () => status(issue(row.id))))
  assert.equal(res.filter(r => r === 'ok').length, 1, JSON.stringify(res))
  assert.equal(await db.cheque.count({ where: { sourceType: 'MANUAL', sourceId: row.id, status: { not: 'VOID' } } }), 1)
  const nos = (await db.cheque.findMany({ where: { accountId: ACC_X }, select: { chequeNo: true } })).map((c: any) => c.chequeNo)
  assert.equal(new Set(nos).size, nos.length, '同一本簿號碼冇重複')
})

test('Lab 金額：讀完之後先俾人改 → 出票 409（同一個鎖行核對）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const lab = await db.labChequeAmount.create({ data: { labId: `${P}lab`, clinicId: CL_A, periodMonth: MONTH, amount: '300', updatedBy: ACTOR } })
  const args = { accountId: ACC_X, month: MONTH, chequeDate: '2031-07-31', sourceType: 'LAB_AMOUNT' as const, sourceId: lab.id, actorId: ACTOR }
  await db.labChequeAmount.update({ where: { id: lab.id }, data: { amount: '350' } })
  assert.equal(await status(I.issueCheque(db, args, { payee: 'LAB', amount: 300, clinicId: CL_A })), 409)
  const ok = await I.issueCheque(db, args, { payee: 'LAB', amount: 350, clinicId: CL_A })
  assert.equal(Number(ok.amount), 350)
})
