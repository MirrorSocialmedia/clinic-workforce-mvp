/**
 * ★ cw-pta: 員工當值列共用純邏輯測試
 * 跑法: cd apps/web && npx tsx --test src/lib/staff-by-date.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStaffByDate, shouldLoadStaffShifts } from './staff-by-date'

const T0 = new Date('2026-08-22T00:00:00+08:00') // HK 午夜
// ★ Shift.startTime/endTime 係 DateTime —— API 回 ISO string（fmtTime 食呢個，唔係裸 'HH:mm'）
const iso = (hm: string) => `2026-08-22T${hm}:00+08:00`
const shift = (over: any) => ({
  date: T0,
  startTime: iso('09:00'),
  endTime: iso('17:00'),
  ...over,
})

describe('shouldLoadStaffShifts — KIOSK 收起（spec §5.1 #2 / 驗收 #21）', () => {
  it('KIOSK（打卡機）→ false（員工姓名唔應該喺打卡機顯示）', () => {
    assert.equal(shouldLoadStaffShifts('KIOSK'), false)
  })
  it('角色未載入（""）→ false（先唔送 request）', () => {
    assert.equal(shouldLoadStaffShifts(''), false)
  })
  it('正常角色 → true', () => {
    assert.equal(shouldLoadStaffShifts('EMPLOYEE'), true)
    assert.equal(shouldLoadStaffShifts('MANAGER'), true)
    assert.equal(shouldLoadStaffShifts('OWNER'), true)
    assert.equal(shouldLoadStaffShifts('ACCOUNTANT'), true)
  })
})

describe('buildStaffByDate — /api/shifts rows → Map<date, StaffCell[]>', () => {
  it('home + 調鋪（secondary）都計入；其他店唔計', () => {
    const m = buildStaffByDate(
      [
        shift({ employeeId: 'e1', clinicId: 'c1', secondaryClinicId: null, startTime: iso('10:00'), endTime: iso('18:00'), employee: { user: { name: '阿明' } } }),
        shift({ employeeId: 'e2', clinicId: 'c2', secondaryClinicId: 'c1', employee: { user: { name: '阿玲' } } }), // 調鋪入 c1（09:00）
        shift({ employeeId: 'e3', clinicId: 'c2', secondaryClinicId: 'c3', employee: { user: { name: '阿強' } } }), // 同 c1 無關
      ],
      'c1',
    )
    const list = m.get('2026-08-22') ?? []
    assert.deepEqual(
      list.map((c: any) => c.name),
      ['阿玲', '阿明'], // 按開始時間排序（09:00 < 10:00；唔依賴 CJK 排序行為）
    )
    // e2 係調鋪 → transfer=true（UI 琥珀色 + 「·調」）
    const transfer = list.find((c: any) => c.name === '阿玲')!
    assert.equal(transfer.transfer, true)
    const home = list.find((c: any) => c.name === '阿明')!
    assert.equal(home.transfer, false)
    assert.equal(home.start, '10:00')
    assert.equal(home.end, '18:00')
  })

  it('按開始時間排序（同時間按姓名）', () => {
    const m = buildStaffByDate(
      [
        shift({ employeeId: 'e1', clinicId: 'c1', startTime: iso('13:00'), endTime: iso('21:00'), employee: { user: { name: '阿B' } } }),
        shift({ employeeId: 'e2', clinicId: 'c1', startTime: iso('09:00'), endTime: iso('17:00'), employee: { user: { name: '阿A' } } }),
      ],
      'c1',
    )
    assert.deepEqual(
      (m.get('2026-08-22') ?? []).map((c: any) => c.name),
      ['阿A', '阿B'],
    )
  })

  it('employee.user.name 缺 → 「—」佔位（唔會崩）', () => {
    const m = buildStaffByDate([shift({ employeeId: 'e1', clinicId: 'c1', employee: null })], 'c1')
    assert.equal((m.get('2026-08-22') ?? [])[0]?.name, '—')
  })

  it('selectedClinicId=null → 冇人計入（冇店可 match）', () => {
    const m = buildStaffByDate(
      [shift({ employeeId: 'e1', clinicId: 'c1', employee: { user: { name: '阿明' } } })],
      null,
    )
    assert.equal(m.size, 0)
  })

  it('空 shifts → 空 Map', () => {
    assert.equal(buildStaffByDate([], 'c1').size, 0)
  })
})
