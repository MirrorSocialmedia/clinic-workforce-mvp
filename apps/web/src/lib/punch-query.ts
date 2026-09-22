import { prisma } from '@/lib/prisma'
import { toHKDateStr, getMonthRange } from './hk-date'

// ★ cwm-consistency Stage 2.4：「prisma client 或 interactive tx client」共用型別
export type PrismaDb =
  (typeof prisma)
  | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>

// ------------------------------------------------------------------
// Void filter helpers
// ------------------------------------------------------------------

export function activeOnly() {
  return { void: { is: null as any } } as const
}

export function allWithVoid() {
  return {} as const
}

// ------------------------------------------------------------------
// getEffectivePunches — single source of truth for effective times
// ------------------------------------------------------------------

/**
 * Return each punch's "effective time" — applies corrections
 * (PunchCorrection) and excludes voided punches.
 * employeeId is optional — omit to query across all employees.
 * This is the single entry point for all time-based calculations.
 */
export async function getEffectivePunches(
  start: Date,
  end: Date,
  opts?: {
    employeeId?: string
    employeeIds?: string[]  // ★ 多員工批量查詢（exceptions route）
    clinicId?: string
    clinicIds?: string[]    // ★ MANAGER 多店 scope
    db?: PrismaDb
  },
): Promise<Array<{ punchType: string; clinicId: string; effectiveTime: Date; raw: any }>> {
  const db = opts?.db ?? prisma

  const punchWhere: any = {
    punchTime: { gte: start, lte: end },
    void: { is: null },
  }
  if (opts?.employeeId) punchWhere.employeeId = opts.employeeId
  else if (opts?.employeeIds) punchWhere.employeeId = { in: opts.employeeIds }
  if (opts?.clinicId) punchWhere.clinicId = opts.clinicId
  // ★ 空陣列代表「一間店都冇權限」，要配對零筆；用 .length 會變成完全唔 filter（fail-open）
  else if (opts?.clinicIds !== undefined) punchWhere.clinicId = { in: opts.clinicIds }

  const correctionWhere: any = {
    correctedTime: { gte: start, lte: end },
    status: 'APPROVED',
  }
  if (opts?.employeeId) correctionWhere.employeeId = opts.employeeId
  else if (opts?.employeeIds) correctionWhere.employeeId = { in: opts.employeeIds }
  if (opts?.clinicId) correctionWhere.clinicId = opts.clinicId
  else if (opts?.clinicIds !== undefined) correctionWhere.clinicId = { in: opts.clinicIds }

  const [punches, corrections] = await Promise.all([
    db.punchRecord.findMany({
      where: punchWhere,
      orderBy: { punchTime: 'asc' },
    }),
    db.punchCorrection.findMany({
      where: correctionWhere,
      orderBy: [{ createdAt: 'asc' }],
    }),
  ])

  // Match corrections by punchRecordId (field already exists in schema)
  const correctionByRecordId = new Map<string, Date>()
  const orphanCorrections: any[] = []
  for (const c of corrections) {
    if (c.punchRecordId) correctionByRecordId.set(c.punchRecordId, new Date(c.correctedTime))
    else orphanCorrections.push(c)
  }

  const mapped = punches.map((p: any) => ({
    punchType: p.punchType,
    clinicId: p.clinicId,
    effectiveTime: correctionByRecordId.get(p.id) ?? new Date(p.punchTime),
    raw: p,
  }))

  // Pure corrections (no original punch record) must also appear,
  // otherwise calculateTimeBank won't see them → inconsistency
  for (const c of orphanCorrections) {
    mapped.push({
      punchType: c.punchType,
      clinicId: c.clinicId,
      effectiveTime: new Date(c.correctedTime),
      raw: { ...c, __synthetic: true },
    })
  }

  return mapped.sort((a, b) => a.effectiveTime.getTime() - b.effectiveTime.getTime())
}

// ------------------------------------------------------------------
// invalidateTimeBankFrom — clear cached TimeBank after retro change
// ------------------------------------------------------------------

/**
 * After a retro change (correction/void/makeup), delete all TimeBank
 * records from the change month onward so that getCarriedFrom's lazy
 * backfill recalculates the entire chain.
 */
export async function invalidateTimeBankFrom(
  employeeId: string,
  fromDate: Date | string,
  // ★ cwm-holidayot-20260911：接納 transaction client（Omit 型）—— 扣減 API 要喺同一 tx 內清快取
  db: PrismaDb = prisma,
) {
  const date = new Date(fromDate)
  const { start: monthStart } = getMonthRange(date)
  // ★ hotfix 20260922：SKIP LOCKED —— 被其他 tx（例如 finalize 嘅 deleteMany）鎖住嘅 row 唔等：
  //   嗰個 tx 自己會刪／commit；就算佢 rollback，TimeBankDirty 水位已令嗰行 cacheKey 失配。
  //   舊寫法喺 interactive tx 入面會等到 finalize commit → 超 5s → P2028 → 打卡 500。
  await (db as any).$executeRaw`
    DELETE FROM "TimeBank" WHERE "id" IN (
      SELECT "id" FROM "TimeBank"
       WHERE "employeeId" = ${employeeId}
         AND "periodMonth" >= (${monthStart.toISOString()}::timestamptz AT TIME ZONE 'UTC')   -- 欄係 UTC timestamp(3)，唔靠 session TimeZone
         FOR UPDATE SKIP LOCKED)`
}
