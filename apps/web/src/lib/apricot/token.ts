import crypto from 'crypto'
import { prisma } from '@/lib/prisma'

const KEY = Buffer.from(process.env.APRICOT_ENC_KEY ?? '', 'base64')
if (KEY.length !== 32 && process.env.NODE_ENV === 'production') {
  throw new Error('APRICOT_ENC_KEY 必須係 32-byte base64')
}

export type ApricotCreds = { accessToken: string; refreshToken: string; iat: string }

function enc(plain: string) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

function dec(b64: string) {
  const raw = Buffer.from(b64, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

// ★ 唔做 module-level memo —— rotation 之後 memo 會過期
export async function loadCreds(): Promise<ApricotCreds | null> {
  const row = await prisma.externalCredential.findUnique({ where: { provider: 'APRICOT' } })
  if (!row) return null
  return JSON.parse(dec(row.cipherText))
}

export async function saveCreds(c: ApricotCreds, refreshExpiry?: Date) {
  await prisma.externalCredential.update({
    where: { provider: 'APRICOT' },
    data: {
      cipherText: enc(JSON.stringify(c)),
      ...(refreshExpiry ? { refreshExpiry } : {}),
      lastOkAt: new Date(),
      lastError: null,
      rotationCount: { increment: 1 },
    },
  })
}

export async function markError(msg: string) {
  await prisma.externalCredential
    .update({ where: { provider: 'APRICOT' }, data: { lastError: msg.slice(0, 500) } })
    .catch(e => console.error('[apricot] markError 失敗', e))
}
