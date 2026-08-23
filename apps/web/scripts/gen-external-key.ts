/**
 * ★ cw-extapi-20260823-a1: External API key 生成（MD §A.3）
 *
 * 32-byte random key（64 hex chars）— 明文只 print 一次，DB 只存 sha256 hash。
 * Key 交去 wa-inbox 嘅 .env（佢哋嗰邊叫 WORKFORCE_API_KEY）。
 *
 * 跑法（dev DB 15532）：
 *   cd apps/web && set -a && . ./.env.development && set +a \
 *     && npx tsx scripts/gen-external-key.ts wa-clinic-inbox availability,duty-roster
 *
 * 選項：
 *   --rotate  同名 key 已存在 → 換新 key（舊 key 即刻作廢！wa-inbox 要同步換 .env）
 *             預設：同名已存在 → 報錯退出（防手誤作廢運行緊嘅 key）
 */
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const ALLOWED_SCOPES = ['availability', 'duty-roster', 'bookings', 'patients', 'appointments'] as const

function main(): void {
  const args = process.argv.slice(2)
  const rotate = args.includes('--rotate')
  const positional = args.filter(a => a !== '--rotate')
  const [name, scopesArg] = positional

  if (!name || !scopesArg) {
    console.error('用法: npx tsx scripts/gen-external-key.ts <name> <scope1,scope2> [--rotate]')
    console.error(`scope 可選值: ${ALLOWED_SCOPES.join(', ')}`)
    process.exit(1)
  }

  const scopes = scopesArg.split(',').map(s => s.trim()).filter(Boolean)
  const bad = scopes.filter(s => !(ALLOWED_SCOPES as readonly string[]).includes(s))
  if (scopes.length === 0 || bad.length > 0) {
    console.error(`❌ scope 錯誤：${bad.join(', ') || '空'}（可選: ${ALLOWED_SCOPES.join(', ')}）`)
    process.exit(1)
  }

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL 未設（先 set -a && . ./.env.development && set +a）')
    process.exit(1)
  }

  const prisma = new PrismaClient()

  const key = randomBytes(32).toString('hex') // 64 hex chars — 明文只此一次
  const keyHash = createHash('sha256').update(key, 'utf8').digest('hex')

  ;(async () => {
    try {
      const existing = await prisma.externalApiKey.findUnique({ where: { name } })
      if (existing && !rotate) {
        console.error(`❌ key "${name}" 已存在。如要換 key（舊 key 即刻作廢）：加 --rotate`)
        process.exit(1)
      }

      if (existing) {
        await prisma.externalApiKey.update({
          where: { name },
          data: { keyHash, scopes, active: true },
        })
      } else {
        await prisma.externalApiKey.create({
          data: { name, keyHash, scopes },
        })
      }

      console.log('────────────────────────────────────────────────────────────')
      console.log('  🔑 External API key（只顯示一次 — 立即存入 wa-inbox .env，唔好 log/commit）：')
      console.log()
      console.log(`  ${key}`)
      console.log()
      console.log(`  name:   ${name}`)
      console.log(`  scopes: ${scopes.join(', ')}`)
      console.log(`  hash:   ${keyHash.slice(0, 12)}…（DB 只存 hash）`)
      console.log('────────────────────────────────────────────────────────────')
      if (existing) {
        console.log('⚠️ 已旋轉（--rotate）— 舊 key 即刻作廢，wa-inbox 必須同步換 .env')
      }
    } finally {
      await prisma.$disconnect()
    }
  })().catch((e) => {
    console.error('❌ gen-external-key 失敗:', e)
    process.exit(1)
  })
}

main()
