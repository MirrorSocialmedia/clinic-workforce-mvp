import { readdirSync, statSync, readFileSync } from 'fs'
import { resolve } from 'path'

const scriptDir = resolve(__dirname || '.')
const apiDir = resolve(scriptDir, '../src/app/api')
const configPath = resolve(scriptDir, '../src/lib/config.ts')

const configContent = readFileSync(configPath, 'utf8')
const rbacLines: Record<string, string[]> = {}

// Parse RBAC entries from config
const rbacRegex = /'([^']+)'\s*:\s*\[([^\]]+)\]/g
let match
while ((match = rbacRegex.exec(configContent)) !== null) {
  const [, key, rolesStr] = match
  if (/^(GET|POST|PUT|DELETE|PATCH) \/api\//.test(key)) {
    const roles = rolesStr.split(',').map(r => r.trim().replace(/'/g, '')).filter(Boolean)
    // Normalize all :paramName → :id (matches middleware behavior)
    const normalizedKey = key.replace(/:[a-zA-Z0-9_]+/g, ':id')
    rbacLines[normalizedKey] = roles
  }
}

function scanRoutes(dir: string): string[] {
  const misses: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`
      if (statSync(full).isDirectory()) {
        misses.push(...scanRoutes(full))
      } else if (entry === 'route.ts') {
        const content = readFileSync(full, 'utf8')
        // Convert [param] → :id (matches middleware normalization)
        const apiPath = full
          .replace(/.*\/api\//, '')
          .replace(/\/route\.ts$/, '')
          .replace(/\[([^\]]+)\]/g, ':id')
        const fullApiPath = `/api/${apiPath}`

        for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
          if (content.includes(`export async function ${method}`)) {
            const key = `${method} ${fullApiPath}`
            const isPublic = /auth\/(login|forgot|reset)/.test(apiPath)
            if (!rbacLines[key] && !isPublic) {
              misses.push(`${key} (file: ${full.replace('src/', '')})`)
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning ${dir}:`, err)
  }
  return misses
}

const misses = scanRoutes(apiDir)

if (misses.length) {
  console.error('\n❌ 以下 route 未登記 RBAC：')
  misses.forEach(m => console.error(`  - ${m}`))
  console.error('\n請在 config.ts 的 RBAC_MATRIX 中補上這些路由\n')
  process.exit(1)
} else {
  console.log('✅ 所有 route 都已登記 RBAC')
}
