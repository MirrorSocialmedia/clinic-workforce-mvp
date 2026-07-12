import { prisma } from '@/lib/prisma'
import { toHKDateStr } from './hk-date'

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
    clinicId?: string
    db?: typeof prisma
  },
): Promise<Array<{ punchType: string; clinicId: string; effectiveTime: Date; raw: any }>> {
  const db = opts?.db ?? prisma

  const punchWhere: any = {
    punchTime: { gte: start, lte: end },
    void: { is: null },
  }
  if (opts?.employeeId) punchWhere.employeeId = opts.employeeId
  if (opts?.clinicId) punchWhere.clinicId = opts.clinicId

  const correctionWhere: any = {
    correctedTime: { gte: start, lte: end },
    status: 'APPROVED',
  }
  if (opts?.employeeId) correctionWhere.employeeId = opts.employeeId
  if (opts?.clinicId) correctionWhere.clinicId = opts.clinicId

  const [punches, corrections] = await Promise.all([
    db.punchRecord.findMany({
      where: punchWhere,
      orderBy: { punchTime: 'asc' },
    }),
    db.punchCorrection.findMany({
      where: correctionWhere,
    }),
  ])

  // correctionMap: date:clinicId:punchType → correctedTime
  const correctionMap = new Map<string, Date>()
  for (const c of corrections) {
    const key = `${toHKDateStr(new Date(c.correctedTime))}:${c.clinicId}:${c.punchType}`
    correctionMap.set(key, new Date(c.correctedTime))
  }

  return punches.map((p: any) => {
    const key = `${toHKDateStr(new Date(p.punchTime))}:${p.clinicId}:${p.punchType}`
    return {
      punchType: p.punchType,
      clinicId: p.clinicId,
      effectiveTime: correctionMap.get(key) ?? new Date(p.punchTime),
      raw: p,
    }
  })
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
  db = prisma,
) {
  const date = new Date(fromDate)
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1)
  await db.timeBank.deleteMany({
    where: { employeeId, periodMonth: { gte: monthStart } },
  })
}
