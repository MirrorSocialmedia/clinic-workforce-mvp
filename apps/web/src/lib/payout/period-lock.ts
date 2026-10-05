// ============================================================
// ★ cwm-payaudit-20261006：醫生 × 診所 × 月份 嘅「期間鎖」
//   鎖月結（lockPayoutRun）同所有會影響嗰期錢嘅寫入（成本、2人SP 確認、轉介、調整）
//   喺各自 transaction 開頭攞同一把 Postgres advisory lock（transaction 完自動放）→ 一定一前一後：
//   - 寫入先：鎖月結要等寫入 commit，之後鎖完對數（CostChangedDuringLockError）會發現 → 回滾重來
//   - 鎖月結先：寫入要等鎖月結 commit，之後 lockedRunFor 見到 LOCKED → 擋
//   冇呢把鎖：寫入「檢查未鎖 → 寫」之間月結啱啱 commit，嗰筆就會鎖唔入又冇計錢。
// ============================================================

export function periodKey(providerId: string, clinicId: string, periodMonth: string) {
  return `payout-period:${providerId}:${clinicId}:${periodMonth}`
}

/** 喺 transaction 入面攞期間鎖（tx = Prisma interactive transaction client） */
export async function lockPeriod(tx: any, providerId: string, clinicId: string, periodMonth: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${periodKey(providerId, clinicId, periodMonth)}))`
}

/**
 * 喺期間鎖入面寫：攞鎖 → 再查一次個月有冇鎖定（有就 throw，由 caller 轉 409）→ 寫。
 * periodMonth = null（例如成本未到貨）唔屬任何期間，唔使鎖。
 */
export class PeriodLockedError extends Error {
  constructor(public periodMonth: string) { super(`PERIOD_LOCKED:${periodMonth}`) }
}

export async function writeInPeriod<T>(
  db: any,
  key: { providerId: string; clinicId: string | null; periodMonth: string | null },
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx: any) => {
    if (key.clinicId && key.periodMonth) {
      await lockPeriod(tx, key.providerId, key.clinicId, key.periodMonth)
      const run = await tx.payoutRun.findFirst({
        where: { providerId: key.providerId, clinicId: key.clinicId, periodMonth: key.periodMonth, status: 'LOCKED' },
        select: { id: true },
      })
      if (run) throw new PeriodLockedError(key.periodMonth)
    }
    return fn(tx)
  })
}
