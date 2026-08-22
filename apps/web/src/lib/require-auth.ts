import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, type SessionPayload } from './auth'
import { CONFIG, RBAC_PERM_OVERRIDES, type Role } from './config'
import { cookies } from 'next/headers'
import { type PermKey, ROLE_DEFAULTS, PERMISSIONS } from './permissions'
import { prisma } from '@/lib/prisma'

// ----------------------------------------------------------
// Unified auth gate — all API routes must call this
// ----------------------------------------------------------

type DataScope = 'all' | 'my-clinics' | 'self'

interface AuthError {
  error: NextResponse
  session?: never
  scope?: never
}

interface AuthSuccess {
  error?: never
  session: SessionPayload
  scope: DataScope
  perms?: string[]
}

type AuthResult = AuthError | AuthSuccess

/**
 * Check if auth result has an error.
 * Provides TypeScript narrowing for discriminated union.
 */
export function isAuthError(auth: AuthResult): auth is AuthError {
  return 'error' in auth
}

/**
 * Normalize a URL path to match the RBAC matrix keys.
 * Strips dynamic segments like /[id] → /:id
 */
function normalizeRoute(url: URL, method: string): string {
  let path = url.pathname
  // Strip trailing slash
  if (path.endsWith('/') && path.length > 1) path = path.slice(0, -1)
  // Replace dynamic segments with :id
  // ★ 順序重要：日期段一定要排喺純數字 regex 之前，
  // 否則 /\d{3,}/ 會咬走 "2026" 令 /api/daily-hash/2026-07-25 變 /:id-07-25
  path = path.replace(/\/\d{4}-\d{2}-\d{2}(?=\/|$)/g, '/:date')
  // ★ UUID 有 dash，唔會被 {20,} 命中，要獨立處理（目前全部 model 用 cuid，此條為將來防呆）
  path = path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
    .replace(/\/[a-z0-9]{20,}/gi, '/:id')
    .replace(/\/\d{3,}/g, '/:id')
  return `${method} ${path}`
}

/**
 * Check IP against allowlist (used by KIOSK enforcement).
 */
function checkIpAllowlist(clientIp: string, allowlist: string): boolean {
  const allowedIps = allowlist.split(',').map(s => s.trim()).filter(Boolean)
  return allowedIps.some(rule => clientIp === rule || clientIp.startsWith(rule))
}

/**
 * Get client IP from request headers (Cloudflare priority).
 */
