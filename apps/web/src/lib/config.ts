// Config — all tunable parameters, nothing hardcoded
export const CONFIG = {
  // Clinic count (seed data)
  DEMO_CLINIC_COUNT: 6,

  // Session
  SESSION_MAX_AGE_DAYS: 365,
  JWT_SECRET: (() => {
    const s = process.env.JWT_SECRET
    if (!s || s.length < 32) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET must be set (>=32 chars) in production')
      }
      return 'dev-only-secret-do-not-use-in-prod-2024'
    }
    return s
  })(),

  // Data retention (PDPO compliance)
  DATA_RETENTION_DAYS: parseInt(process.env.DATA_RETENTION_DAYS || '365', 10),

  // Roles
  ROLES: {
    OWNER: 'OWNER',
    MANAGER: 'MANAGER',
    ACCOUNTANT: 'ACCOUNTANT',
    EMPLOYEE: 'EMPLOYEE',
    KIOSK: 'KIOSK',
  } as const,

  // RBAC Matrix: role → allowed routes per method
  RBAC_MATRIX: {
    // Auth routes (all authenticated users)
    'POST /api/auth/logout': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Self routes
    'GET /api/me': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE', 'KIOSK'],

    // Company routes
    'GET /api/companies': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/companies': ['OWNER'],
    'PUT /api/companies/:id': ['OWNER'],
    'DELETE /api/companies/:id': ['OWNER'],

    // Clinic routes
    'GET /api/clinics': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE', 'KIOSK'],
    'GET /api/clinics/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/clinics': ['OWNER'],
    'PUT /api/clinics/:id': ['OWNER'],
    'DELETE /api/clinics/:id': ['OWNER'],

    // User routes
    'GET /api/users': ['OWNER'],
    'POST /api/users': ['OWNER'],
    'PUT /api/users/:id': ['OWNER'],
    'DELETE /api/users/:id': ['OWNER'],

    // Audit log routes (OWNER only)
    'GET /api/audit-logs': ['OWNER'],

    // Dashboard
    'GET /api/dashboard': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Employee routes
    'GET /api/employees': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/employees': ['OWNER', 'MANAGER'],
    'PUT /api/employees/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/employees/:id': ['OWNER'],
    'GET /api/employees/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/employees/:id/pay-rules': ['OWNER'],
    'GET /api/employees/:id/pay-rules': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PUT /api/employees/:id/pay-rules/:id': ['OWNER'],
    'POST /api/employees/import': ['OWNER'],
    'GET /api/employees/:id/pay-history': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // Resign / Rehire routes
    'GET /api/employees/:id/resign-preview': ['OWNER'],
    'POST /api/employees/:id/resign': ['OWNER'],
    'POST /api/employees/:id/rehire': ['OWNER'],

    // Shift rule config routes
    'GET /api/clinics/:id/shift-rule-config': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PUT /api/clinics/:id/shift-rule-config': ['OWNER', 'MANAGER'],

    // Shift routes
    'GET /api/shifts': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/shifts': ['OWNER', 'MANAGER'],
    'PUT /api/shifts/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/shifts/:id': ['OWNER', 'MANAGER'],
    'POST /api/shifts/validate': ['OWNER', 'MANAGER'],
    'GET /api/shifts/templates': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/shifts/templates': ['OWNER'],
    'PUT /api/shifts/templates/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/shifts/templates/:id': ['OWNER'],
    'GET /api/shifts/my-schedule': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Shift change request routes
    'GET /api/shift-changes': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/shift-changes': ['OWNER', 'MANAGER', 'EMPLOYEE'],
    'PUT /api/shift-changes/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/shift-changes/:id': ['OWNER', 'MANAGER', 'EMPLOYEE'],

    // Punch / attendance routes
    'POST /api/punch': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'GET /api/punches': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'GET /api/punches/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PUT /api/punches/:id': ['OWNER', 'MANAGER'],
    'POST /api/punches/:id/void': ['OWNER', 'MANAGER'],
    'GET /api/punch/my-records': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Punch correction routes
    'POST /api/punch-corrections': ['OWNER', 'MANAGER', 'EMPLOYEE'],
    'GET /api/punch-corrections': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'PUT /api/punch-corrections/:id': ['OWNER', 'MANAGER'],

    // QR token routes
    'GET /api/qr-tokens': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE', 'KIOSK'],

    // Daily hash routes
    'POST /api/daily-hash': ['OWNER', 'MANAGER'],
    'GET /api/daily-hash': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'GET /api/daily-hash/:date': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // Leave type routes
    'GET /api/leave-types': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/leave-types': ['OWNER'],
    'PUT /api/leave-types/:id': ['OWNER'],
    'DELETE /api/leave-types/:id': ['OWNER'],

    // Leave request routes
    'POST /api/leave-requests': ['OWNER', 'MANAGER', 'EMPLOYEE'],
    'GET /api/leave-requests': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'PUT /api/leave-requests/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/leave-requests/:id': ['OWNER', 'MANAGER'],
    'PATCH /api/leave-requests/:id': ['OWNER', 'MANAGER'],

    // Leave balance routes
    'GET /api/leave-balance': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/leave-balance/init': ['OWNER', 'MANAGER'],
    'DELETE /api/leave-balance': ['OWNER'],
    'PATCH /api/leave-balance': ['OWNER', 'MANAGER'],
    'POST /api/leave/grant-restdays': ['OWNER'],

    // HK public holiday routes
    'GET /api/hk-public-holidays': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Employee self-service routes
    'GET /api/my/schedule': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'GET /api/my/punches': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'GET /api/my/leave': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'GET /api/my/summary': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'GET /api/my/company-overview': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Notification routes
    'GET /api/notifications': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'PUT /api/notifications/:id/read': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/notifications/read-all': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Payroll routes
    'GET /api/payroll-runs': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/payroll-runs': ['OWNER', 'MANAGER'],
    'GET /api/payroll-runs/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PUT /api/payroll-runs/:id': ['OWNER'],
    'DELETE /api/payroll-runs/:id': ['OWNER'],
    'POST /api/payroll-runs/:id/export': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/payroll-runs/preview': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'GET /api/payroll-runs/:id/employee/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'GET /api/payroll-runs/exceptions': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // Account management routes
    'GET /api/accounts': ['OWNER'],
    'POST /api/accounts': ['OWNER'],
    'GET /api/accounts/:id': ['OWNER'],
    'PUT /api/accounts/:id': ['OWNER'],
    'DELETE /api/accounts/:id': ['OWNER'],

    // Time-bank routes
    'GET /api/time-bank': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/time-bank': ['OWNER'],

    // Timebank entry routes
    'POST /api/timebank/makeup': ['OWNER'],
    'POST /api/timebank/convert': ['OWNER', 'MANAGER'],
    'POST /api/timebank/init-adjust': ['OWNER'],
    'POST /api/timebank/absent-deduct': ['OWNER', 'MANAGER'],
    'POST /api/timebank/absent-deduct/cancel': ['OWNER', 'MANAGER'],
    'GET /api/time-bank/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PATCH /api/time-bank/:id': ['OWNER'],
    'DELETE /api/time-bank/:id': ['OWNER'],

    // My timebank
    'GET /api/my/timebank': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Leave balance refresh
    'POST /api/leave-balance/refresh': ['OWNER', 'MANAGER'],


    // Consultation revenue routes
    'GET /api/consultation-revenue': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/consultation-revenue': ['OWNER'],

    // Face verification routes (shadow mode)
    'POST /api/face/enroll-code': ['OWNER', 'MANAGER'],
    'POST /api/face/enroll-code/check': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/face/enroll': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/face/verify-punch': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'GET /api/face/review': ['OWNER', 'MANAGER'],
    'GET /api/face/review/:id': ['OWNER', 'MANAGER'],
    'POST /api/face/review/:id': ['OWNER', 'MANAGER'],

    // Face enrollment approval routes
    'GET /api/face/enroll-pending': ['OWNER', 'MANAGER'],
    'GET /api/face/enroll-ref/:id': ['OWNER', 'MANAGER'],
    'POST /api/face/enroll-approve/:id': ['OWNER', 'MANAGER'],

    // Face enrollment status (self)
    'GET /api/face/my-status': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Admin migration routes
    'POST /api/admin/migrate-shift-templates': ['OWNER'],
  } as Record<string, string[]>,

  // Roles that can view all clinics (no data isolation)
  UNRESTRICTED_ROLES: ['OWNER'],

  // Default demo password
  DEMO_PASSWORD: 'demo1234',
}

export type Role = typeof CONFIG.ROLES[keyof typeof CONFIG.ROLES]
