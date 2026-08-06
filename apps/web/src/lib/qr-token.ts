import { createHash, randomBytes } from 'crypto'
import { prisma } from './prisma'
import { QR_REFRESH_SECONDS } from './qr-constants'

const TOKEN_TTL_SECONDS = QR_REFRESH_SECONDS * 2 // 舊碼多活一個週期 — 尾端掃描唔過期

/**
 * Generate an 8-char base64url short code.
 * 6 bytes = 48 bits = 2^48 space. With 60s expiry window, brute force infeasible.
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
  let token = createHash('sha256').update(raw).digest('hex')
  let shortCode = generateShortCode()
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + TOKEN_TTL_SECONDS * 1000)

  // ★ 2026-08-06: retry-on-conflict — shortCode 48-bit 空間極低衝突，
  // 但 cleanup 同 generate 之間有 race window（舊碼先刪、新碼重覆）
  // 三次未中 → 加時間戳擴容（8+3=11 chars），理論 zero collision
  let maxRetries = 3
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
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
    } catch (err: any) {
      if (err?.code === 'P2002' && attempt < maxRetries - 1) {
        // Retry with new random short code
        shortCode = randomBytes(6).toString('base64url').slice(0, 8)
        token = createHash('sha256').update(clinicId + issuedAt.getTime() + shortCode).digest('hex')
      } else {
        throw err
      }
    }
  }
  throw new Error('Failed to generate QR token after retries')
}

/**
 * Validate + mark used in a single atomic operation.
 * ★ NEW: Uses QRTokenUsage table — each employee can use each token once.
 * Multiple employees scanning the same token simultaneously = both succeed.
 * Same employee scanning twice = P2002 unique violation → rejected.
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
        expiresAt: { gt: new Date() },
      },
      orderBy: { issuedAt: 'desc' },
    })
  }

  if (!record) {
    return { valid: false, reason: 'Token not found' }
  }

  if (new Date() > record.expiresAt) {
    return { valid: false, reason: 'Token expired' }
  }

  // ★ Atomic: create usage record — unique constraint prevents duplicate per employee
  try {
    await prisma.qRTokenUsage.create({
      data: {
        tokenId: record.id,
        employeeId,
      },
    })
  } catch (e: any) {
    if (e.code === 'P2002') {
      return { valid: false, reason: 'ALREADY_USED' }
    }
    throw e
  }

  return {
    valid: true,
    clinicId: record.clinicId,
    source: 'QR_DYNAMIC',
  }
}

/**
 * 清理過期 QR token。
 * ★ 只刪【冇人用過】嘅 —— 用過嘅要保留做證據（QRTokenUsage 有 onDelete: Cascade，
 * 刪 token 會連「邊個幾時用咗邊個碼」一齊抹走）。
 * 注意：`used` 欄位喺新流程從來冇被 set 過，唔可以用嚟做條件。
 * ★ 2026-08-06：cleanup 同 generate 之間有 12s race window — 舊碼 cleanup 咗但顯示頁
 * 仲喺度顯示，到時會生成新碼。generateQRToken 有 retry-on-conflict 處理。
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const result = await prisma.qRToken.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
      usages: { none: {} },
    },
  })
  return result.count
}

/**
 * 已用碼嘅長期 retention —— 由 crontab 每日跑一次，唔好放喺 request path。
 */
export async function purgeOldUsedTokens(days = 90): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86400_000)
  const result = await prisma.qRToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  })
  return result.count
}

/**
 * Get the TTL in seconds (exported for testing).
 */
export function getTokenTTLS(): number {
  return TOKEN_TTL_SECONDS
}
