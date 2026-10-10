// ★ cwm-kioskpayout-20261010：店舖帳號醫生月結只限自己店
//   跑法: TZ=UTC npx tsx --test src/lib/payout/kiosk-scope.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { payoutClinicLimit, payoutClinicAllowed, payoutClinicGuard, payoutClinicWhere } from './kiosk-scope'

const tmy = { role: 'KIOSK', clinics: ['tmy'] }
const bare = { role: 'KIOSK', clinics: [] }
const owner = { role: 'OWNER', clinics: [] }
const manager = { role: 'MANAGER', clinics: ['tmy'] }

test('KIOSK：只准自己店；冇 clinicId / 別店 = 唔准', () => {
  assert.equal(payoutClinicAllowed(tmy, 'tmy'), true)
  assert.equal(payoutClinicAllowed(tmy, 'yl'), false)
  assert.equal(payoutClinicAllowed(tmy, null), false)
  assert.equal(payoutClinicAllowed(tmy, undefined), false)
})

test('KIOSK 冇綁店 = fail-closed（乜都唔准）', () => {
  assert.deepEqual(payoutClinicLimit(bare), [])
  assert.equal(payoutClinicAllowed(bare, 'tmy'), false)
  assert.deepEqual(payoutClinicWhere(bare), { clinicId: { in: [] } })
})

test('其他角色唔收窄（照 route 原有權限）', () => {
  assert.equal(payoutClinicLimit(owner), null)
  assert.equal(payoutClinicLimit(manager), null)
  assert.equal(payoutClinicAllowed(owner, 'yl'), true)
  assert.equal(payoutClinicAllowed(manager, 'yl'), true)
  assert.deepEqual(payoutClinicWhere(owner), {})
  assert.equal(payoutClinicGuard(owner, null), null)
})

test('guard：唔准 → 403；where 可以換欄名', async () => {
  const r = payoutClinicGuard(tmy, 'yl')
  assert.ok(r)
  assert.equal(r!.status, 403)
  assert.match((await r!.json()).error, /自己間店/)
  assert.equal(payoutClinicGuard(tmy, 'tmy'), null)
  assert.deepEqual(payoutClinicWhere(tmy, 'fromClinicId'), { fromClinicId: { in: ['tmy'] } })
})
