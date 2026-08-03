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
    'POST /api/auth/change-password': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

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
    'GET /api/employees': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/employees': ['OWNER', 'MANAGER'],
    'PUT /api/employees/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/employees/:id': ['OWNER'],
    'GET /api/employees/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/employees/:id/pay-rules': ['OWNER'],
    'GET /api/employees/:id/pay-rules': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PUT /api/employees/:id/pay-rules/:id': ['OWNER'],
    'POST /api/employees/import': ['OWNER'],
    'GET /api/employees/:id/pay-history': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    // ★ 2026-08-03：員工總覽限 OWNER + MANAGER（同側欄一致）——
    //   ACCOUNTANT 只需要計糧，唔需要員工完整資料（含假期、考勤、時間帳戶）
    'GET /api/employees/:id/overview': ['OWNER', 'MANAGER'],
    'GET /api/employees/:id/overview/history': ['OWNER', 'MANAGER'],

    // Resign / Rehire routes
    'GET /api/employees/:id/resign-preview': ['OWNER'],
    'POST /api/employees/:id/resign': ['OWNER'],
    'POST /api/employees/:id/rehire': ['OWNER'],

    // Shift rule config routes
    'GET /api/clinics/:id/shift-rule-config': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PUT /api/clinics/:id/shift-rule-config': ['OWNER', 'MANAGER'],

    // Shift routes (EMPLOYEE included — requirePerm enforces scheduling permission)
    'GET /api/shifts': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'POST /api/shifts': ['OWNER', 'MANAGER', 'EMPLOYEE'],
    'PUT /api/shifts/:id': ['OWNER', 'MANAGER', 'EMPLOYEE'],
    'DELETE /api/shifts/:id': ['OWNER', 'MANAGER', 'EMPLOYEE'],
    'POST /api/shifts/validate': ['OWNER', 'MANAGER', 'EMPLOYEE'],
    'GET /api/shifts/templates': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    // ⚠️ 以下三條係死 key —— 對應 route 行 requirePerm('scheduling')，唔會查呢個矩陣。
    //    保留只為文件性質，改呢度唔會有任何效果。
    'POST /api/shifts/templates': ['OWNER', 'MANAGER'],
    'PUT /api/shifts/templates/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/shifts/templates/:id': ['OWNER', 'MANAGER'],
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
    'POST /api/leave/grant-restdays': ['OWNER', 'EMPLOYEE'],

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
    'GET /api/payroll-runs/:id/preflight': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
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
    'POST /api/timebank/makeup': ['OWNER', 'MANAGER'],
    'POST /api/timebank/convert': ['OWNER', 'MANAGER'],
    'POST /api/timebank/init-adjust': ['OWNER'],
    'POST /api/timebank/absent-deduct': ['OWNER', 'MANAGER'],
    'POST /api/timebank/absent-deduct/cancel': ['OWNER', 'MANAGER'],
    'GET /api/time-bank/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PATCH /api/time-bank/:id': ['OWNER'],
    'DELETE /api/time-bank/:id': ['OWNER'],

    // Timebank overview (dedicated — all active monthly employees)
    'GET /api/timebank/overview': ['OWNER', 'MANAGER'],

    // My timebank
    'GET /api/my/timebank': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Leave balance refresh
    'POST /api/leave-balance/refresh': ['OWNER', 'MANAGER'],

    // Leave settlement (resignation)
    'POST /api/leave-settlement': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

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

    // Expense entries routes
    'GET /api/expense-entries': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/expense-entries': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'DELETE /api/expense-entries/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // Wage history routes (ADW compliance)
    'GET /api/wage-history': ['OWNER', 'ACCOUNTANT'],
    'POST /api/wage-history': ['OWNER'],
    'PUT /api/wage-history/:id': ['OWNER'],
    'DELETE /api/wage-history/:id': ['OWNER'],

    // ADW preview
    'GET /api/adw/preview': ['OWNER', 'ACCOUNTANT'],
  } as Record<string, string[]>,

  // Roles that can view all clinics (no data isolation)
  UNRESTRICTED_ROLES: ['OWNER'],

  // Face service
  FACE_SERVICE_URL: process.env.FACE_SERVICE_URL || 'http://face:8000',
  // 打卡驗證：單幀，要快 fail 唔好阻住打卡
  FACE_TIMEOUT_MS: parseInt(process.env.FACE_TIMEOUT_MS || '5000', 10),
  // ★ 登記 embedding：3+ 幀 × InsightFace CPU inference，5 秒必然唔夠
  FACE_EMBED_TIMEOUT_MS: parseInt(process.env.FACE_EMBED_TIMEOUT_MS || '45000', 10),

  // Default demo password
  DEMO_PASSWORD: 'demo1234',
}

