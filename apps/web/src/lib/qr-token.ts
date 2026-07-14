import { createHash, randomBytes } from 'crypto'
import { prisma } from './prisma'

const TOKEN_TTL_SECONDS = 30

/**
 * Generate an 8-char base64url short code.
 * 6 bytes = 48 bits = 2^48 space. With 30s expiry window, brute force infeasible.
 */
function generateShortCode(): string {
  return randomBytes(6).toString('base64url').slice(0, 8)
}

/**
 * Generate a dynamic QR token for a clinic.
 * Token format: SHA-256(clinicId + timestamp + random(16))
 * Short code: 8-char base64url, displayed in QR instead of full token.
 * Expires after TOKEN_TTL_SECONDS seconds.
 */
export async function generateQRToken(clinicId: string): Promise<{
  id: string
  token: string
  shortCode: string
  expiresAt: Date
}> {
  const raw = `${clinicId}:${Date.now()}:${randomBytes(16).toString('hex')}`
  const token = createHash('sha256').update(raw).digest('hex')
  const shortCode = generateShortCode()
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + TOKEN_TTL_SECONDS * 1000)

  const record = await prisma.qRToken.create({
    data: {
      clinicId,
      token,
      shortCode,
      issuedAt,
      expiresAt,
    },
  })

  return {
    id: record.id,
    token: record.token,
    shortCode: record.shortCode!,
    expiresAt: record.expiresAt,
  }
}

/**
 * Validate + mark used in a single atomic operation.
 * Accepts either full token or shortCode. If shortCode, resolves to full token first.
 * Prevents TOCTOU race: two concurrent punches with the same token
 * cannot both succeed because updateMany checks used:false + expiresAt
 * and sets used:true atomically.
 */
export async function validateAndMarkTokenUsed(
  scanned: string,
  employeeId: string
): Promise<{
  valid: boolean
  reason?: string
  clinicId?: string
  source?: string
} | null> {
  // Resolve: try as full token first, then as shortCode
  let record = await prisma.qRToken.findUnique({
    where: { token: scanned },
  })

  // If not found as full token, try as shortCode
  if (!record) {
    record = await prisma.qRToken.findFirst({
      where: {
        shortCode: scanned,
      },
    })
  }

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
  // Use the actual token (unique key) for the update
  const updated = await prisma.qRToken.updateMany({
    where: {
      token: record.token,
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
  scanned: string,
  clinicId?: string
): Promise<{
  valid: boolean
  reason?: string
  tokenRecord?: any
} | null> {
  let record = await prisma.qRToken.findUnique({
    where: { token: scanned },
  })

  // If not found as full token, try as shortCode
  if (!record) {
    record = await prisma.qRToken.findFirst({
      where: {
        shortCode: scanned,
      },
    })
  }

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
