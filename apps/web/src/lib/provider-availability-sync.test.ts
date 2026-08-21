/**
 * ★ cw-pta: 「立即同步」route 登記 + cron script 守門測試
 * 跑法: cd apps/web && npx tsx --test src/lib/provider-availability-sync.test.ts
 *
 * - RBAC 登記（check-rbac-matrix.sh 嘅 source of truth 係 config.ts）
 * - cron script 存在 + 語法 + 關鍵行為（docker exec fallback、flock、log）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { CONFIG, RBAC_PERM_OVERRIDES } from './config'

const ROUTE = 'POST /api/provider-availability/sync'

describe('RBAC 登記 — POST /api/provider-availability/sync（spec §3）', () => {
  it('RBAC_MATRIX 有 OWNER/MANAGER/ACCOUNTANT（角色白名單）', () => {
    assert.deepEqual(CONFIG.RBAC_MATRIX[ROUTE], ['OWNER', 'MANAGER', 'ACCOUNTANT'])
  })

  it('RBAC_PERM_OVERRIDES 有 scheduling（有 scheduling 權限就可以，例如 grant 入嘅 EMPLOYEE）', () => {
    assert.ok(RBAC_PERM_OVERRIDES[ROUTE]?.includes('scheduling'), 'missing scheduling override')
  })

  it('EMPLOYEE / KIOSK 唔喺角色白名單（純角色唔入得去，要 grant scheduling 先入）', () => {
    const roles: string[] = CONFIG.RBAC_MATRIX[ROUTE] ?? []
    assert.ok(!roles.includes('EMPLOYEE'), 'EMPLOYEE 唔應該喺白名單')
    assert.ok(!roles.includes('KIOSK'), 'KIOSK 唔應該喺白名單')
  })

  it('route 檔案存在 + 行 requirePerm(scheduling)（403 把關來源）', () => {
    const p = join(dirname(fileURLToPath(import.meta.url)), '../app/api/provider-availability/sync/route.ts')
    assert.ok(existsSync(p), `route 檔案唔存在: ${p}`)
    const src = readFileSync(p, 'utf8')
    assert.match(src, /requirePerm\(req, 'scheduling'\)/, 'route 必須行 requirePerm(scheduling)')
    assert.match(src, /lastSyncAt\.set/, 'cooldown 記錄必須喺 sync 之前')
    assert.match(src, /retryAfterMs/, '429 必須回 retryAfterMs')
  })
})

describe('cron script — scripts/sync-availability.sh（spec §2.1）', () => {
  // apps/web/src/lib → repo root
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const scriptPath = join(repoRoot, 'scripts', 'sync-availability.sh')

  it('存在 + 可執行', () => {
    assert.ok(existsSync(scriptPath), `script 唔存在: ${scriptPath}`)
    assert.ok(statSync(scriptPath).mode & 0o111, 'script 必須可執行（chmod +x）')
  })

  it('bash -n 語法過 + 關鍵行為（set -euo pipefail / flock / docker exec fallback / log）', () => {
    execSync(`bash -n ${JSON.stringify(scriptPath)}`, { stdio: 'pipe' }) // 語法錯會 throw
    const src = readFileSync(scriptPath, 'utf8')
    assert.match(src, /set -euo pipefail/)
    assert.match(src, /exec 9>\/tmp\/\.availability-sync\.lock/)
    assert.match(src, /flock -n 9/)
    // 老細 2026-08-21 確認：生產 host→app localhost:3000 唔通 → docker exec fallback
    assert.match(src, /docker exec clinic-prod-app/)
    assert.match(src, /x-cron-key/)
    assert.match(src, /process\.env\.APRICOT_CRON_KEY/)
    assert.match(src, /\/tmp\/availability-sync\.log/)
    // 唔可以用舊 INTERNAL_SYNC_TOKEN
    assert.doesNotMatch(src, /INTERNAL_SYNC_TOKEN/)
  })
})
