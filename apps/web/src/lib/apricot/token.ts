import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { currentApricotAccount, credentialProviderKey } from './account'

function requireKey(): Buffer {
  const k = Buffer.from(process.env.APRICOT_ENC_KEY ?? '', 'base64')
  if (k.length !== 32) throw new Error('APRICOT_ENC_KEY 必須係 32-byte base64')
  return k
}

export type ApricotCreds = { accessToken: string; refreshToken: string; iat: string }

function enc(plain: string) {
  const key = requireKey()
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

function dec(b64: string) {
  const key = requireKey()
  const raw = Buffer.from(b64, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

// ★ 唔做 module-level memo —— rotation 之後 memo 會過期
// ★ cwm-apricotty-20261001：逐帳號（預設 = 而家嘅帳號 context；MAIN = 舊 provider 'APRICOT'）
export async function loadCreds(account: string = currentApricotAccount()): Promise<ApricotCreds | null> {
  const row = await prisma.externalCredential.findUnique({ where: { provider: credentialProviderKey(account) } })
  if (!row) return null
  return JSON.parse(dec(row.cipherText))
}

export async function saveCreds(c: ApricotCreds, refreshExpiry?: Date, account: string = currentApricotAccount()) {
  await prisma.externalCredential.update({
    where: { provider: credentialProviderKey(account) },
    data: {
      cipherText: enc(JSON.stringify(c)),
      ...(refreshExpiry ? { refreshExpiry } : {}),
      lastOkAt: new Date(),
      lastError: null,
      rotationCount: { increment: 1 },
    },
  })
}

export async function markError(msg: string, account: string = currentApricotAccount()) {
  await prisma.externalCredential
    .update({ where: { provider: credentialProviderKey(account) }, data: { lastError: msg.slice(0, 500) } })
    .catch(e => console.error('[apricot] markError 失敗', e))
}

/**
 * ★ cwm-datasource-20261003：設定頁人手貼入新憑證（取代 docker exec 跑 apricot-set-token.mjs）。
 *   upsert（新來源都得）；lastOkAt 清空 = 「未驗證」—— 由隨後嘅測試連線成功先寫返。
 *   ⚠️ 呢度唔 log、唔 audit 憑證內容（audit 由 route 寫，只記「更新咗」）。
 */
export async function setCredsManually(c: ApricotCreds, account: string) {
  const provider = credentialProviderKey(account)
  const cipherText = enc(JSON.stringify(c))
  await prisma.externalCredential.upsert({
    where: { provider },
    update: { cipherText, lastOkAt: null, lastError: null, refreshExpiry: null, rotationCount: 0 },
    create: { provider, cipherText },
  })
}
