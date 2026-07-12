import { createHash } from 'crypto'
import { prisma } from './prisma'

/**
 * Compute SHA-256 hash for all punch records of a clinic on a given date.
 * Format: SHA-256(employeeId:punchTime:punchType:source|...)
 * Records sorted by employeeId + punchTime.
 */
export async function computeDailyHash(
  clinicId: string,
  date: Date
): Promise<{ hash: string; recordCount: number } | null> {
  // Get the date boundaries
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date(date)
  endOfDay.setHours(23, 59, 59, 999)

  const records = await prisma.punchRecord.findMany({
    where: {
      clinicId,
      punchTime: {
        gte: startOfDay,
        lte: endOfDay,
      },
      void: { is: null }, // Exclude voided punches from hash
    },
    orderBy: [
      { employeeId: 'asc' },
      { punchTime: 'asc' },
    ],
  })

  if (records.length === 0) {
    return null
  }

  // Build hash string
  const parts = records.map((r) => {
    return `${r.employeeId}:${r.punchTime.toISOString()}:${r.punchType}:${r.source}`
  })

  const hashInput = parts.join('|')
  const hash = createHash('sha256').update(hashInput).digest('hex')

  return { hash, recordCount: records.length }
}

/**
 * Generate daily hash for a clinic on a given date.
 * Upserts into DailyHash table.
 */
export async function generateDailyHash(
  clinicId: string,
  date: Date
): Promise<{ hash: string; recordCount: number } | null> {
  const result = await computeDailyHash(clinicId, date)

  if (!result) {
    return null
  }

  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)

  await prisma.dailyHash.upsert({
    where: {
      clinicId_date: {
        clinicId,
        date: startOfDay,
      },
    },
    create: {
      clinicId,
      date: startOfDay,
      hash: result.hash,
      recordCount: result.recordCount,
    },
    update: {
      hash: result.hash,
      recordCount: result.recordCount,
    },
  })

  return result
}

/**
 * Verify a daily hash by recomputing and comparing.
 */
export async function verifyDailyHash(
  clinicId: string,
  date: Date
): Promise<{ valid: boolean; storedHash?: string; computedHash?: string; recordCount?: number }> {
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)

  const stored = await prisma.dailyHash.findUnique({
    where: {
      clinicId_date: {
        clinicId,
        date: startOfDay,
      },
    },
  })

  if (!stored) {
    return { valid: false }
  }

  const computed = await computeDailyHash(clinicId, date)

  if (!computed) {
    return { valid: false, storedHash: stored.hash }
  }

  return {
    valid: stored.hash === computed.hash,
    storedHash: stored.hash,
    computedHash: computed.hash,
    recordCount: computed.recordCount,
  }
}

/**
 * Get daily hash for a clinic on a given date.
 */
export async function getDailyHash(
  clinicId: string,
  date: Date
): Promise<any | null> {
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)

  return prisma.dailyHash.findUnique({
    where: {
      clinicId_date: {
        clinicId,
        date: startOfDay,
      },
    },
    include: {
      clinic: { select: { id: true, name: true } },
    },
  })
}

/**
 * List daily hashes for a clinic within a date range.
 */
export async function listDailyHashes(
  clinicId: string,
  startDate?: Date,
  endDate?: Date,
  limit = 30
): Promise<any[]> {
  const where: any = { clinicId }

  if (startDate || endDate) {
    where.date = {}
    if (startDate) where.date.gte = startDate
    if (endDate) where.date.lte = endDate
  }

  return prisma.dailyHash.findMany({
    where,
    orderBy: { date: 'desc' },
    take: limit,
    include: {
      clinic: { select: { id: true, name: true } },
    },
  })
}
