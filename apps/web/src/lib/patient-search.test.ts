/**
 * ★ cwm-patientsearch-20261003：統一病人搜尋 —— 排序／合併／顯示名
 * 跑法: TZ=UTC npx tsx --test src/lib/patient-search.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchScore, mergeHits, sourceLabel, sourceErrorText, type PatientHit } from './patient-search'

const h = (account: string, code: string, extId = code, fullName = 'X'): PatientHit =>
  ({ extId, code, fullName, account, clinicId: null, clinicLabel: account })

describe('matchScore', () => {
  it('完全吻合 0 > 頭尾 1 > 包含 2 > 姓名 3 > 其他 4', () => {
    assert.equal(matchScore('003213', '003213', ''), 0)
    assert.equal(matchScore('003213', 'YMT003213', ''), 1)
    assert.equal(matchScore('0032', 'TW100321', ''), 2)
    assert.equal(matchScore('wong', 'TW1', 'WONGPUIKWAN'), 3)
    assert.equal(matchScore('abc', 'TW1', 'X'), 4)
  })
})

describe('mergeHits', () => {
  it('青衣純數字完全吻合排第一（就算主帳號先回、仲多過 20 筆）', () => {
    const main = Array.from({ length: 25 }, (_, i) => h('MAIN', `TW${String(3213 + i).padStart(6, '0')}`))
    main.unshift(h('MAIN', 'YMT003213'), h('MAIN', 'MF003213'))
    const ty = [h('TY', '003213')]
    const r = mergeHits('003213', [main, ty])
    assert.equal(r[0].account, 'TY')
    assert.equal(r[0].code, '003213')
    assert.ok(r.length <= 30)
  })
  it('同分按來源輪流；同一病人（本地索引＋Apricot）去重', () => {
    const local = [h('TY', '123456', 'p1')]
    const main = [h('MAIN', 'TW123456', 'm1'), h('MAIN', 'MF123456', 'm2')]
    const ty = [h('TY', '123456', 'p1'), h('TY', '1234567', 'p2')]
    const r = mergeHits('123456', [local, main, ty])
    // p1 完全吻合排頭；其餘同分（頭尾吻合）按各來源第 N 筆輪流：m1（主第 1）→ m2（主第 2）／p2（青衣第 2）
    assert.deepEqual(r.map(x => x.extId), ['p1', 'm1', 'm2', 'p2'])
  })
  it('第二期：來源編號格式同字眼吻合 → 同分排前（唔吻合都照出，唔會被跳過）', () => {
    const main = [h('MAIN', 'TW003213', 'm1')]
    const ty = [h('TY', '0032130', 'p1')]
    const r = mergeHits('003213', [main, ty], 30, x => x.account === 'TY')
    assert.deepEqual(r.map(x => x.extId), ['p1', 'm1'])
  })
})

describe('sourceLabel / sourceErrorText', () => {
  it('用診所名，唔出現帳號代號', () => {
    assert.equal(sourceLabel([{ name: '青衣' }]), '青衣')
    assert.equal(sourceLabel([{ name: '旺角' }, { name: '大圍' }]), '旺角、大圍')
    assert.equal(sourceLabel([{ name: '元朗' }, { name: '大圍' }, { name: '美孚' }]), '元朗等 3 間')
  })
  it('設定咗顯示名就用顯示名', () => {
    assert.equal(sourceLabel([{ name: '青衣' }], '菁薈（青衣）'), '菁薈（青衣）')
    assert.equal(sourceLabel([{ name: '青衣' }], '  '), '青衣')
  })
  it('錯誤轉人話', () => {
    assert.equal(sourceErrorText(new Error('APRICOT_AUTH_EXPIRED')), '憑證失效，需要重新授權')
    assert.equal(sourceErrorText(new Error('APRICOT_HTTP_500')), '連線失敗（HTTP 500）')
    assert.equal(sourceErrorText(new Error('boom')), '連線失敗')
  })
})
