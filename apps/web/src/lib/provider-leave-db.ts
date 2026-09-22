/**
 * ★ cwm-provroster S1-3：醫生休假重疊檢查（POST／PATCH 共用 —— 唔好兩個 route 各寫一份）
 * provider-leave.ts 係純函數檔（node:test 直接斷言），所以 DB 查詢另開呢個檔。
 */
import { prisma } from './prisma'
import { toHKDateStr } from './hk-date'

/** 有重疊 → 回人讀錯誤句子；冇 → null。excludeId = PATCH 時排除自己。
 *  db 參（預設 prisma）= B3/CHECK P-3：POST/PATCH 喺 $transaction 入面傳 tx 做 atomic 重疊檢查
 *  （同 checkShiftLeaveConflict 慣例）。 */
export async function findOverlappingLeave(
  providerId: string,
  start: Date,
  end: Date,
  excludeId: string | null,
  db: Pick<typeof prisma, 'providerLeave'> = prisma,
): Promise<string | null> {
  const hit = await db.providerLeave.findFirst({
    where: {
      providerId,
      startDate: { lte: end },
      endDate: { gte: start },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { startDate: true, endDate: true, note: true, provider: { select: { name: true } } },
  })
  if (!hit) return null
  const range = `${toHKDateStr(hit.startDate)} ~ ${toHKDateStr(hit.endDate)}`
  return `${hit.provider.name} 喺 ${range} 已經有休假${hit.note ? `（${hit.note}）` : ''}，唔好重覆加；要改請喺「現有休假」清單撳「修改」`
}
