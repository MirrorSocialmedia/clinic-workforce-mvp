import { readdirSync, statSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'

// Resolve paths relative to this script's location
const scriptDir = resolve(__dirname || '.')
const apiDir = resolve(scriptDir, '../src/app/api')
const configPath = resolve(scriptDir, '../src/lib/config.ts')

// Read and parse RBAC_MATRIX from config.ts without importing (avoids module issues)
const configContent = readFileSync(configPath, 'utf8')
const rbacLines: Record<string, string[]> = {}

// Parse RBAC entries from the config file
const rbacRegex = /'([^']+)'\s*:\s*\[([^\]]+)\]/g
let match
while ((match = rbacRegex.exec(configContent)) !== null) {
  const [, key, rolesStr] = match
  // Only capture entries in RBAC_MATRIX section (skip other config)
  if (key.startsWith('GET ') || key.startsWith('POST ') || key.startsWith('PUT ') || key.startsWith('DELETE ') || key.startsWith('PATCH ')) {
    const roles = rolesStr.split(',').map(r => r.trim().replace(/'/g, '')).filter(Boolean)
    rbacLines[key] = roles
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
        // Extract API path from the file path
        const apiPath = full
          .replace(/.*\/api\//, '')
          .replace(/\/route\.ts$/, '')
          .replace(/\[([^\]]+)\]/g, ':$1')
        const fullApiPath = `/api/${apiPath}`

        for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
          if (content.includes(`export async function ${method}`)) {
            const key = `${method} ${fullApiPath}`
            // Public endpoints (auth) don't need RBAC registration
            const isPublic = /auth\/(login|forgot|reset)/.test(apiPath)
            if (!rbacLines[key] && !isPublic) {
              misses.push(`${key} (file: ${full.replace('src/', '')})`)
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning directory ${dir}:`, err)
  }
  return misses
}

const misses = scanRoutes(apiDir)

if (misses.length) {
  console.error('\n❌ 以下 route 未登記 RBAC：')
  misses.forEach(m => console.error(`  - ${m}`))
  console.error(`\n請在 config.ts 的 RBAC_MATRIX 中補上這些路由\n`)
  process.exit(1)
} else {
  console.log('✅ 所有 route 都已登記 RBAC')
}
