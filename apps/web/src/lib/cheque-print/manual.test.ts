// ★ cwm-chequemanual-20261013：手動開票輸入驗證（對抗式：怪金額、怪字元、邊界）
//   跑法: TZ=UTC npx tsx --test src/lib/cheque-print/manual.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateManualInput, MANUAL_MAX_AMOUNT } from './manual'

const base = { accountId: 'acc1', clinicId: 'c1', payeeName: '香港電燈有限公司', amount: 3486.2, purpose: '9 月電費' }
const err = (o: any) => { const v = validateManualInput({ ...base, ...o }); return v.ok ? null : v.error }
const ok = (o: any) => { const v = validateManualInput({ ...base, ...o }); assert.ok(v.ok, JSON.stringify(o)); return v.data }

test('正常：中英文抬頭、空格壓縮、金額兩位小數（浮點唔誤判）', () => {
  assert.equal(ok({ payeeName: '  ABC   Dental  Supplies Ltd ' }).payeeName, 'ABC Dental Supplies Ltd')
  for (const amount of [0.01, 0.07, 0.29, 1.1, 3486.2, 1234567.89, MANUAL_MAX_AMOUNT]) assert.equal(ok({ amount }).amount, amount)
  assert.equal(ok({ amount: '1,234.50' }).amount, 1234.5)
  assert.equal(ok({ amount: ' 88 ' }).amount, 88)
  assert.equal(ok({ purpose: '  9 月\n電費 ' }).purpose, '9 月 電費')
})

test('出票戶口／診所必填（診所決定用邊個公司戶口）', () => {
  assert.equal(err({ clinicId: '' }), '請揀出票診所')
  assert.equal(err({ clinicId: undefined }), '請揀出票診所')
  assert.equal(err({ clinicId: 123 }), '請揀出票診所')
  assert.equal(err({ accountId: '' }), '請揀出票戶口')
})

test('金額：0、負數、三位小數、科學記號、NaN、Infinity、超上限、布林、陣列 → 擋', () => {
  assert.equal(err({ amount: 0 }), '金額要大過 0')
  assert.equal(err({ amount: -5 }), '金額要大過 0')
  assert.equal(err({ amount: '-5' }), '金額格式唔啱')
  assert.equal(err({ amount: 1.234 }), '金額最多兩個小數位')
  assert.equal(err({ amount: '1.234' }), '金額最多兩個小數位')
  assert.equal(err({ amount: '1e3' }), '金額格式唔啱')
  assert.equal(err({ amount: '0x10' }), '金額格式唔啱')
  assert.equal(err({ amount: 'abc' }), '金額格式唔啱')
  assert.equal(err({ amount: NaN }), '金額格式唔啱')
  assert.equal(err({ amount: Infinity }), '金額格式唔啱')
  assert.match(err({ amount: MANUAL_MAX_AMOUNT + 0.01 })!, /金額太大/)
  assert.match(err({ amount: 1e15 })!, /金額太大/)
  assert.equal(err({ amount: true }), '請輸入金額')
  assert.equal(err({ amount: null }), '請輸入金額')
  assert.equal(err({ amount: '' }), '請輸入金額')
  assert.notEqual(err({ amount: [5] }), null)
  assert.notEqual(err({ amount: { valueOf: () => 5 } }), null)
})

test('抬頭：空白、換行／控制字元、「*」（防假 ** 邊界）、超長 → 擋', () => {
  assert.equal(err({ payeeName: '   ' }), '請輸入支票抬頭')
  assert.equal(err({ payeeName: 42 }), '請輸入支票抬頭')
  assert.match(err({ payeeName: 'ABC\nLTD' })!, /唔准用嘅字元/)
  assert.match(err({ payeeName: 'ABC\u0000' })!, /唔准用嘅字元/)
  assert.match(err({ payeeName: 'ABC LTD' })!, /唔准用嘅字元/)
  assert.equal(err({ payeeName: 'ABC ** OR BEARER' }), '抬頭唔可以有「*」')
  assert.match(err({ payeeName: 'A'.repeat(101) })!, /最多 100 字/)
  assert.equal(ok({ payeeName: 'A'.repeat(100) }).payeeName.length, 100)
})

test('用途：必填、控制字元、超長 → 擋', () => {
  assert.equal(err({ purpose: '' }), '請輸入用途／備註')
  assert.equal(err({ purpose: '  ' }), '請輸入用途／備註')
  assert.equal(err({ purpose: undefined }), '請輸入用途／備註')
  assert.equal(err({ purpose: 'x\u0007' }), '請輸入用途／備註')
  assert.match(err({ purpose: 'x'.repeat(201) })!, /最多 200 字/)
})

test('奇怪 body：null／陣列／多餘欄位唔會影響結果', () => {
  assert.equal(validateManualInput(null).ok, false)
  assert.equal(validateManualInput([]).ok, false)
  const d = ok({ id: 'hack', createdBy: 'someone', deletedAt: null, periodMonth: '1999-01' })
  assert.deepEqual(Object.keys(d).sort(), ['accountId', 'amount', 'clinicId', 'payeeName', 'purpose'])
})