/**
 * ★ 權限覆蓋：除咗角色白名單，持有以下權限嘅人一樣可以存取。
 *
 * 背景：系統有兩套授權機制並存 —— requirePerm（識權限）同角色矩陣（只識 role）。
 * 排班功能橫跨兩者，所以純角色白名單會擋住「EMPLOYEE + scheduling 權限」呢種組合。
 * 呢個 map 係過渡橋樑，等唔使一次過把 80+ 條 route 全部改寫成 requirePerm。
 *
 * key 格式同 RBAC_MATRIX 完全一致（動態段一律 :id / :date）。
 */
export const RBAC_PERM_OVERRIDES: Record<string, string[]> = {
  // —— 排班：有 scheduling 權限就等同全排班權 ——
  'GET /api/shift-changes': ['scheduling'],
  'PUT /api/shift-changes/:id': ['scheduling'],
  'DELETE /api/shift-changes/:id': ['scheduling'],
  'GET /api/clinics/:id': ['scheduling'],
  'GET /api/clinics/:id/shift-rule-config': ['scheduling'],
  'PUT /api/clinics/:id/shift-rule-config': ['scheduling'],

  // —— 離職結算：有 leave_approve 或 payroll_generate 權限可以觸發 ——
  'POST /api/leave-settlement': ['leave_approve', 'payroll_generate'],

  // —— 發放休息日：有 scheduling 權限就可以發放（grant-restdays route 改用 scheduling 權限） ——
  'POST /api/leave/grant-restdays': ['scheduling'],

  // —— 假期修改：有 scheduling 或 leave_approve 權限可以修改/刪除假期 ——
  'PUT /api/leave-requests/:id': ['scheduling', 'leave_approve'],
  'DELETE /api/leave-requests/:id': ['scheduling', 'leave_approve'],
  'PATCH /api/leave-requests/:id': ['scheduling', 'leave_approve'],

  // —— 假期額度管理：有 leave_approve 權限可以更新/初始化假期餘額 ——
  'PATCH /api/leave-balance': ['leave_approve'],
  'POST /api/leave-balance/init': ['leave_approve'],

  // —— 員工總覽：有 employee_overview 權限可以查看員工總覽（限主屬診所） ——
  'GET /api/employees/:id/overview': ['employee_overview'],
  'GET /api/employees/:id/overview/history': ['employee_overview'],
  'GET /api/employees': ['employee_overview', 'payroll_view', 'payroll_generate'],

  // ★ 2026-08-03：計糧相關 —— 側欄已開放畀有權限嘅 EMPLOYEE，
  //   API 層要跟，否則入口開咗但 403（第六次撞呢個模式）
  'GET /api/payroll-runs': ['payroll_view', 'payroll_generate'],
  'GET /api/payroll-runs/:id': ['payroll_view', 'payroll_generate'],
  'GET /api/payroll-runs/:id/employee/:id': ['payroll_view', 'payroll_generate'],
  'POST /api/payroll-runs/:id/export': ['payroll_view', 'payroll_generate'],
  'GET /api/payroll-runs/exceptions': ['payroll_view', 'payroll_generate'],
  'POST /api/payroll-runs/preview': ['payroll_view', 'payroll_generate'],
  // ★ 生成／預檢限 payroll_generate（淨係 payroll_view 唔夠）
  'POST /api/payroll-runs': ['payroll_generate'],
  'GET /api/payroll-runs/:id/preflight': ['payroll_generate'],

  // ★ 考勤補登
  'POST /api/punch-corrections': ['attendance_manage'],
}

export type Role = typeof CONFIG.ROLES[keyof typeof CONFIG.ROLES]
