// ★ cwm-dailycheck-20261006：每日大數護士核對（純函數）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkStatus, kioskClinicAllowed, kioskDailyScope } from './daily-check'

test('checkStatus：冇核對 = 未核對；金額一樣 = 已核對；唔同 = 有變', () => {
  assert.equal(checkStatus(12340, null), 'UNCHECKED')
  assert.equal(checkStatus(12340, 12340), 'CHECKED')
  assert.equal(checkStatus(12340.004, 12340), 'CHECKED') // 浮點誤差
  assert.equal(checkStatus(12840, 12340), 'CHANGED')
  assert.equal(checkStatus(12339.99, 12340), 'CHANGED') // 差一仙都要重新核對
  assert.equal(checkStatus(0, 500), 'CHANGED') // 全日退晒
})

test('kioskClinicAllowed：店舖帳號只可以核對綁定嘅店；其他角色由 route 權限控制', () => {
  assert.equal(kioskClinicAllowed({ role: 'KIOSK', clinics: ['ty'] }, 'ty'), true)
  assert.equal(kioskClinicAllowed({ role: 'KIOSK', clinics: ['ty'] }, 'mk'), false)
  assert.equal(kioskClinicAllowed({ role: 'KIOSK', clinics: [] }, 'mk'), true)
  assert.equal(kioskClinicAllowed({ role: 'OWNER', clinics: [] }, 'mk'), true)
})

test('kioskDailyScope：KIOSK 鎖自己店、可以揀醫生（cwm-kioskdoc-20261010）；Excel／別店 403；其他角色原樣', () => {
  const kiosk = { role: 'KIOSK', clinics: ['ty'] }
  assert.deepEqual(kioskDailyScope(kiosk, { clinicId: 'ty', providerId: 'dr1' }),
    { ok: true, kiosk: true, clinicId: 'ty', providerId: 'dr1', scopeClinics: ['ty'] })
  assert.deepEqual(kioskDailyScope(kiosk, { clinicId: 'ty', providerId: null }),
    { ok: true, kiosk: true, clinicId: 'ty', providerId: null, scopeClinics: ['ty'] })
  assert.equal(kioskDailyScope(kiosk, { clinicId: 'mk', providerId: 'dr1' }).ok, false)
  assert.equal(kioskDailyScope(kiosk, { clinicId: null, providerId: 'dr1' }).ok, false) // 唔揀店淨揀醫生 = 會睇晒全部店 → 403
  assert.equal(kioskDailyScope(kiosk, { clinicId: 'ty', providerId: null, format: 'xlsx' }).ok, false)
  assert.deepEqual(kioskDailyScope({ role: 'OWNER', clinics: [] }, { clinicId: null, providerId: 'dr1' }),
    { ok: true, kiosk: false, clinicId: null, providerId: 'dr1', scopeClinics: null })
})