function getClientIp(req: NextRequest): string {
  return (req.headers.get('cf-connecting-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim())
    || 'unknown'
}

/**
 * Verify token + RBAC check + tokenVersion + data scope.
 * Now async — performs DB lookup for tokenVersion + KIOSK IP enforcement.
 *
 * Usage in API routes:
 *   const auth = await requireAuth(req, req.method, req.url)
 *   if (auth.error) return auth.error
 *   const { session, scope } = auth
 */
export async function requireAuth(
  req: NextRequest,
  method: string,
  url: string
): Promise<AuthResult> {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  // RBAC check
  const parsedUrl = new URL(url, 'http://localhost')
  const normalized = normalizeRoute(parsedUrl, method)
  const allowed = CONFIG.RBAC_MATRIX[normalized]

  if (!allowed) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`⚠️ RBAC MISS: "${normalized}" not in matrix! New API forgot to register?`)
    }
    return { error: NextResponse.json({ error: `Forbidden (route not registered: ${normalized})` }, { status: 403 }) }
  }

  let roleOk = allowed.includes(session.role)

  // ★ 有效權限 = role 預設 + grant − deny（提前計算，供權限覆蓋使用）
  let grant: string[] = []
  let deny: string[] = []
  try {
    const permUser = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { permissionsJson: true },
    })
    if (permUser?.permissionsJson) {
      const parsed = typeof permUser.permissionsJson === 'string'
        ? JSON.parse(permUser.permissionsJson) : permUser.permissionsJson
      grant = (parsed as any).grant || []
      deny = (parsed as any).deny || []
    }
  } catch { /* ignore — perms not critical for basic auth */ }
  const base = ROLE_DEFAULTS[session.role] || []
  const perms = session.role === 'OWNER'
    ? Object.keys(PERMISSIONS)
    : [...new Set([...base, ...grant])].filter(p => !deny.includes(p))

  // ★ 權限覆蓋：角色唔喺白名單，但持有指定權限一樣放行
  let viaPerm = false
  if (!roleOk) {
    const needPerms = RBAC_PERM_OVERRIDES[normalized]
    if (needPerms?.some(p => (perms ?? []).includes(p))) {
      roleOk = true
      viaPerm = true
    }
  }

  if (!roleOk) {
    return {
      error: NextResponse.json(
        { error: `Forbidden (role ${session.role} not allowed on ${normalized})` },
        { status: 403 },
      ),
    }
  }

  // tokenVersion + KIOSK IP + status check (single DB query)
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { tokenVersion: true, status: true, ipAllowlist: true, clinics: { select: { clinicId: true } } },
  })

  if (!user || user.status !== 'ACTIVE') {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  if (session.tokenVersion !== undefined && user.tokenVersion !== session.tokenVersion) {
    return { error: NextResponse.json({ error: 'Session invalidated' }, { status: 401 }) }
  }

  // KIOSK IP enforcement on every request
  if (session.role === 'KIOSK' && user.ipAllowlist) {
    const clientIp = getClientIp(req)
    if (!checkIpAllowlist(clientIp, user.ipAllowlist)) {
      return { error: NextResponse.json({ error: '此帳號僅限店舖網絡登入' }, { status: 403 }) }
    }
  }

  // ★ 授權範圍一律以 DB 為準。
  //   session.clinics 係登入嗰刻嘅 JWT 快照，經理事後被指派新店唔會反映，
  //   而 session 有 365 日，等於呢個過期快照可以掛足一年。
  const freshClinics = user.clinics.map(c => c.clinicId)

  // Data scope
  let scope: DataScope = 'all'
  if (session.role === 'MANAGER') scope = 'my-clinics'
  if (session.role === 'EMPLOYEE' || session.role === 'KIOSK') scope = 'self'

  // ★ 經 scheduling 權限放行嘅，scope = all（同 requirePerm 一致）
  if (viaPerm && RBAC_PERM_OVERRIDES[normalized]?.includes('scheduling')) {
    scope = 'all'
  }

  /**
   * ★ 排班需要读到的数据 route。
   * 有 scheduling 权限 = 全店排班权，排班必然要睇到所有员工嘅假期 + 假期余额。
   * ⚠️ 唔可以只喺 viaPerm 时提升 —— EMPLOYEE 本身喺呢啲 route 嘅 role 白名單内，
   *   根本唔会走 viaPerm 分支，结果 scope 一直係 'self'。
   * ⚠️ 亦唔可以无差别提升所有 requireAuth route —— 打卡记录、审计等唔属排班范围。
   */
  const SCHEDULING_DATA_ROUTES = [
    'GET /api/leave-requests',
    'GET /api/leave-balance',
    'GET /api/employees',
    'GET /api/clinics',
  ]
  if ((perms ?? []).includes('scheduling') && SCHEDULING_DATA_ROUTES.includes(normalized)) {
    scope = 'all'
  }

  /**
   * ★ 考勤管理需要读到的数据 route。
   * 有 attendance_manage 权限 = 管理考勤，需要睇到所有员工嘅补登记录。
   * 唔改呢度会出现同假期一模一样的症状：补登成功但列表睇不到。
   */
  const ATTENDANCE_DATA_ROUTES = ['GET /api/punch-corrections', 'GET /api/punches']
  if ((perms ?? []).includes('attendance_manage') && ATTENDANCE_DATA_ROUTES.includes(normalized)) {
    scope = 'all'
  }

  return { session: { ...session, clinics: freshClinics }, scope, perms }
}

