/**
 * 真 Apricot call（defaultCall）：有 body 一定要 POST — fetch 預設 GET，GET + body → TypeError，
 * call 未出門已死（clinic-patients/search 同 bills/search 兩條；stub callFn 唔經 fetch，其他測試捉唔到）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toApricotInit } from './apricot-client'

describe('clinical-index toApricotInit', () => {
  it('有 body → method POST，body 原封不動', () => {
    const init = toApricotInit({ body: '{"params":[]}' })
    assert.equal(init?.method, 'POST')
    assert.equal(init?.body, '{"params":[]}')
  })

  it('冇 body → 唔加 method（GET）', () => {
    assert.equal(toApricotInit(undefined), undefined)
    assert.equal(toApricotInit({})?.method, undefined)
  })

  it('真 fetch：GET + body 會 throw（證明漏 method 係致命）', async () => {
    await assert.rejects(() => fetch('http://127.0.0.1:9/x', { body: '{}' }), /GET\/HEAD method cannot have body/)
  })
})
