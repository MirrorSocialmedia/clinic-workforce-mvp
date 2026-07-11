import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, type SessionPayload } from './auth'
import { CONFIG, type Role } from './config'

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
 * Verify token + RBAC check + data scope.
 *
 * Usage in API routes:
 *   const auth = requireAuth(req, req.method, req.url)
 *   if (auth.error) return auth.error
 *   const { session, scope } = auth
 */
export function requireAuth(
  req: NextRequest,
  method: string,
  url: string
): AuthResult {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  // RBAC check
  // Add base to support both relative and absolute URLs
  const parsedUrl = new URL(url, 'http://localhost')
  const normalized = normalizeRoute(parsedUrl, method)
  const allowed = CONFIG.RBAC_MATRIX[normalized]

  if (!allowed || !allowed.includes(session.role)) {
    if (!allowed && process.env.NODE_ENV !== 'production') {
      console.error(`⚠️ RBAC MISS: "${normalized}" not in matrix! New API forgot to register?`)
    }
    return { error: NextResponse.json({ error: `Forbidden (route not registered: ${normalized})` }, { status: 403 }) }
  }

  // Data scope
  let scope: DataScope = 'all'
  if (session.role === 'MANAGER') scope = 'my-clinics'
  if (session.role === 'EMPLOYEE') scope = 'self'

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
  } else if (scope === 'my-clinics' && session.clinics.length > 0) {
    // Manager only sees assigned clinics
    where[clinicField] = { in: session.clinics }
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
