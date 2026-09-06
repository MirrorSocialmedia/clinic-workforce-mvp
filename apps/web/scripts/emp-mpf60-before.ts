/**
 * cwm-mpf60-20260906 — #19 BEFORE capture（動 engine 前跑，baseline a13ed37e）
 * Run: set -a && . ./.env.development && set +a && npx tsx scripts/emp-mpf60-before.ts
 */
import { runCapture } from './emp-mpf60-shared'

async function main() {
  await runCapture('/tmp/emp-mpf60-before.json')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
