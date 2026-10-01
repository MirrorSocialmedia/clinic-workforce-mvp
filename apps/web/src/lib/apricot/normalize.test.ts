/**
 * ★ cwm-apricotty-20261001：付款方式對照（青衣 TY 帳號用數字 code + 中文名）
 * 跑法: TZ=UTC npx tsx --test src/lib/apricot/normalize.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMethod, apricotMethod } from './normalize'

describe('normalizeMethod', () => {
  it('原有英文名照舊', () => {
    assert.equal(normalizeMethod('Cash'), 'CASH')
    assert.equal(normalizeMethod('ALIPAY HK'), 'ALIPAY')
    assert.equal(normalizeMethod(' master '), 'MASTERCARD')
    assert.equal(normalizeMethod('FREE SP'), 'FREE_SP')
  })
  it('中文名（繁／簡）', () => {
    assert.equal(normalizeMethod('支付寶'), 'ALIPAY')
    assert.equal(normalizeMethod('支付宝'), 'ALIPAY')
    assert.equal(normalizeMethod('現金'), 'CASH')
    assert.equal(normalizeMethod('八達通'), 'OCTOPUS')
    assert.equal(normalizeMethod('微信支付'), 'WECHAT')
    assert.equal(normalizeMethod('轉數快'), 'FPS')
    assert.equal(normalizeMethod('銀聯'), 'UNIONPAY')
    assert.equal(normalizeMethod('長者醫療券'), 'HCV')
    assert.equal(normalizeMethod('支付寶 HK'), 'ALIPAY') // 中間空白
  })
  it('語義唔肯定／數字 code → UNKNOWN（唔好估）', () => {
    assert.equal(normalizeMethod('信用卡'), 'UNKNOWN')
    assert.equal(normalizeMethod('001'), 'UNKNOWN')
    assert.equal(normalizeMethod(''), 'UNKNOWN')
  })
})

describe('apricotMethod（code → des fallback）', () => {
  it('青衣：數字 code + 中文 des → 用 des', () => {
    assert.deepEqual(apricotMethod({ code: '010', des: '支付寶' }), { methodRaw: '支付寶', methodNorm: 'ALIPAY' })
    assert.deepEqual(apricotMethod({ code: '001', des: '現金' }, 'des'), { methodRaw: '現金', methodNorm: 'CASH' })
  })
  it('原帳號：code 認到 → 照舊用 code（零改變）', () => {
    assert.deepEqual(apricotMethod({ code: 'CASH', des: 'Cash' }), { methodRaw: 'CASH', methodNorm: 'CASH' })
  })
  it('prefer des：des 認到就用 des（分配路徑舊次序）', () => {
    assert.equal(apricotMethod({ code: 'XX', des: 'Visa' }, 'des').methodNorm, 'VISA')
  })
  it('兩樣都認唔到 → UNKNOWN，methodRaw 用 des 方便人睇', () => {
    assert.deepEqual(apricotMethod({ code: '002', des: '信用卡' }), { methodRaw: '信用卡', methodNorm: 'UNKNOWN' })
    assert.deepEqual(apricotMethod({ code: '002', des: '' }), { methodRaw: '002', methodNorm: 'UNKNOWN' })
  })
})
