import type { Prisma } from '@prisma/client'

/**
 * ★ cwm-tbfix-20260910 P1-2（P0-2 / 坑②）：「最新生效 pay rule」統一口徑。
 *
 * PayRule 有歷史（isActive / effectiveFrom / effectiveTo）。唔加 `orderBy` 時
 * Prisma 次序唔保證，`payRules[0]` 可能係一條**已停用嘅舊規則** → 同一個數兩個答案：
 *   · `base_type === 'hourly'` 判錯 → 時薪員工出帳本 / 月薪員工被標「不設時間帳戶」
 *   · `buildTimeBankLedger` 用錯 OT config → 帳本數字同凍結 snapshot 唔同
 *   · `getTimeAccountSummary` 用錯 cfg → currentBalance 同總覽頂部餘額唔同
 *
 * 所有讀「當前 pay rule」嘅位（5 處）一律 import 呢度，禁再 inline 自己寫口徑：
 *   · api/employees/[id]/overview/route.ts（include，全欄）
 *   · api/payroll-runs/[id]/employee/[empId]/route.ts（detail select 全欄 + findMany）
 *   · api/payroll-runs/[id]/route.ts（list include + finalize items）
 *   · api/employees/[id]/timebank-ledger/route.ts（帳本 cfg）
 */

type PayRuleLatestArgs = Pick<Prisma.PayRuleFindManyArgs, 'where' | 'orderBy' | 'take'>

/** where + orderBy + take 1 — relation include/select 同 findMany 都可用（findMany 可再擴 where）。 */
export const PAY_RULE_LATEST: PayRuleLatestArgs = {
  where: { isActive: true },
  orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  take: 1,
}

/** relation select 用：最低共用欄（payType + configJson — 糧單列表／詳情／finalize／帳本）。 */
export const PAY_RULE_SELECT = {
  ...PAY_RULE_LATEST,
  select: { payType: true, configJson: true },
}
