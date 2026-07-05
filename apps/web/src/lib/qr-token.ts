import { createHash, randomBytes } from 'crypto'
import { prisma } from './prisma'

const TOKEN_TTL_SECONDS = 30

/**
 * Generate a dynamic QR token for a clinic.
 * Token format: SHA-256(clinicId + timestamp + random(16))
 * Expires after TOKEN_TTL_SECONDS seconds.
 */
export async function generateQRToken(clinicId: string): Promise<{
  id: string
  token: string
  expiresAt: Date
}> {
  const raw = `${clinicId}:${Date.now()}:${randomBytes(16).toString('hex')}`
  const token = createHash('sha256').update(raw).digest('hex')
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + TOKEN_TTL_SECONDS * 1000)

  const record = await prisma.qRToken.create({
    data: {
      clinicId,
      token,
      issuedAt,
      expiresAt,
    },
  })

  return {
    id: record.id,
    token: record.token,
    expiresAt: record.expiresAt,
  }
}

/**
 * Validate + mark used in a single atomic operation.
 * Prevents TOCTOU race: two concurrent punches with the same token
 * cannot both succeed because updateMany checks used:false + expiresAt
 * and sets used:true atomically.
 */
export async function validateAndMarkTokenUsed(
  token: string,
  employeeId: string
): Promise<{
  valid: boolean
  reason?: string
  clinicId?: string
  source?: string
} | null> {
  // First check: does the token exist and is it valid?
  const record = await prisma.qRToken.findUnique({
    where: { token },
  })

  if (!record) {
    return { valid: false, reason: 'Token not found' }
  }

  if (record.used) {
    return { valid: false, reason: 'Token already used' }
  }

  if (new Date() > record.expiresAt) {
    return { valid: false, reason: 'Token expired' }
  }

  // Atomic: mark as used — only if still unused and not expired
  const updated = await prisma.qRToken.updateMany({
    where: {
      token,
      used: false,
      expiresAt: { gte: new Date() },
    },
    data: {
      used: true,
      usedBy: employeeId,
      usedAt: new Date(),
    },
  })

  if (updated.count !== 1) {
    return { valid: false, reason: 'Token invalid or already used (race)' }
  }

  return {
    valid: true,
    clinicId: record.clinicId,
    source: 'QR_DYNAMIC',
  }
}

/**
 * Validate a QR token without marking as used.
 * Used for preview / check purposes only.
 */
export async function validateQRToken(
  token: string,
  clinicId?: string
): Promise<{
  valid: boolean
  reason?: string
  tokenRecord?: any
} | null> {
  const record = await prisma.qRToken.findUnique({
    where: { token },
  })

  if (!record) {
    return { valid: false, reason: 'Token not found' }
  }

  if (record.used) {
    return { valid: false, reason: 'Token already used' }
  }

  if (new Date() > record.expiresAt) {
    return { valid: false, reason: 'Token expired' }
  }

  if (clinicId && record.clinicId !== clinicId) {
    return { valid: false, reason: 'Token clinic mismatch' }
  }

  return { valid: true, tokenRecord: record }
}

/**
 * Mark a token as used. (Legacy — prefer validateAndMarkTokenUsed)
 */
export async function markTokenUsed(token: string, employeeId: string): Promise<void> {
  await prisma.qRToken.updateMany({
    where: { token, used: false },
    data: {
      used: true,
      usedBy: employeeId,
      usedAt: new Date(),
    },
  })
}

/**
 * Clean up expired QR tokens. Called by cron / scheduled task.
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const result = await prisma.qRToken.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
      used: false,
    },
  })

  return result.count
}

/**
 * Get the TTL in seconds (exported for testing).
 */
export function getTokenTTLS(): number {
  return TOKEN_TTL_SECONDS
}
