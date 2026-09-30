/**
 * ★ 2026-09-30 [cwm-resignfull]：離職結算 = 月結同一條數
 * 跑法: TZ=UTC npx tsx --test src/lib/resign-full-settlement.test.ts
 *
 * 背景（CC2，2026-09）：結算書預估應付 $15,586.68 vs 月結實發 $16,163.08 —
 *   結算卡只讀 basePay，漏咗勤工獎 $500（連帶 MPF +$25）同雜項報銷 $101.40。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calcResignPayable, pickResignChoice, toEngineBonusOverride } from './settlement-utils'
import { resolveBonusOverride, resolveStoreBonus, buildEngineOptions, parseResignSettlementRow } from './payroll-engine'
import { toMonthItems } from './resign-settlement'

const CC2 = {
  annualLeavePay: 2962.49, noticePay: 0, tbCashout: 0, excessRest: 1133.33, tbDeduction: 2301.02,
}

describe('calcResignPayable（同 engine gross/MPF/net 同一條式）', () => {
  it('CC2：當月 Gross 17,500（底薪 17,000 + 勤工獎 500）+ 雜項 101.40 → 16,163.08（= 月結實發）', () => {
    const r = calcResignPayable({ monthGross: 17500, ...CC2, mpfEmployee: 966.46, misc: 101.40 })
    assert.equal(r.relevantIncome, 19329.16)   // = 月結 Gross
    assert.equal(r.net, 16061.68)
    assert.equal(r.payable, 16163.08)
  })

  it('舊口徑（淨係 basePay、冇雜項）重現舊結算書 15,586.68 — 差額 576.40 = 500 − 25 + 101.40', () => {
    const r = calcResignPayable({ monthGross: 17000, ...CC2, mpfEmployee: 941.46, misc: 0 })
    assert.equal(r.payable, 15586.68)
    assert.equal(Math.round((16163.08 - r.payable) * 100) / 100, 576.40)
  })

  it('扣款大過應付 → 淨額 clamp 0，雜項照加（同 engine：max(0, net) + misc）', () => {
    const r = calcResignPayable({ monthGross: 1000, annualLeavePay: 0, noticePay: 0, tbCashout: 0, excessRest: 0, mpfEmployee: 0, tbDeduction: 5000, misc: 50 })
    assert.equal(r.net, 0)
    assert.equal(r.payable, 50)
  })

  it('負數折現／負數扣款當 0（唔會靜靜變加減錢）', () => {
    const r = calcResignPayable({ monthGross: 1000, annualLeavePay: 0, noticePay: 0, tbCashout: -300, excessRest: -200, mpfEmployee: 0, tbDeduction: -100, misc: 0 })
    assert.equal(r.relevantIncome, 1000)
    assert.equal(r.payable, 1000)
  })
})

describe('勤工獎／店舖獎金揀法優先次序：計糧頁 > 結算 > 舊計糧單', () => {
  const carried = { storeBonus: { e1: 300 }, splitPay: {}, bonusOverride: { e1: 'FORCE_ON' as const } }
  const rs = (attendanceBonusOverride: any, storeBonus: number | null) => ({ attendanceBonusOverride, storeBonus })

  it('pickResignChoice：null/undefined 落下一層；0 係有效值', () => {
    assert.equal(pickResignChoice(undefined, null, 5), 5)
    assert.equal(pickResignChoice(undefined, 0, 5), 0)
    assert.equal(pickResignChoice(7, 0, 5), 7)
    assert.equal(pickResignChoice(null, null, null), null)
  })

  it('toEngineBonusOverride：AUTO → null', () => {
    assert.equal(toEngineBonusOverride('AUTO'), null)
    assert.equal(toEngineBonusOverride('FORCE_OFF'), 'FORCE_OFF')
    assert.equal(toEngineBonusOverride(null), null)
  })

  it('冇結算 → 用舊計糧單 carry（行為零改動）', () => {
    assert.equal(resolveBonusOverride('e1', carried, undefined, null), 'FORCE_ON')
    assert.equal(resolveStoreBonus('e1', carried, undefined, null), 300)
  })

  it('結算揀 FORCE_OFF／店舖獎金 0 → 蓋過舊計糧單', () => {
    assert.equal(resolveBonusOverride('e1', carried, undefined, rs('FORCE_OFF', 0)), 'FORCE_OFF')
    assert.equal(resolveStoreBonus('e1', carried, undefined, rs(null, 0)), 0)
  })

  it('結算揀 AUTO → 引擎自動（蓋過舊計糧單 FORCE_ON）', () => {
    assert.equal(resolveBonusOverride('e1', carried, undefined, rs('AUTO', null)), null)
  })

  it('計糧頁今次輸入 > 結算', () => {
    const opts = { attendanceBonusOverrides: { e1: 'FORCE_ON' as const }, storeBonuses: { e1: 800 } }
    assert.equal(resolveBonusOverride('e1', carried, opts, rs('FORCE_OFF', 100)), 'FORCE_ON')
    assert.equal(resolveStoreBonus('e1', carried, opts, rs('FORCE_OFF', 100)), 800)
  })

  it('buildEngineOptions：結算店舖獎金入引擎；時薪唔入；0 唔傳', () => {
    const r = { annualLeavePay: 0, noticePay: 0, tbDeduction: null, excessRestDeduction: null, tbCashout: 0, monthWage: null, attendanceBonusOverride: 'FORCE_OFF' as const, storeBonus: 450 }
    const m = buildEngineOptions('monthly', 'e2', { storeBonus: {}, splitPay: {}, bonusOverride: {} }, undefined, r)
    assert.equal((m as any).storeBonus, 450)
    assert.equal(m.attendanceBonusOverride, 'FORCE_OFF')
    const h = buildEngineOptions('hourly', 'e2', { storeBonus: {}, splitPay: {}, bonusOverride: {} }, undefined, r)
    assert.equal((h as any).storeBonus, undefined)
    const z = buildEngineOptions('monthly', 'e2', { storeBonus: {}, splitPay: {}, bonusOverride: {} }, undefined, { ...r, storeBonus: 0 })
    assert.equal((z as any).storeBonus, undefined)
  })

  it('parseResignSettlementRow：讀返揀法；亂值 → null；舊結算（冇 key）→ null', () => {
    const row = (d: any) => ({ detailJson: JSON.stringify(d), tbDeduction: null, excessRestDeduction: null, tbMinutes: 0, tbAmount: 0 })
    const a = parseResignSettlementRow(row({ attendanceBonusOverride: 'AUTO', storeBonus: 200 }))!
    assert.equal(a.attendanceBonusOverride, 'AUTO')
    assert.equal(a.storeBonus, 200)
    const b = parseResignSettlementRow(row({ attendanceBonusOverride: 'HACK', storeBonus: -5 }))!
    assert.equal(b.attendanceBonusOverride, null)
    assert.equal(b.storeBonus, null)
    const c = parseResignSettlementRow(row({ annualLeavePay: 1 }))!
    assert.equal(c.attendanceBonusOverride, null)
    assert.equal(c.storeBonus, null)
  })
})

describe('toMonthItems（引擎結果 → 結算卡逐行）', () => {
  it('CC2 月薪：逐項 = grossPay、otherAdjust 0、雜項 parse、MPF 開', () => {
    const m = toMonthItems({
      basePay: 17000, otPay: 0, splitPay: null, attendanceBonus: 500, deduction: 0,
      detail: { grossPay: 17500, storeBonus: 0, mpfRate: 0.05, miscAmount: 101.4, miscDetailJson: JSON.stringify([{ amount: 101.4, description: '車費' }]), salary: { allowances: 0 } },
    }, false)
    assert.equal(m.grossPay, 17500)
    assert.equal(m.attendanceBonus, 500)
    assert.equal(m.otherAdjust, 0)
    assert.equal(m.miscAmount, 101.4)
    assert.deepEqual(m.miscEntries, [{ amount: 101.4, description: '車費' }])
    assert.equal(m.mpfEnabled, true)
  })

  it('引擎有新項目未同步 → otherAdjust 補差，加總唔走樣', () => {
    const m = toMonthItems({ basePay: 10000, otPay: 0, splitPay: null, attendanceBonus: 0, deduction: 0, detail: { grossPay: 10123.45, mpfRate: 0.05 } }, false)
    assert.equal(m.otherAdjust, 123.45)
  })

  it('時薪：MPF 關（同引擎時薪 MPF 0）；壞 miscDetailJson 唔 throw', () => {
    const m = toMonthItems({ basePay: 3000, otPay: 0, splitPay: null, attendanceBonus: 0, deduction: 0, detail: { grossPay: 3000, mpf: 0, miscAmount: 20, miscDetailJson: '{bad' } }, true)
    assert.equal(m.payType, 'HOURLY')
    assert.equal(m.mpfEnabled, false)
    assert.deepEqual(m.miscEntries, [])
    assert.equal(m.miscAmount, 20)
  })
})
