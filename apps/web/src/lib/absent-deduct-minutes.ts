/**
 * 計算缺勤扣 OT 鐘分鐘數。
 * 規則：當日全部更次加總 → 按 deductLunch gate 扣一次午飯
 * 語義同 payroll-engine.ts:1597 一致（some：有任何一要扣就扣）
 */
export function computeAbsentDeductMinutes(
  sameDayShifts: Array<{
    startTime: Date | string;
    endTime: Date | string;
    template?: { deductLunch?: boolean | null } | null;
  }>,
  lunchMinutes: number,
): number {
  const rawMinutes = sameDayShifts.reduce((sum, s) => {
    const start = typeof s.startTime === 'string' ? new Date(s.startTime) : s.startTime
    const end = typeof s.endTime === 'string' ? new Date(s.endTime) : s.endTime
    return sum + Math.round((end.getTime() - start.getTime()) / 60000)
  }, 0)
  const dayDeducts = sameDayShifts.some(s => s.template?.deductLunch !== false)
  return Math.max(0, rawMinutes - (dayDeducts ? lunchMinutes : 0))
}
