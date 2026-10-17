/**
 * 真 Apricot call（defaultCall）：有 body 一定要 POST — fetch 預設 GET，GET + body → TypeError，
 * call 未出門已死（clinic-patients/search 同 bills/search 兩條；stub callFn 唔經 fetch，其他測試捉唔到）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toApricotInit, getPatientBillsOverview, billsForDay } from './apricot-client'

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

describe('bills overview（立即更新：一次攞晒全部日子）', () => {
  it('path + body + 經 toApricotInit 變 POST', async () => {
    const seen: { path: string; init?: { body?: string } }[] = []
    const rows = await getPatientBillsOverview(async (path, init) => {
      seen.push({ path, init })
      return [{ id: 'b1' }]
    }, 'cp-1')
    assert.deepEqual(rows, [{ id: 'b1' }])
    assert.equal(seen[0].path, '/services/aepsmsbill/api/bills/payer/cp-1/overview?page=0&size=30&sort=desc&payerType=0')
    assert.deepEqual(JSON.parse(seen[0].init!.body!), { params: [{ key: 'ovFilterType', value: 'ALL' }] })
    assert.equal(toApricotInit(seen[0].init)?.method, 'POST')
  })

  it('billsForDay：billTime（UTC）按香港日分組', () => {
    const bills = [
      { id: 'a', billTime: '2025-12-19T16:00:00Z' }, // 香港 12-20 00:00（實測樣本）
      { id: 'b', billTime: '2025-12-19T15:59:59Z' }, // 香港 12-19 23:59
      { id: 'c' }, // 冇 billTime → 唔入任何一日
    ]
    assert.deepEqual(billsForDay(bills, '2025-12-20').map((b) => b.id), ['a'])
    assert.deepEqual(billsForDay(bills, '2025-12-19').map((b) => b.id), ['b'])
  })
})
