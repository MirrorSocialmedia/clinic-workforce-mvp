import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bitmapToBand, encodeEscp, encodeText, escpGridPage, plainTestPage } from './encode'
import { HSBC_DEFAULT_FIELDS, layoutItems, normalizeFields, shiftAll } from './layout'
import { buildContent } from './content'

const hex = (a: Uint8Array) => Array.from(a, b => b.toString(16).padStart(2, '0')).join(' ')

test('ESC/P：重設、直移 1/180"、橫向 1/60"、10/12 cpi、CR、FF', () => {
  const b = encodeEscp([
    { key: 'a', x: 25.4, y: 25.4, text: 'AB', cpi: 10 },
    { key: 'b', x: 0, y: 25.4, text: 'C', cpi: 12 },
  ])
  // ESC @, ESC U 1, ESC J 180, 同一行先印 x 細嗰個（C @0）再印 AB @60
  assert.equal(hex(b), '1b 40 1b 55 01 1b 4a b4 1b 24 00 00 1b 4d 43 0d 1b 24 3c 00 1b 50 41 42 0d 0c')
})

test('ESC/P：直移超過 255 會分段', () => {
  const b = encodeEscp([{ key: 'a', x: 0, y: 60, text: 'X', cpi: 10 }]) // 60mm = 425/180"
  assert.equal(hex(b.slice(5, 11)), '1b 4a ff 1b 4a aa')
})

test('ESC/P：中文抬頭用點陣圖 ESC * 39', () => {
  const band = bitmapToBand(2, 24, (x, y) => x === 0 && (y === 0 || y === 23))
  assert.equal(hex(band.columns), '80 00 01 00 00 00')
  const b = encodeEscp([{ key: 'payee', x: 0, y: 0, text: '陳大文', cpi: 10 }], { payee: band })
  assert.equal(hex(b), '1b 40 1b 55 01 1b 24 00 00 1b 2a 27 02 00 80 00 01 00 00 00 0d 0c')
})

test('TEXT：位置黐埋 10cpi × 6lpi 格，FF 出紙，冇 ESC', () => {
  const b = encodeText([
    { key: 'a', x: 5.08, y: 0, text: 'HI', cpi: 10 },   // col 2
    { key: 'b', x: 0, y: 8.5, text: 'Z', cpi: 10 },     // row 2
  ])
  assert.equal(Buffer.from(b).toString('latin1'), '  HI\r\n\r\nZ\r\n\f')
  assert.ok(!b.includes(0x1b))
})

test('測試頁：純文字冇 ESC；格仔頁係 ESC/P', () => {
  assert.ok(!plainTestPage().includes(0x1b))
  const g = escpGridPage({ w: 180, h: 88 })
  assert.equal(g[0], 0x1b); assert.equal(g[g.length - 1], 0x0c)
})

test('ESC/P：15 cpi 用 ESC g', () => {
  const b = encodeEscp([{ key: 'a', x: 0, y: 0, text: 'A', cpi: 15 }])
  assert.equal(hex(b), '1b 40 1b 55 01 1b 24 00 00 1b 67 41 0d 0c')
})

test('格仔頁：加打印機偏移，數字係支票座標', () => {
  const g = Buffer.from(escpGridPage({ w: 40, h: 20 }, { x: -4.5, y: -4 })).toString('latin1')
  // 第一個印得到嘅格係支票 (10,10)，頂行標 x，左列標 y
  assert.ok(g.includes('+10') && g.includes('+20') && g.includes('+30'))
  assert.ok(!g.includes('+0'))
})

test('版面 v2：日／月／年各自位置，抬頭加 **，打印時加偏移', () => {
  const f = HSBC_DEFAULT_FIELDS
  const c = buildContent({ payee: 'Lam Ka Yee', amount: 17220, date: '2026-09-30' }, f, 'ESCP')
  assert.ok(c.ok)
  if (!c.ok) return
  const items = layoutItems(f, c.content, { x: -4.5, y: -4 }, 'ESCP')
  const d = items.filter(i => /^(day|month|year)\d$/.test(i.key))
  assert.equal(d.map(i => i.text).join(''), '30092026')
  assert.equal(d.find(i => i.key === 'month0')!.x, f.month.x - 4.5)
  assert.equal(d.find(i => i.key === 'year3')!.x, f.year.x + 3 * f.datePitch - 4.5)
  const payee = items.find(i => i.key === 'payee')!
  assert.equal(payee.text, '** LAM KA YEE **')
  assert.equal(payee.y, f.payee.y - 4)
  assert.equal(items.find(i => i.key === 'amount')!.text, '**17,220.00**')
})

test('內容：塞唔落自動縮細字距；TEXT 唔縮、唔收中文', () => {
  const f = HSBC_DEFAULT_FIELDS
  assert.equal(buildContent({ payee: '陳大文', amount: 1, date: '2026-09-30' }, f, 'TEXT').ok, false)
  assert.equal(buildContent({ payee: '陳大文', amount: 1, date: '2026-09-30' }, f, 'ESCP').ok, true)
  assert.equal(buildContent({ payee: 'A', amount: 0, date: '2026-09-30' }, f, 'ESCP').ok, false)
  // 長抬頭：10 cpi 塞唔落 → 縮細（保留 ** 優先）
  const lab = buildContent({ payee: 'MODERN DENTAL LABORATORY CO LTD', amount: 3456.7, date: '2026-09-30' }, f, 'ESCP')
  assert.ok(lab.ok && lab.content.cpi.payee === 12 && lab.content.payee.startsWith('**'), JSON.stringify(lab))
  // 醫生大額：12 cpi 塞唔落 → 15 cpi
  const big = buildContent({ payee: 'A', amount: 117598.3, date: '2026-09-30' }, f, 'ESCP')
  assert.ok(big.ok && big.content.cpi.words === 15, JSON.stringify(big))
  // 一般人工：12 cpi 已夠
  const pay = buildContent({ payee: 'A', amount: 17598.3, date: '2026-09-30' }, f, 'ESCP')
  assert.ok(pay.ok && pay.content.cpi.words === 12)
  // 太窄：全部字距都唔得
  const narrow = { ...f, words1: { ...f.words1, width: 10 }, words2: { ...f.words2, width: 10 } }
  assert.equal(buildContent({ payee: 'A', amount: 117598.3, date: '2026-09-30' }, narrow, 'ESCP').ok, false)
})

test('normalizeFields：舊版 v1／壞資料 → null；v2 夾範圍', () => {
  assert.equal(normalizeFields(null), null)
  assert.equal(normalizeFields({ paper: { w: 180, h: 88 }, date: { x: 131 } }), null)
  assert.deepEqual(normalizeFields(HSBC_DEFAULT_FIELDS), HSBC_DEFAULT_FIELDS)
  const n = normalizeFields({ ...HSBC_DEFAULT_FIELDS, payee: { x: 'abc', y: 9999, width: 100, cpi: 13 } })!
  assert.equal(n.payee.x, HSBC_DEFAULT_FIELDS.payee.x)
  assert.equal(n.payee.y, 300)
  assert.equal(n.payee.cpi, HSBC_DEFAULT_FIELDS.payee.cpi)
})

test('shiftAll：全部欄位一齊移', () => {
  const s = shiftAll(HSBC_DEFAULT_FIELDS, 1, -2)
  assert.equal(s.day.x, HSBC_DEFAULT_FIELDS.day.x + 1)
  assert.equal(s.amount.y, HSBC_DEFAULT_FIELDS.amount.y - 2)
  assert.equal(s.payee.width, HSBC_DEFAULT_FIELDS.payee.width)
})
