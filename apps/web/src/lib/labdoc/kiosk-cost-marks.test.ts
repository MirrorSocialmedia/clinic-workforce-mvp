/**
 * 2026-10-11：KIOSK 上傳／範圍（kiosk-scope.ts）＋成本錄入按 lab 月結標示（cost-statement-marks.ts）
 */
import assert from 'node:assert'
import { test } from 'node:test'
import { kioskClinics, kioskUploadClinic, kioskSectionAllowed, kioskDocWhere, kioskSettingsDenied } from './kiosk-scope'
import { costStatementMarks } from './cost-statement-marks'

const TKW = 'k'.repeat(25)
const MK = 'm'.repeat(25)
const kiosk = (clinics: string[]) => ({ role: 'KIOSK', userId: 'u', clinics })
const owner = { role: 'OWNER', userId: 'o', clinics: [] }

test('kiosk-scope：只有 KIOSK 收窄', () => {
  assert.equal(kioskClinics(owner), null)
  assert.deepEqual(kioskClinics(kiosk([TKW])), [TKW])
  assert.equal(kioskDocWhere({ role: 'MANAGER', userId: 'x', clinics: [TKW] }), null)
  assert.ok(kioskDocWhere(kiosk([TKW])))
})

test('kiosk-scope：上傳店 — 一間自動、幾間要揀、冇店擋、其他帳號唔理', () => {
  assert.deepEqual(kioskUploadClinic(owner, TKW), { clinicId: null })
  assert.deepEqual(kioskUploadClinic(kiosk([TKW]), null), { clinicId: TKW })
  assert.deepEqual(kioskUploadClinic(kiosk([TKW]), MK), { clinicId: TKW }, '一間店就唔理表單')
  assert.ok('error' in kioskUploadClinic(kiosk([TKW, MK]), null))
  assert.ok('error' in kioskUploadClinic(kiosk([TKW, MK]), 'z'.repeat(25)))
  assert.deepEqual(kioskUploadClinic(kiosk([TKW, MK]), MK), { clinicId: MK })
  assert.ok('error' in kioskUploadClinic(kiosk([]), null))
})

test('kiosk-scope：分段 — 自己店／未揀診所先得；設定唔准改', () => {
  assert.equal(kioskSectionAllowed(kiosk([TKW]), TKW), true)
  assert.equal(kioskSectionAllowed(kiosk([TKW]), null), true)
  assert.equal(kioskSectionAllowed(kiosk([TKW]), MK), false)
  assert.equal(kioskSectionAllowed(owner, MK), true)
  assert.equal(kioskSettingsDenied(owner), null)
  assert.equal(kioskSettingsDenied(kiosk([TKW]))?.status, 403)
})

// ───────── cost-statement-marks ─────────
const LAB = 'l'.repeat(25)
const P1 = 'p'.repeat(25)
const P2 = 'q'.repeat(25)
function fake(sections: any[], costs: Array<{ clinicId: string; providerId: string; sum: number }>) {
  return {
    labStatementSection: { findMany: async () => sections },
    costCase: { groupBy: async () => costs.map((c) => ({ labId: LAB, clinicId: c.clinicId, providerId: c.providerId, _sum: { finalCost: c.sum } })) },
  }
}
const sec = (providerId: string, over: any = {}) => ({
  status: 'CONFIRMED', clinicId: TKW, providerId, note: null,
  resultJson: { costTotal: 5670, diff: 0 }, document: { id: 'd'.repeat(25), labId: LAB }, ...over,
})
const run = (client: any) => costStatementMarks(client, { month: '2026-09', labIds: [LAB], clinicIds: [TKW], providerId: null })

test('marks：全部確認、一致 → OK', async () => {
  const m = await run(fake([sec(P1)], [{ clinicId: TKW, providerId: P1, sum: 5670 }]))
  assert.equal(m[LAB].status, 'OK')
})

test('marks：確認時有差額＋原因 → OK_DIFF', async () => {
  const m = await run(fake([sec(P1, { note: 'Lab 下月補單', resultJson: { costTotal: 2700, diff: 30 } })], [{ clinicId: TKW, providerId: P1, sum: 2700 }]))
  assert.equal(m[LAB].status, 'OK_DIFF')
  assert.equal(m[LAB].diff, 30)
  assert.deepEqual(m[LAB].reasons, ['Lab 下月補單'])
})

test('marks：確認後成本改咗 → CHANGED', async () => {
  const m = await run(fake([sec(P1)], [{ clinicId: TKW, providerId: P1, sum: 5770 }]))
  assert.equal(m[LAB].status, 'CHANGED')
  assert.equal(m[LAB].changedBy, 100)
})

test('marks：有醫生嘅成本月結單冇 → PARTIAL', async () => {
  const m = await run(fake([sec(P1)], [{ clinicId: TKW, providerId: P1, sum: 5670 }, { clinicId: TKW, providerId: P2, sum: 560 }]))
  assert.equal(m[LAB].status, 'PARTIAL')
  assert.equal(m[LAB].uncoveredTotal, 560)
})

test('marks：有分段未確認 → IN_PROGRESS；冇月結單 → 唔出', async () => {
  let m = await run(fake([sec(P1), sec(P2, { status: 'DIFF' })], []))
  assert.equal(m[LAB].status, 'IN_PROGRESS')
  m = await run(fake([], [{ clinicId: TKW, providerId: P1, sum: 1 }]))
  assert.equal(m[LAB], undefined)
})
