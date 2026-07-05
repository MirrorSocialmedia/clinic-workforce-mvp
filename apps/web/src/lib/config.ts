// Config — all tunable parameters, nothing hardcoded
export const CONFIG = {
  // Clinic count (seed data)
  DEMO_CLINIC_COUNT: 6,

  // Session
  SESSION_MAX_AGE_DAYS: 30,
  JWT_SECRET: process.env.JWT_SECRET || 'clinic-mvp-dev-secret',

  // Roles
  ROLES: {
    OWNER: 'OWNER',
    MANAGER: 'MANAGER',
    ACCOUNTANT: 'ACCOUNTANT',
    EMPLOYEE: 'EMPLOYEE',
  } as const,

  // RBAC Matrix: role → allowed routes per method
  RBAC_MATRIX: {
    // Auth routes (all authenticated users)
    'POST /api/auth/logout': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Self routes
    'GET /api/me': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Clinic routes
    'GET /api/clinics': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/clinics': ['OWNER'],
    'PUT /api/clinics/:id': ['OWNER'],
    'DELETE /api/clinics/:id': ['OWNER'],

    // User routes
    'GET /api/users': ['OWNER'],
    'POST /api/users': ['OWNER'],
    'PUT /api/users/:id': ['OWNER'],

    // Audit log routes (read-only)
    'GET /api/audit-logs': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // Dashboard
    'GET /api/dashboard': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Employee routes
    'GET /api/employees': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/employees': ['OWNER', 'MANAGER'],
    'PUT /api/employees/:id': ['OWNER', 'MANAGER'],
    'GET /api/employees/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/employees/:id/pay-rules': ['OWNER'],
    'POST /api/employees/import': ['OWNER'],
    'GET /api/employees/:id/pay-history': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
  } as Record<string, string[]>,

  // Roles that can view all clinics (no data isolation)
  UNRESTRICTED_ROLES: ['OWNER'],

  // Default demo password
  DEMO_PASSWORD: 'demo1234',
}

export type Role = typeof CONFIG.ROLES[keyof typeof CONFIG.ROLES]
