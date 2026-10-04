#!/usr/bin/env node
// apricot-set-token.mjs — 首次寫入 Apricot token 到 DB
// ★ cwm-datasource-20261003：日常更新請用網頁「資料來源」頁（貼 cookie → 自動測試）；呢個腳本只係後備
// 用法: node scripts/apricot-set-token.mjs --access '<token>' --refresh '<token>' --iat '<unix_seconds>' [--account TY]
// ★ 生產（2026-10-01）：image 係 Next standalone，container 入面冇 scripts/ —— 喺 host 經 stdin 傳入：
//   docker exec -i clinic-prod-app node --input-type=module - --access '…' --refresh '…' --iat '…' --account TY \
//     < /home/clinicapp/clinic/scripts/apricot-set-token.mjs
//   寫入後唔使重啟 app（token 每次 call 都由 DB 讀）
// ★ cwm-apricotty-20261001：--account 唔傳 = MAIN（原帳號，provider 'APRICOT'）；
//   青衣：--account TY → provider 'APRICOT:TY'（同 lib/apricot/account.ts credentialProviderKey 一致）

import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      args[key] = argv[i + 1] ?? ''
      i++
    }
  }
  return args
}

const { access, refresh, iat, account: accountArg } = parseArgs(process.argv)

const account = (accountArg ?? 'MAIN').trim().toUpperCase() || 'MAIN'
if (!/^[A-Z][A-Z0-9_]{0,15}$/.test(account)) {
  console.error('❌ --account 只准大楷英文／數字／底線（例如 TY）')
  process.exit(1)
}
const provider = account === 'MAIN' ? 'APRICOT' : `APRICOT:${account}`

if (!access || !refresh || !iat) {
  console.error('❌ 需要三個參數: --access --refresh --iat')
  process.exit(1)
}

// ★ 驗 iat 係 10 位 unix 秒
if (!/^\d{10}$/.test(iat)) {
  console.error('❌ iat 必須係 10 位 unix 秒數')
  process.exit(1)
}

// Encryption (same logic as lib/apricot/token.ts but standalone)
const KEY = Buffer.from(process.env.APRICOT_ENC_KEY ?? '', 'base64')
if (KEY.length !== 32) {
  console.error('❌ APRICOT_ENC_KEY 未設定或唔係 32-byte base64')
  process.exit(1)
}

function enc(plain) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

const creds = { accessToken: access, refreshToken: refresh, iat: iat }
const cipherText = enc(JSON.stringify(creds))

await prisma.externalCredential.upsert({
  where: { provider },
  update: {
    cipherText,
    lastOkAt: new Date(),
    lastError: null,
    rotationCount: 0,
  },
  create: {
    provider,
    cipherText,
    lastOkAt: new Date(),
  },
})

console.log(`✅ 已寫入 ${provider}（帳號 ${account}），iat=${iat}`)
process.exit(0)