/**
 * Build a Prisma `where` clause filter based on data scope.
 *
 * Usage:
 *   const where: any = { ... }
 *   applyScopeFilter(where, scope, session, { clinicField: 'clinicId', employeeField: 'employeeId' })
 */
export function applyScopeFilter(
  where: any,
  scope: DataScope,
  session: SessionPayload,
  options: { clinicField?: string; employeeField?: string; userId?: string } = {}
): void {
  const clinicField = options.clinicField || 'clinicId'
  const employeeField = options.employeeField || 'employeeId'

  if (scope === 'self') {
    // Employee only sees own data
    if (employeeField) {
      where[employeeField] = session.userId // pass employeeId from caller
    }
  } else if (scope === 'my-clinics' && (session.clinics ?? []).length > 0) {
    // Manager only sees assigned clinics
    where[clinicField] = { in: session.clinics ?? [] }
  }
}

/**
 * Shortcut for routes where employees should see only their own employee profile
 * (when the query uses Employee model, not a direct employeeId field)
 */
export function getEmployeeIdForUser(userId: string): string | null {
  // Caller should have the employee ID; this is a placeholder
  // In practice, pass the employee ID from the resolved employee record
  return userId
}

/**
 * Permission-based auth check.
 * Checks ROLE_DEFAULTS[role] ± grant/deny overrides stored in user.permissionsJson.
 * Also performs tokenVersion + status + KIOSK IP checks (same as requireAuth).
 *
 * Usage in API routes (Route Handler):
 *   const auth = requirePerm(req, permKey)
 *   if (auth.error) return auth.error
 *   const { session, scope } = auth
 */
export async function requirePerm(
  req: NextRequest,
  perm: PermKey
): Promise<AuthResult> {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  // OWNER always has all permissions
  if (session.role === 'OWNER') {
    // Still verify tokenVersion + status
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { tokenVersion: true, status: true, clinics: { select: { clinicId: true } } },
    })
    if (!user || user.status !== 'ACTIVE') {
      return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    }
    if (session.tokenVersion !== undefined && user.tokenVersion !== session.tokenVersion) {
      return { error: NextResponse.json({ error: 'Session invalidated' }, { status: 401 }) }
    }
    // ★ 授權範圍一律以 DB 為準（不要靠 JWT 快照）
    const freshClinics = user.clinics.map(c => c.clinicId)
    return { session: { ...session, clinics: freshClinics }, scope: 'all' }
  }

  // Fetch user for tokenVersion, status, permissionsJson, and clinics
  let grant: string[] = []
  let deny: string[] = []
  let freshClinics: string[] = session.clinics ?? []
  try {
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { tokenVersion: true, status: true, ipAllowlist: true, permissionsJson: true, clinics: { select: { clinicId: true } } },
    })

    if (!user || user.status !== 'ACTIVE') {
      return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    }
    if (session.tokenVersion !== undefined && user.tokenVersion !== session.tokenVersion) {
      return { error: NextResponse.json({ error: 'Session invalidated' }, { status: 401 }) }
    }

    // KIOSK IP enforcement
    if (session.role === 'KIOSK' && user.ipAllowlist) {
      const clientIp = (req.headers.get('cf-connecting-ip')
        || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim())
        || 'unknown'
      const allowedIps = user.ipAllowlist.split(',').map(s => s.trim()).filter(Boolean)
      if (!allowedIps.some(rule => clientIp === rule || clientIp.startsWith(rule))) {
        return { error: NextResponse.json({ error: '此帳號僅限店舖網絡登入' }, { status: 403 }) }
      }
    }

    if (user?.permissionsJson) {
      const parsed = typeof user.permissionsJson === 'string'
        ? JSON.parse(user.permissionsJson) : user.permissionsJson
      grant = (parsed as any).grant || []
      deny = (parsed as any).deny || []
    }
    // ★ 授權範圍一律以 DB 為準。
    //   session.clinics 係登入嗰刻嘅 JWT 快照，經理事後被指派新店唔會反映，
    //   而 session 有 365 日，等於呢個過期快照可以掛足一年。
    freshClinics = user.clinics.map(c => c.clinicId)
  } catch {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  // Check: base role defaults + grant − deny
  const base = ROLE_DEFAULTS[session.role] || []
  const has = base.includes(perm) || grant.includes(perm)
  const denied = deny.includes(perm)

  if (!has || denied) {
    return { error: NextResponse.json({ error: `Forbidden (missing permission: ${perm})` }, { status: 403 }) }
  }

  // Scope: MANAGER → my-clinics; everyone else → self
  let scope: DataScope = 'self'
  if (session.role === 'MANAGER') scope = 'my-clinics'

  // 管理類權限 → 提升到自己管嘅店
  const SCOPE_ELEVATING = ['attendance_manage', 'leave_approve', 'timebank_ops', 'payroll_view', 'payroll_generate']
  if (SCOPE_ELEVATING.includes(perm)) scope = 'my-clinics'

  // ★ 「編更」= 全店權限。
  //   調鋪 / 跨公司借調係日常操作，排班嘅人本來就要睇晒所有店先排得到，
  //   所以 scheduling 一有就係全店，唔按 UserClinic 綁定收窄。
  const SCOPE_ALL = ['scheduling']
  if (SCOPE_ALL.includes(perm)) scope = 'all'

  // ★ 回傳 perms 同 requireAuth 一致（重用上頭嘅 base）
  const perms = [...new Set([...base, ...grant])].filter(p => !deny.includes(p))

  return { session: { ...session, clinics: freshClinics }, scope, perms }
}

