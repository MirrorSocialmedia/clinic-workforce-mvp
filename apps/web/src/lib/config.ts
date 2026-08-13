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
    'GET /api/audit-logs/sensitive-summary': ['OWNER'],

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
    'GET /api/employees/:id/overview/attendance-days': ['OWNER', 'MANAGER'],

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

    // ★ 2026-08-08 更表完整性檢查（餵排班頁 coverage 對數 — 同 GET /api/shifts 同受眾）
    'GET /api/schedule-coverage': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // ★ 醫生當值排更（加 KIOSK）
    'GET /api/providers': ['OWNER', 'MANAGER', 'KIOSK'],
    'POST /api/providers': ['OWNER', 'MANAGER'],
    'PUT /api/providers/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/providers/:id': ['OWNER', 'MANAGER'],
    'GET /api/provider-shifts': ['OWNER', 'MANAGER', 'KIOSK'],
    'POST /api/provider-shifts/batch': ['OWNER', 'MANAGER', 'KIOSK'],
    'DELETE /api/provider-shifts/:id': ['OWNER', 'MANAGER', 'KIOSK'],
    // ★ 醫生休假（同 provider_schedule 權限範圍）
    'GET /api/provider-leaves': ['OWNER', 'MANAGER'],
    'POST /api/provider-leaves': ['OWNER', 'MANAGER'],
    'DELETE /api/provider-leaves/:id': ['OWNER', 'MANAGER'],
    // ★ 醫生拆帳（OWNER only）
    'GET /api/provider-commissions': ['OWNER'],
    'POST /api/provider-commissions': ['OWNER'],

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
    'GET /api/payroll-runs/allowed-clinics': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // Account management routes
    'GET /api/accounts': ['OWNER'],
    'POST /api/accounts': ['OWNER'],
    'GET /api/accounts/:id': ['OWNER'],
    'PUT /api/accounts/:id': ['OWNER'],
    'DELETE /api/accounts/:id': ['OWNER'],
    'GET /api/accounts/:id/purge-preview': ['OWNER'],
    'POST /api/accounts/:id/purge': ['OWNER'],

    // Time-bank routes
    'GET /api/time-bank': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/time-bank': ['OWNER'],

    // Timebank entry routes
    'POST /api/timebank/makeup': ['OWNER', 'MANAGER'],
    'POST /api/timebank/convert': ['OWNER', 'MANAGER'],
    'POST /api/timebank/init-adjust': ['OWNER'],
    'POST /api/timebank/absent-deduct': ['OWNER', 'MANAGER'],
    'POST /api/timebank/absent-deduct/cancel': ['OWNER', 'MANAGER'],
    'POST /api/timebank/early-in-ot': ['OWNER', 'MANAGER'],
    'POST /api/timebank/early-in-ot/cancel': ['OWNER', 'MANAGER'],
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
    'POST /api/face/mask-check': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Admin migration routes
    'POST /api/admin/migrate-shift-templates': ['OWNER'],

    // Expense entries routes
    'GET /api/expense-entries': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'POST /api/expense-entries': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'DELETE /api/expense-entries/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PATCH /api/expense-entries/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // 員工自助雜項申請
    'POST /api/my/expense-entries': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'GET /api/my/expense-entries': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'DELETE /api/my/expense-entries/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

    // Wage history routes (ADW compliance)
    'GET /api/wage-history': ['OWNER', 'ACCOUNTANT'],
    'POST /api/wage-history': ['OWNER'],
    'PUT /api/wage-history/:id': ['OWNER'],
    'DELETE /api/wage-history/:id': ['OWNER'],

    // ADW preview
    'GET /api/adw/preview': ['OWNER', 'ACCOUNTANT'],

    // ★ 2026-08-04: 排班每日備註
    'GET /api/schedule-notes': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'PUT /api/schedule-notes': ['OWNER', 'MANAGER'],

    // ★ MD-B: Cost Entry — 成本錄入（Lab / Implant / Invisalign）
    'GET /api/cost-cases': ['OWNER', 'MANAGER'],
    'POST /api/cost-cases': ['OWNER', 'MANAGER'],
    'POST /api/cost-cases/implant': ['OWNER', 'MANAGER'],
    'PUT /api/cost-cases/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/cost-cases/:id': ['OWNER', 'MANAGER'],
    'POST /api/cost-cases/recompute': ['OWNER'],
    // Lab 主檔
    'GET /api/labs': ['OWNER', 'MANAGER'],
    'POST /api/labs': ['OWNER'],
    'PUT /api/labs/:id': ['OWNER'],
    // Lab 月度折扣
    'GET /api/lab-discounts': ['OWNER', 'MANAGER'],
    'POST /api/lab-discounts': ['OWNER'],
    // ★ MD-C: Apricot Payment / Bill Sync
    'POST /api/apricot/sync': ['OWNER'],
    'POST /api/apricot/sync/cron': ['OWNER'], // ★ cron 專用，實際用 x-cron-key 認證
    'GET /api/apricot/status': ['OWNER', 'MANAGER'],
    'GET /api/payment-method-rules': ['OWNER', 'MANAGER'],
    'POST /api/payment-method-rules': ['OWNER'],

    // 材料主檔
    'GET /api/material-items': ['OWNER', 'MANAGER'],
    'POST /api/material-items': ['OWNER'],
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
  // ★ 排班主管要睇住時間帳戶結餘去編更（2026-08-09）
  'GET /api/timebank/overview': ['scheduling'],
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
  'GET /api/employees/:id/overview/attendance-days': ['employee_overview'],
  'GET /api/employees': ['employee_overview', 'payroll_view', 'payroll_generate'],

  // ★ 2026-08-03：計糧相關 —— 側欄已開放畀有權限嘅 EMPLOYEE，
  //   API 層要跟，否則入口開咗但 403（第六次撞呢個模式）
  'GET /api/payroll-runs': ['payroll_view', 'payroll_generate'],
  'GET /api/payroll-runs/:id': ['payroll_view', 'payroll_generate'],
  'GET /api/payroll-runs/:id/employee/:id': ['payroll_view', 'payroll_generate'],
  'POST /api/payroll-runs/:id/export': ['payroll_view', 'payroll_generate'],
  'GET /api/payroll-runs/exceptions': ['payroll_view', 'payroll_generate', 'attendance_manage'],
  'POST /api/payroll-runs/preview': ['payroll_view', 'payroll_generate'],
  // ★ 生成／預檢限 payroll_generate（淨係 payroll_view 唔夠）
  'POST /api/payroll-runs': ['payroll_generate'],
  'GET /api/payroll-runs/:id/preflight': ['payroll_generate'],

  // ★ 診所範圍 — 計糧生成用獨立 route，同 POST /api/payroll-runs 同一範圍
  'GET /api/payroll-runs/allowed-clinics': ['payroll_generate'],

  // ★ 考勤補登
  'POST /api/punch-corrections': ['attendance_manage'],

  // ★ 考勤（2026-08-03）—— 範圍全公司，因為調鋪員工會喺其他店出現
  'GET /api/punches': ['attendance_manage'],
  'GET /api/punches/:id': ['attendance_manage'],
  'PUT /api/punch-corrections/:id': ['attendance_manage'],

  // ★ 2026-08-04: 排班每日備註 —— 有 scheduling 權限可讀/寫
  'GET /api/schedule-notes': ['scheduling'],
  'PUT /api/schedule-notes': ['scheduling'],

  // —— 醫生當值排更 ——
  // ⚠️ 呢啲 route 用 requirePerm，requirePerm 唔讀本表。
  // 留喺度純粹係 check-rbac-matrix.sh 嘅登記要求 + 文件用途。
  // 真正把關喺 ROLE_DEFAULTS[role] 同埋各 route 自己嘅 resolveProviderScheduleScope。
  'GET /api/providers': ['provider_schedule', 'scheduling'],
  'POST /api/providers': ['provider_schedule', 'scheduling'],
  'PUT /api/providers/:id': ['provider_schedule', 'scheduling'],
  'DELETE /api/providers/:id': ['provider_schedule', 'scheduling'],
  'GET /api/provider-shifts': ['provider_schedule', 'scheduling'],
  'POST /api/provider-shifts/batch': ['provider_schedule', 'scheduling'],
  'DELETE /api/provider-shifts/:id': ['provider_schedule', 'scheduling'],

  // —— 醫生休假 ——
  'GET /api/provider-leaves': ['provider_schedule'],
  'POST /api/provider-leaves': ['provider_schedule'],
  'DELETE /api/provider-leaves/:id': ['provider_schedule'],

  // —— 醫生拆帳 —— OWNER only（MANAGER 冇權睇醫生收入）
  'GET /api/provider-commissions': ['provider_payout'],
  'POST /api/provider-commissions': ['provider_payout'],

  // —— MD-B: Cost Entry ——
  //   cost_entry 權限：MANAGER 可以錄入成本
  'GET /api/cost-cases': ['cost_entry'],
  'POST /api/cost-cases': ['cost_entry'],
  'POST /api/cost-cases/implant': ['cost_entry'],
  'PUT /api/cost-cases/:id': ['cost_entry'],
  'DELETE /api/cost-cases/:id': ['cost_entry'],
  //   provider_payout 權限：折扣設定 / 材料單價（只 OWNER）
  'POST /api/cost-cases/recompute': ['provider_payout'],
  'POST /api/labs': ['provider_payout'],
  'PUT /api/labs/:id': ['provider_payout'],
  'POST /api/lab-discounts': ['provider_payout'],
  'POST /api/material-items': ['provider_payout'],

  // —— MD-C: Apricot Data Layer ——
  'POST /api/apricot/sync': ['provider_payout'],
  'GET /api/apricot/status': ['provider_payout'],
  'GET /api/payment-method-rules': ['provider_payout'],
  'POST /api/payment-method-rules': ['provider_payout'],
}

export type Role = typeof CONFIG.ROLES[keyof typeof CONFIG.ROLES]
