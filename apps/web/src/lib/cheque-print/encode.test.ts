import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bitmapToBand, encodeEscp, encodeText, escpGridPage, plainTestPage } from './encode'
import { HSBC_DEFAULT_FIELDS, layoutItems, normalizeFields, dateDigitXs, fieldChars } from './layout'
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

test('版面：日期 8 格 DDMMYYYY 加偏移', () => {
  const f = HSBC_DEFAULT_FIELDS
  const xs = dateDigitXs(f.date)
  assert.equal(xs.length, 8)
  assert.equal(xs[2] - xs[1], f.date.pitch + f.date.gap1)
  const c = buildContent({ payee: 'Lam Ka Yee', amount: 17220, date: '2026-09-30' }, f, 'ESCP')
  assert.ok(c.ok)
  if (!c.ok) return
  const items = layoutItems(f, c.content, { x: 1.5, y: -0.5 }, 'ESCP')
  assert.equal(items.filter(i => i.key.startsWith('date')).map(i => i.text).join(''), '30092026')
  const payee = items.find(i => i.key === 'payee')!
  assert.equal(payee.text, '** LAM KA YEE **')
  assert.equal(payee.x, f.payee.x + 1.5)
  assert.equal(payee.y, f.payee.y - 0.5)
  assert.equal(items.find(i => i.key === 'amount')!.text, '**17,220.00**')
})

test('內容驗證：TEXT 模式唔收中文抬頭；金額 0 擋；大寫塞唔落擋', () => {
  const f = HSBC_DEFAULT_FIELDS
  assert.equal(buildContent({ payee: '陳大文', amount: 1, date: '2026-09-30' }, f, 'TEXT').ok, false)
  assert.equal(buildContent({ payee: '陳大文', amount: 1, date: '2026-09-30' }, f, 'ESCP').ok, true)
  assert.equal(buildContent({ payee: 'A', amount: 0, date: '2026-09-30' }, f, 'ESCP').ok, false)
  const narrow = normalizeFields({ ...f, words1: { ...f.words1, width: 10 }, words2: { ...f.words2, width: 10 } })
  assert.equal(buildContent({ payee: 'A', amount: 117598.3, date: '2026-09-30' }, narrow, 'ESCP').ok, false)
  // 預設版面：大額都要塞得落
  const big = buildContent({ payee: 'A', amount: 777777.77, date: '2026-09-30' }, f, 'ESCP')
  assert.ok(big.ok, JSON.stringify(big))
  assert.ok(fieldChars(f, 'ESCP').words2 >= 55)
})

test('normalizeFields：壞 JSON 用預設；數值夾住範圍', () => {
  assert.deepEqual(normalizeFields(null), HSBC_DEFAULT_FIELDS)
  const n = normalizeFields({ payee: { x: 'abc', y: 9999, width: 100 } })
  assert.equal(n.payee.x, HSBC_DEFAULT_FIELDS.payee.x)
  assert.equal(n.payee.y, 300)
  assert.equal(n.payee.width, 100)
})
