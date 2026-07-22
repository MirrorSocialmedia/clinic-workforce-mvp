import jwt from 'jsonwebtoken'
import { CONFIG, type Role } from './config'

export interface SessionPayload {
  userId: string
  role: Role
  clinics: string[] // clinic IDs this user has access to
  primaryClinicId?: string
  tokenVersion?: number
  iat: number
  exp: number
}

export function createToken(payload: Omit<SessionPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, CONFIG.JWT_SECRET, {
    expiresIn: `${CONFIG.SESSION_MAX_AGE_DAYS}d`,
  })
}

export function verifyToken(token: string): SessionPayload | null {
  try {
    const payload = jwt.verify(token, CONFIG.JWT_SECRET) as SessionPayload
    // ★ Normalize: old tokens may lack `clinics` (added after initial rollout)
    // Guarantees all downstream code gets a valid array, never undefined
    return {
      ...payload,
      clinics: Array.isArray(payload.clinics) ? payload.clinics : [],
    }
  } catch {
    return null
  }
}
