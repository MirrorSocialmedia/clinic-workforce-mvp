#!/usr/bin/env node
// apricot-set-token.mjs — 首次寫入 Apricot token 到 DB
// 用法: node scripts/apricot-set-token.mjs --access '<token>' --refresh '<token>' --iat '<unix_seconds>'

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

const { access, refresh, iat } = parseArgs(process.argv)

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
  where: { provider: 'APRICOT' },
  update: {
    cipherText,
    lastOkAt: new Date(),
    lastError: null,
    rotationCount: { increment: 1 },
  },
  create: {
    provider: 'APRICOT',
    cipherText,
    lastOkAt: new Date(),
  },
})

console.log(`✅ 已寫入，iat=${iat}`)
process.exit(0)