/**
 * 多權限檢查（任一持有即過）—— 同一份讀要開俾多類權限持有人。
 * 順序 trial，回第一個過關（scope 跟跟住過關嗰個權限）；401 直接回（換權限 retry 無意義）。
 *
 * ★ 2026-08-22 加入：
 *   - GET /api/providers —— provider_schedule 或 cost_entry（成本錄入揀醫生）
 *   - GET/POST /api/provider-availability(/sync) —— scheduling 或 provider_schedule（店鋪帳號）
 *   注意：requirePerm 唔讀 RBAC_PERM_OVERRIDES，所以 route 層要多權限就必須用呢個。
 */
export async function requireAnyPerm(
  req: NextRequest,
  perms: PermKey[]
): Promise<AuthResult> {
  let last: AuthResult = {
    error: NextResponse.json({ error: 'Forbidden (missing permission)' }, { status: 403 }),
  }
  for (const perm of perms) {
    const r = await requirePerm(req, perm)
    if (!isAuthError(r)) return r
    last = r
    if (r.error.status === 401) return r
  }
  return last
}

/**
 * Role-based auth check for Next.js App Router routes (Server Components / Route Handlers using cookies).
 * Usage: const session = await requireRole(['OWNER', 'MANAGER'])
 * Throws NextResponse on failure.
 */
export async function requireRole(
  allowedRoles: Role[]
): Promise<SessionPayload> {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    throw NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!allowedRoles.includes(session.role)) {
    throw NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return session
}

/**
 * 檢查一筆記錄嘅 clinicId 係咪喺呼叫者權限範圍內。
 * scope==='all' 一律通過；'my-clinics' 對 session.clinics；'self' 一律拒絕。
 * 回傳 null = 通過；回傳 NextResponse = 直接 return 佢。
 */
export function assertClinicAccess(
  scope: 'all' | 'my-clinics' | 'self',
  session: SessionPayload,
  clinicId: string | null | undefined,
): NextResponse | null {
  if (scope === 'all') return null
  if (scope === 'my-clinics' && clinicId && (session.clinics ?? []).includes(clinicId)) return null
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}
