import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, type SessionPayload } from './auth'
import { CONFIG, type Role } from './config'
import { cookies } from 'next/headers'
import { type PermKey, ROLE_DEFAULTS } from './permissions'
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
  // Only match actual IDs (cuid/uuid are 20+ chars, or pure numeric)
  // Avoid replacing route names like 'dashboard', 'employees', 'scheduling'
  path = path.replace(/\/[a-z0-9]{20,}/gi, '/:id')
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

  if (!allowed || !allowed.includes(session.role)) {
    if (!allowed && process.env.NODE_ENV !== 'production') {
      console.error(`⚠️ RBAC MISS: "${normalized}" not in matrix! New API forgot to register?`)
    }
    return { error: NextResponse.json({ error: `Forbidden (route not registered: ${normalized})` }, { status: 403 }) }
  }

  // tokenVersion + KIOSK IP + status check (single DB query)
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { tokenVersion: true, status: true, ipAllowlist: true },
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

  // Data scope
  let scope: DataScope = 'all'
  if (session.role === 'MANAGER') scope = 'my-clinics'
  if (session.role === 'EMPLOYEE' || session.role === 'KIOSK') scope = 'self'

  return { session, scope }
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
      select: { tokenVersion: true, status: true },
    })
    if (!user || user.status !== 'ACTIVE') {
      return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    }
    if (session.tokenVersion !== undefined && user.tokenVersion !== session.tokenVersion) {
      return { error: NextResponse.json({ error: 'Session invalidated' }, { status: 401 }) }
    }
    return { session, scope: 'all' }
  }

  // Fetch user for tokenVersion, status, and permissionsJson
  let grant: string[] = []
  let deny: string[] = []
  try {
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { tokenVersion: true, status: true, ipAllowlist: true, permissionsJson: true },
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
  // ★ Management-class permissions elevate scope to my-clinics
  let scope: DataScope = 'self'
  if (session.role === 'MANAGER') scope = 'my-clinics'
  const SCOPE_ELEVATING = ['scheduling', 'attendance_manage', 'leave_approve', 'timebank_ops', 'payroll_view', 'payroll_generate']
  if (SCOPE_ELEVATING.includes(perm)) scope = 'my-clinics'

  return { session, scope }
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
