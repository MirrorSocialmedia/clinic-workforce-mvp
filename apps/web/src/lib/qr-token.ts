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
 * Validate a QR token. Returns the token record if valid, null otherwise.
 * Checks: token exists, not used, not expired, clinic matches.
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
 * Mark a token as used.
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
