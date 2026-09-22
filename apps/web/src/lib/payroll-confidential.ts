// ★ cwm-payrollsheet-20260921 S4：保密員工過濾共用 helper。
//   源出 export/route.ts:82-87（2026-08-03 口徑）—— cheque-sheet 匯出同單張匯出要同一把尺，
//   禁止各 route 另寫一套（規則飄移 = 保密員工漏出）。
//
//   口徑：confScope === null → 全權限（OWNER 或全公司負責人）→ 不過滤；
//   否則：保密員工只可喺自己 range 內嘅店（homeClinicId 喺 confScope 先見）。
export function filterConfidentialItems<T extends {
  employee?: { payConfidential?: boolean; homeClinicId?: string | null } | null
}>(items: T[], confScope: string[] | null): T[] {
  if (confScope === null) return items
  return items.filter(
    (item) =>
      !item.employee?.payConfidential ||
      (!!item.employee?.homeClinicId && confScope.includes(item.employee.homeClinicId)),
  )
}
