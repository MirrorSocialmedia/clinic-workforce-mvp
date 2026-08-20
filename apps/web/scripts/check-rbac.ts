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
            // ★ /api/internal/* = shared-secret internal endpoint（X-Internal-Token，
            //   唔經 session RBAC —— spec §4「唔經 RBAC，冇 fallback 預設值」）→ 豁免
            const isInternal = fullApiPath.startsWith('/api/internal/')
            if (!rbacLines[key] && !isPublic && !isInternal) {
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

// ★ QA30: Cross-check — every route using requireAuth must have a matrix entry
//   Prevents the "route 寫咗但 matrix 冇" bug (seen with preflight API + daily-hash)
function scanRequireAuthRoutes(dir: string): string[] {
  const problems: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`
      if (statSync(full).isDirectory()) {
        problems.push(...scanRequireAuthRoutes(full))
      } else if (entry === 'route.ts') {
        const content = readFileSync(full, 'utf8')
        // Check if this file imports requireAuth
        if (!content.includes('requireAuth') && !content.includes('requirePerm')) continue

        const apiPath = full
          .replace(/.*\/api\//, '')
          .replace(/\/route\.ts$/, '')
          .replace(/\[([^\]]+)\]/g, ':id')
        const fullApiPath = `/api/${apiPath}`

        // Normalize to matrix format (dynamic segments → :id)
        const normalizedPath = fullApiPath.replace(/:[a-zA-Z0-9_]+/g, ':id')

        for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
          if (content.includes(`export async function ${method}`)) {
            // Check requireAuth matrix key
            const authKey = `${method} ${normalizedPath}`
            // Check requirePerm override key
            const permKey = `${method} ${normalizedPath}`
            const isPublic = /auth\/(login|forgot|reset)/.test(apiPath)

            if (!isPublic && !rbacLines[authKey] && !content.includes(`'${method}'`) && !content.includes(`'${normalizedPath}'`)) {
              // Only flag if the route actually calls requireAuth(req, method, ...)
              const usesRequireAuth = /requireAuth\s*\(/.test(content) && /\${method}/.test(content)
              if (usesRequireAuth || /requireAuth\s*\(\s*req\s*,\s*['"]\${method}['"]/.test(content)) {
                problems.push(`${authKey} uses requireAuth but has no RBAC matrix entry (file: ${full.replace('src/', '')})`)
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning requireAuth routes in ${dir}:`, err)
  }
  return problems
}

const authProblems = scanRequireAuthRoutes(apiDir)

if (authProblems.length) {
  console.error('\n❌ 以下 route 使用 requireAuth 但 RBAC matrix 未有對應 key：')
  authProblems.forEach(m => console.error(`  - ${m}`))
  console.error('\n這些 route 會永遠返回 403，請在 config.ts 的 RBAC_MATRIX 中補上\n')
  process.exit(1)
}

if (misses.length) {
  console.error('\n❌ 以下 route 未登記 RBAC：')
  misses.forEach(m => console.error(`  - ${m}`))
  console.error('\n請在 config.ts 的 RBAC_MATRIX 中補上這些路由\n')
  process.exit(1)
} else {
  console.log('✅ 所有 route 都已登記 RBAC')
}
