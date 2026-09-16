/**
 * quote-parser.ts 單測（cwi-followup-p4-20260916 S2 — MD §5.2 確定性層）
 *
 * 🔴 必過：MD §5.2 三個實測樣本（逐字貼入）。
 * 另：金額變體（4K/900@/5-6K/12000$/18k）+ FDI（獨立/範圍/唔係牙位）+
 *   意向詞（quoted/suggest/consider/TCA = 未做 — 鐵律 §6.5）+ 術語表增刪即時生效。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuote, type TermEntry } from './quote-parser'

// dev seed（scripts/seed-followup-p4.ts 同款）
const TERMS: TermEntry[] = [
  { shorthand: 'x', nameCn: '拔牙', nameEn: 'extraction', active: true },
  { shorthand: 'rsd', nameCn: '牙根刮治', nameEn: 'root planing', active: true },
  { shorthand: 'br', nameCn: '牙橋', nameEn: 'bridge', active: true },
  { shorthand: 'implant', nameCn: '植牙', nameEn: 'implant', active: true },
  { shorthand: 'SP', nameCn: '洗牙', nameEn: 'scaling', active: true },
  { shorthand: 'INV', nameCn: '隱形牙箍', nameEn: 'invisible aligner', active: true },
  { shorthand: 'FILLING', nameCn: '補牙', nameEn: 'filling', active: true },
  { shorthand: 'FILL', nameCn: '補牙', nameEn: 'filling', active: true },
  { shorthand: 'BLEACHING', nameCn: '牙齒美白', nameEn: 'bleaching', active: true },
  { shorthand: 'DURAPHAT', nameCn: '氟保護漆 (DURAPHAT)', nameEn: 'duraphat', active: true },
  { shorthand: 'ANTI SNORING DEVICE', nameCn: '止鼾牙套', nameEn: 'anti snoring device', active: true },
]

// ── MD §5.2 三實測樣本（逐字）──────────────────────────────────────────
const S1 = 'need perio by dr wong, quoted 3 part 12000$ / 36 37 imlpant'
const S2 = 'SP DURAPHAT / FILLING X1 / TCA / BLEACHING 4K / FILL 900@ / ANTI SNORING DEVICE 5-6K'
const S3 = 'suggest br 32-42 ... quoted br per unit 5500 or implant 31 41 / consider x 37 + implant 18k'

describe('MD §5.2 三實測樣本（逐字）', () => {
  it('S1：12000 抽出 + FDI 36/37 標記 + 術語唔中（perio/imlpant 錯字）→ LLM 層', () => {
    const r = parseQuote(S1, TERMS)
    assert.equal(r.items.length, 2)
    const amount = r.items.find((i) => i.amountMin === 12000)
    assert.ok(amount, '12000$ 要抽出')
    assert.equal(amount!.intent, 'not_done') // quoted
    const implantish = r.items.find((i) => i.text === 'imlpant')
    assert.ok(implantish, 'imlpant（錯字）照標 orphan')
    assert.deepEqual(implantish!.fdiTeeth, ['36', '37'])
    assert.equal(implantish!.certainty, 'low')
    assert.equal(r.needsLlm, true, '術語唔中 → 第二層 LLM')
  })

  it('S2：全 7 項抽出 + 4K→4000 / 900@→perUnit / 5-6K→range / TCA=未做', () => {
    const r = parseQuote(S2, TERMS)
    assert.equal(r.items.length, 7)
    const byText = (t: string) => r.items.find((i) => i.text === t)
    assert.ok(byText('SP'))
    assert.ok(byText('DURAPHAT'))
    assert.ok(byText('FILLING'))
    const tca = byText('TCA')
    assert.ok(tca, 'TCA 獨立項')
    assert.equal(tca!.intent, 'not_done')
    assert.equal(byText('BLEACHING')!.amountMin, 4000)
    assert.equal(byText('BLEACHING')!.amountMax, 4000)
    assert.equal(byText('FILL')!.amountMin, 900)
    assert.equal(byText('FILL')!.perUnit, true, '900@ = per unit')
    assert.equal(byText('ANTI SNORING DEVICE')!.amountMin, 5000)
    assert.equal(byText('ANTI SNORING DEVICE')!.amountMax, 6000, '5-6K = range')
    assert.equal(r.needsLlm, false, '全術語命中 → 唔使 LLM')
  })

  it('S3：br 5500 perUnit + FDI 32-42 展開 + implant 31/41 + x 37 + 18k；suggest/consider/quoted 全標未做', () => {
    const r = parseQuote(S3, TERMS)
    assert.equal(r.needsLlm, false)
    const br3242 = r.items.find((i) => i.text === 'br' && i.fdiTeeth.includes('32') && i.fdiTeeth.includes('42'))
    assert.ok(br3242, 'br 32-42 FDI 範圍展開')
    assert.equal(br3242!.fdiTeeth.length, 11) // 32..42
    assert.equal(br3242!.intent, 'not_done') // suggest
    const brPrice = r.items.find((i) => i.text === 'br' && i.amountMin === 5500)
    assert.ok(brPrice, 'br per unit 5500')
    assert.equal(brPrice!.perUnit, true)
    assert.equal(brPrice!.intent, 'not_done') // quoted
    const implantFdi = r.items.find((i) => i.text === 'implant' && i.fdiTeeth.length === 2)
    assert.deepEqual(implantFdi!.fdiTeeth, ['31', '41'])
    const x37 = r.items.find((i) => i.text === 'x' && i.fdiTeeth[0] === '37')
    assert.ok(x37, 'x 37（拔牙 FDI 37）')
    assert.equal(x37!.intent, 'not_done') // consider
    const implant18k = r.items.find((i) => i.text === 'implant' && i.amountMin === 18000)
    assert.ok(implant18k, 'implant 18k → 18000')
    assert.equal(implant18k!.intent, 'not_done')
    // 鐵律 §6.5：suggest/consider = 建議未做 — 全部 not_done
    assert.ok(r.items.every((i) => i.intent === 'not_done'), '三意向詞全段 = not_done')
  })
})

describe('金額／FDI／意向詞 邊界', () => {
  it('FDI 11–48 外唔係牙位（09/49/50）；1-2 位數字唔係金額', () => {
    const r = parseQuote('x 49 09 / implant 50 11', TERMS)
    const x = r.items.find((i) => i.text === 'x')!
    assert.deepEqual(x.fdiTeeth, []) // 49/09 唔合法
    const im = r.items.find((i) => i.text === 'implant')!
    assert.deepEqual(im.fdiTeeth, ['11']) // 只 11 合法
  })

  it('無術語無金額無牙位 = 唔係報價項（零 items）', () => {
    const r = parseQuote('routine check, no issue', TERMS)
    assert.equal(r.items.length, 0)
    assert.equal(r.needsLlm, false)
  })

  it('空入 = 零 items', () => {
    assert.deepEqual(parseQuote('', TERMS).items, [])
  })

  it('術語表停用（active=false）唔匹配 → 落 orphan/LLM', () => {
    const terms = TERMS.map((t) => (t.shorthand === 'br' ? { ...t, active: false } : t))
    const r = parseQuote('br per unit 5500', terms)
    assert.equal(r.needsLlm, true)
    // 唔係字典命中（高信心）— 落 orphan 低信心行（LLM 第二層補）
    assert.equal(r.items.find((i) => i.termShorthand === 'br'), undefined)
    assert.ok(r.items.find((i) => i.text === 'br' && i.certainty === 'low'))
  })

  it('術語表加詞即時生效（S1 加 imlpant 錯字詞後唔使 LLM）', () => {
    const terms = [...TERMS, { shorthand: 'imlpant', nameCn: '植牙（速記變體）', nameEn: 'implant', active: true }]
    const r = parseQuote(S1, terms)
    const im = r.items.find((i) => i.text === 'imlpant')!
    assert.equal(im.certainty, 'high', '加詞後術語命中')
    assert.deepEqual(im.fdiTeeth, ['36', '37'])
  })

  it('case-insensitive：sp 4k = SP（洗牙 4000）', () => {
    const r = parseQuote('sp 4k', TERMS)
    const sp = r.items.find((i) => i.text === 'SP') // 存字典 canonical case
    assert.ok(sp)
    assert.equal(sp!.amountMin, 4000)
  })
})
