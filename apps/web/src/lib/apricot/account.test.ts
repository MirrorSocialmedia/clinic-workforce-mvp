/**
 * ★ cwm-apricotty-20261001：Apricot 多帳號（青衣 = TY）
 * 跑法: TZ=UTC npx tsx --test src/lib/apricot/account.test.ts
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../prisma'
import {
  APRICOT_MAIN, normalizeApricotAccount, credentialProviderKey, currentApricotAccount,
  withApricotAccount, isAccountDeadError, accountForPatient,
} from './account'
import { loadCreds } from './token'
import { isBeforePayoutStart } from '../payout/engine'

type Any = any

describe('帳號名 / credential key', () => {
  it('normalize：空／亂值 → MAIN；細楷 → 大楷', () => {
    assert.equal(normalizeApricotAccount(null), APRICOT_MAIN)
    assert.equal(normalizeApricotAccount(''), APRICOT_MAIN)
    assert.equal(normalizeApricotAccount('ty'), 'TY')
    assert.equal(normalizeApricotAccount('T Y'), APRICOT_MAIN)
    assert.equal(normalizeApricotAccount("TY'; drop"), APRICOT_MAIN)
  })

  it('MAIN 沿用舊 provider（現有 token 行唔使 migrate）；其他帳號加後綴', () => {
    assert.equal(credentialProviderKey('MAIN'), 'APRICOT')
    assert.equal(credentialProviderKey('TY'), 'APRICOT:TY')
  })

  it('isAccountDeadError：只認 token 失效／未設定', () => {
    assert.equal(isAccountDeadError('APRICOT_AUTH_EXPIRED'), true)
    assert.equal(isAccountDeadError('APRICOT_NOT_CONFIGURED'), true)
    assert.equal(isAccountDeadError('APRICOT_HTTP_500: boom'), false)
    assert.equal(isAccountDeadError('APRICOT_RATE_LIMITED'), false)
  })
})

describe('帳號 context（AsyncLocalStorage）', () => {
  it('冇設 = MAIN；withApricotAccount 入面 = 指定帳號，跨 await 都保持；出返嚟還原', async () => {
    assert.equal(currentApricotAccount(), APRICOT_MAIN)
    await withApricotAccount('TY', async () => {
      assert.equal(currentApricotAccount(), 'TY')
      await new Promise((r) => setTimeout(r, 5))
      assert.equal(currentApricotAccount(), 'TY')
      await withApricotAccount('MAIN', async () => assert.equal(currentApricotAccount(), 'MAIN'))
      assert.equal(currentApricotAccount(), 'TY')
    })
    assert.equal(currentApricotAccount(), APRICOT_MAIN)
  })

  it('並發兩個帳號唔會互相污染', async () => {
    const seen: string[] = []
    await Promise.all([
      withApricotAccount('TY', async () => { await new Promise((r) => setTimeout(r, 10)); seen.push(`a:${currentApricotAccount()}`) }),
      withApricotAccount('MAIN', async () => { await new Promise((r) => setTimeout(r, 1)); seen.push(`b:${currentApricotAccount()}`) }),
    ])
    assert.deepEqual(seen.sort(), ['a:TY', 'b:MAIN'])
  })
})

describe('loadCreds 按帳號揀 token 行 + accountForPatient', () => {
  const saved: [string, Any][] = []
  const providers: string[] = []
  let patientRow: Any = null
  let apptRow: Any = null
  let clinicRow: Any = null
  before(() => {
    const fakes: Record<string, Any> = {
      externalCredential: { findUnique: async ({ where }: Any) => { providers.push(where.provider); return null } },
      patientIndex: { findUnique: async () => patientRow },
      appointmentIndex: { findFirst: async () => apptRow },
      clinicalRecordIndex: { findFirst: async () => null },
      clinic: { findUnique: async () => clinicRow },
    }
    for (const k of Object.keys(fakes)) {
      saved.push([k, (prisma as Any)[k]])
      Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
    }
  })
  after(() => {
    for (const [k, orig] of saved) Object.defineProperty(prisma, k, { value: orig, configurable: true, writable: true })
  })

  it('MAIN → provider APRICOT；TY context → APRICOT:TY', async () => {
    providers.length = 0
    assert.equal(await loadCreds(), null)
    await withApricotAccount('TY', () => loadCreds())
    assert.deepEqual(providers, ['APRICOT', 'APRICOT:TY'])
  })

  it('病人：PatientIndex 有記錄 → 用佢；冇 → 用預約索引嘅店帳號；都冇 → MAIN', async () => {
    patientRow = { apricotAccount: 'TY' }
    assert.equal(await accountForPatient('p1'), 'TY')
    patientRow = null; apptRow = { clinicId: 'cl-ty' }; clinicRow = { apricotAccount: 'TY' }
    assert.equal(await accountForPatient('p2'), 'TY')
    apptRow = null; clinicRow = null
    assert.equal(await accountForPatient('p3'), APRICOT_MAIN)
  })
})

describe('isBeforePayoutStart（青衣月結起計月份）', () => {
  it('早過起計月份 → true；同月／之後 → false；冇設 → false', () => {
    assert.equal(isBeforePayoutStart('2026-10', '2026-11'), true)
    assert.equal(isBeforePayoutStart('2026-11', '2026-11'), false)
    assert.equal(isBeforePayoutStart('2027-01', '2026-11'), false)
    assert.equal(isBeforePayoutStart('2026-10', null), false)
    assert.equal(isBeforePayoutStart('2026-10', 'bad'), false)
  })
})

describe('assertSameApricotAccount（落單跨帳號防呆）', () => {
  // dynamic import：guards 帶 next/server，放喺呢度先載
  const saved: [string, Any][] = []
  let patientRow: Any = null
  let dictRow: Any = null
  let throwLookup = false
  before(async () => {
    const { basePrisma } = await import('../prisma')
    const fakes: Record<string, Any> = {
      patientIndex: { findUnique: async () => { if (throwLookup) throw new Error('db down'); return patientRow } },
      apricotDictionary: { findUnique: async () => dictRow },
    }
    for (const k of Object.keys(fakes)) {
      saved.push([k, (basePrisma as Any)[k]])
      Object.defineProperty(basePrisma, k, { value: fakes[k], configurable: true, writable: true })
    }
  })
  after(async () => {
    const { basePrisma } = await import('../prisma')
    for (const [k, orig] of saved) Object.defineProperty(basePrisma, k, { value: orig, configurable: true, writable: true })
  })
  const TY = { id: 'cl-ty', shortName: 'TY', apricotClinicId: 'a'.repeat(24), apricotAccount: 'TY' }
  const MF = { id: 'cl-mf', shortName: 'MF', apricotClinicId: 'b'.repeat(24), apricotAccount: 'MAIN' }

  it('青衣店 + 原帳號病人 → 409 PATIENT_ACCOUNT_MISMATCH', async () => {
    const { assertSameApricotAccount } = await import('../../app/api/external/v1/bookings/guards')
    patientRow = { apricotAccount: 'MAIN' }; dictRow = null; throwLookup = false
    await assert.rejects(assertSameApricotAccount(TY, { apricotId: 'p-main' }, 'vr'), (e: Any) => e.status === 409 && e.code === 'PATIENT_ACCOUNT_MISMATCH')
  })

  it('原帳號店 + 青衣就診原因 → 409 VISIT_REASON_ACCOUNT_MISMATCH', async () => {
    const { assertSameApricotAccount } = await import('../../app/api/external/v1/bookings/guards')
    patientRow = { apricotAccount: 'MAIN' }; dictRow = { apricotAccount: 'TY' }; throwLookup = false
    await assert.rejects(assertSameApricotAccount(MF, { apricotId: 'p-main' }, 'vr-ty'), (e: Any) => e.status === 409 && e.code === 'VISIT_REASON_ACCOUNT_MISMATCH')
  })

  it('同帳號／未入索引嘅病人（新客）／新客 name+phone／lookup 出錯 → 放行', async () => {
    const { assertSameApricotAccount } = await import('../../app/api/external/v1/bookings/guards')
    patientRow = { apricotAccount: 'TY' }; dictRow = { apricotAccount: 'TY' }; throwLookup = false
    await assertSameApricotAccount(TY, { apricotId: 'p-ty' }, 'vr-ty')
    patientRow = null; dictRow = null
    await assertSameApricotAccount(TY, { apricotId: 'p-new' }, 'vr-unknown')
    await assertSameApricotAccount(TY, { name: 'x', phone: '12345678' } as Any, undefined)
    throwLookup = true
    await assertSameApricotAccount(TY, { apricotId: 'p-any' }, undefined)
  })
})
