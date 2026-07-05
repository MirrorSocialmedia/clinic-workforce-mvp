import { CONFIG, type Role } from './config'

export function requireRole(...allowedRoles: Role[]): (role: Role) => boolean {
  return (role: Role) => allowedRoles.includes(role)
}

// Check if a role has access to a given route
export function hasRouteAccess(role: Role, method: string, path: string): boolean {
  const key = `${method} ${path}` as keyof typeof CONFIG.RBAC_MATRIX
  const allowed = CONFIG.RBAC_MATRIX[key]
  if (!allowed) {
    // Check with :id pattern
    const patternPath = path.replace(/\/[a-zA-Z0-9_-]+$/, '/:id')
    const patternKey = `${method} ${patternPath}` as keyof typeof CONFIG.RBAC_MATRIX
    const patternAllowed = CONFIG.RBAC_MATRIX[patternKey]
    return patternAllowed ? patternAllowed.some(r => r === role) : false
  }
  return allowed.some(r => r === role)
}

// Check if a role can access a specific clinic
// OWNER sees all, others only see their assigned clinics
export function hasClinicAccess(role: Role, clinicId: string, userClinics: string[]): boolean {
  if (CONFIG.UNRESTRICTED_ROLES.includes(role as any)) return true
  return userClinics.includes(clinicId)
}

// Filter clinics based on role
export function filterClinicsByRole(clinics: { id: string }[], role: Role, userClinics: string[]): { id: string }[] {
  if (CONFIG.UNRESTRICTED_ROLES.includes(role as any)) return clinics
  return clinics.filter(c => userClinics.includes(c.id))
}
