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
    'GET /api/dashboard/labour-cost': ['OWNER'],   // ★ cwm-ownerdash：唔准加 RBAC_PERM_OVERRIDES

    // Employee routes
    'GET /api/employees': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    // ★ 2026-08-22：成本錄入「負責同事」picker 輕量 route（淨返 id + user.name；
    //   主權限喺 RBAC_PERM_OVERRIDES = cost_entry，唔返薪酬/電話/電郵）
    'GET /api/employees/dsa-options': ['OWNER'],
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
    'GET /api/employees/:id/timebank-ledger': ['OWNER', 'MANAGER'],

    // Resign / Rehire routes
    // ★ 2026-09-04 [cwm-resigpay-20260904] 拍板 B：MANAGER 睇得到預覽（寫入 resign-settle 仍 OWNER-only）
    'GET /api/employees/:id/resign-preview': ['OWNER', 'MANAGER'],
    'POST /api/employees/:id/resign': ['OWNER'],
    // ★ 2026-09-04 [cwm-rbacfix-20260904] resign-settle 補登記（deploy blocker）
    'POST /api/employees/:id/resign-settle': ['OWNER'],
    // ★ 2026-09-30 [cwm-restdebt] F6：撤銷離職結算（RS-10 配套出路）
    'DELETE /api/employees/:id/resign-settle': ['OWNER'],
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

    // ★ 2026-08-15 應返工時（排班主管 + 會計需查看月薪員工編班工時）
    'GET /api/roster-hours': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // ★ 醫生當值排更（加 KIOSK）
    'GET /api/providers': ['OWNER', 'MANAGER', 'KIOSK'],
    'POST /api/providers': ['OWNER', 'MANAGER'],
    'PUT /api/providers/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/providers/:id': ['OWNER', 'MANAGER'],
    'GET /api/provider-shifts': ['OWNER', 'MANAGER', 'KIOSK'],
    'POST /api/provider-shifts/batch': ['OWNER', 'MANAGER', 'KIOSK'],
    'DELETE /api/provider-shifts/:id': ['OWNER', 'MANAGER', 'KIOSK'],
    // ★ cwm-provroster S1-2：改單條例外（原地 update）—— 同 DELETE 同一組角色（KIOSK 維持現狀可改本週例外）
    'PATCH /api/provider-shifts/:id': ['OWNER', 'MANAGER', 'KIOSK'],
    // ★ 每週固定 pattern（cw-patwl）：KIOSK 只准 GET（打卡屏唔應該改當值表）
    'GET /api/provider-patterns': ['OWNER', 'MANAGER', 'KIOSK'],
    'PUT /api/provider-patterns': ['OWNER', 'MANAGER'],
    // ★ 醫生休假（同 provider_schedule 權限範圍）
    'GET /api/provider-leaves': ['OWNER', 'MANAGER'],
    'POST /api/provider-leaves': ['OWNER', 'MANAGER'],
    'DELETE /api/provider-leaves/:id': ['OWNER', 'MANAGER'],
    'PATCH /api/provider-leaves/:id': ['OWNER', 'MANAGER'], // ★ cwm-provroster S1-3
    // ★ 醫生拆帳（OWNER only）
    'GET /api/provider-commissions': ['OWNER'],
    'POST /api/provider-commissions': ['OWNER'],
    // ★ 收費項目標準價
    'GET /api/fee-item-list-prices': ['OWNER'],
    'POST /api/fee-item-list-prices': ['OWNER'],
    'PATCH /api/fee-item-list-prices/:id': ['OWNER'],
    'DELETE /api/fee-item-list-prices/:id': ['OWNER'],

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
    'POST /api/punch/client-error': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'], // ★ 2026-09-30 C5
    // ★ cwm-crossclinic-20260914：異地打卡提醒（純查詢）。★ 唔加 ACCOUNTANT —— 佢哋唔改排班。
    'GET /api/attendance/cross-clinic': ['OWNER', 'MANAGER'],

    // Punch correction routes
    'POST /api/punch-corrections': ['OWNER', 'MANAGER', 'EMPLOYEE'],
    'GET /api/punch-corrections': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
    'PUT /api/punch-corrections/:id': ['OWNER', 'MANAGER'],

    // QR token routes
    // ★ cwm-antitamper-20260917：員工／會計唔准自己發 QR（否則可喺屋企打卡）
    'GET /api/qr-tokens': ['OWNER', 'MANAGER', 'KIOSK'],

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
    // ★ PL 標記（2026-08-21）：員工自請休息日，純顯示 —— 另有 RBAC_PERM_OVERRIDES 開 scheduling 權限
    'PATCH /api/leave-requests/:id/pl-mark': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

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
    // ★ cwm-payrollcols-20260918 C：員工睇自己嘅逐月帳本（route 內 session.userId 反查，唔收 param）
    'GET /api/my/timebank-ledger': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],
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
    'POST /api/payroll-runs/bulk-export-audit': ['OWNER', 'MANAGER', 'ACCOUNTANT'], // ★ cwm-bulkpayslip-20261003
    'POST /api/payroll-runs/preview': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'GET /api/payroll-runs/:id/employee/:id': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    // ★ cwm-payrollsheet-20260921 S3：支票號填寫（出糧後人手填；純記錄）
    'PATCH /api/payroll-runs/:id/employee/:id': ['OWNER'],
    'POST /api/payroll-runs/:id/employee/:id': ['OWNER', 'MANAGER'], // ★ cwm-payrollsingle-20261003：草稿單個員工重算
    'DELETE /api/payroll-runs/:id/employee/:id': ['OWNER', 'MANAGER'], // ★ cwm-payrollsingle-20261003：草稿單個員工移除
    // ★ cwm-payrollsheet-20260921 S4：月度出糧總表（保密過濾同 export 同一把尺）
    'GET /api/payroll-runs/cheque-sheet': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    // ★ cwm-chequetpl-20261004：出糧總表自訂模版／出糧診所 —— 老闆拍板「只俾老闆用」，★★★ 唔加 RBAC_PERM_OVERRIDES
    'GET /api/cheque-sheet-templates': ['OWNER'],
    'POST /api/cheque-sheet-templates': ['OWNER'],
    'PUT /api/cheque-sheet-templates/:id': ['OWNER'],
    'DELETE /api/cheque-sheet-templates/:id': ['OWNER'],
    'GET /api/cheque-sheet-payers': ['OWNER'],
    'PUT /api/cheque-sheet-payers': ['OWNER'],
    // ★ cwm-chequeprint-20261005：支票打印 —— 老闆拍板只俾老闆用，★★★ 唔加 RBAC_PERM_OVERRIDES
    'GET /api/cheques/settings': ['OWNER'],
    'POST /api/cheques/accounts': ['OWNER'],
    'PUT /api/cheques/accounts/:id': ['OWNER'],
    'PUT /api/cheques/payees': ['OWNER'],
    'PUT /api/cheques/layouts/:id': ['OWNER'],
    'GET /api/cheques/center': ['OWNER'],
    // ★ cwm-chequerec-20261005：支票紀錄（連作廢）＋ Excel 匯出 —— 只限老闆
    'GET /api/cheques/records': ['OWNER'],
    'GET /api/cheques/records/export': ['OWNER'],
    'PUT /api/cheques/lab-amounts': ['OWNER'],
    'POST /api/cheques/issue': ['OWNER'],
    'PATCH /api/cheques/:id': ['OWNER'],
    'GET /api/payroll-runs/exceptions': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'GET /api/payroll-runs/allowed-clinics': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // ★ cwm-holidayot-20260911：假期返工 OT 人手扣減 —— 拍板④ 只有 OWNER。
    //   ⚠️ RBAC_PERM_OVERRIDES 一條都唔加（加咗就會俾有 attendance_manage 嘅人入到）。
    'GET /api/holiday-ot-adjustments': ['OWNER'],
    'PUT /api/holiday-ot-adjustments': ['OWNER'],
    'DELETE /api/holiday-ot-adjustments/:id': ['OWNER'],
    // ★ 2026-09-30：午飯扣減人手調整 —— 同假期 OT 調整一樣只 OWNER；RBAC_PERM_OVERRIDES 唔加
    'GET /api/lunch-overrides': ['OWNER'],
    'PUT /api/lunch-overrides': ['OWNER'],
    'DELETE /api/lunch-overrides': ['OWNER'],

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
    // ★ cwm-attbatch-20260927：早退批量補鐘（同單筆同一權限口徑；漏咗呢行 requireAuth 會全部 403）
    'POST /api/timebank/makeup/batch': ['OWNER', 'MANAGER'],
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
    'GET /api/my/roster-hours': ['OWNER', 'MANAGER', 'ACCOUNTANT', 'EMPLOYEE'],

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

    // ★ 2026-08-21: 排班頁月備註（SchedulingMemo，按公司）—— 另有 RBAC_PERM_OVERRIDES 開 scheduling 權限
    'GET /api/scheduling-memo': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    'PUT /api/scheduling-memo': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // ★ 2026-08-21: 排班頁月視圖假期總覽（批量：員工＋服務年度年假＋LeaveBalance＋PayRule table）
    'GET /api/scheduling-leave-summary': ['OWNER', 'MANAGER', 'ACCOUNTANT'],

    // ★ MD-B: Cost Entry — 成本錄入（Lab / Implant / Invisalign）
    'GET /api/cost-cases': ['OWNER', 'MANAGER'],
    'POST /api/cost-cases': ['OWNER', 'MANAGER'],
    'POST /api/cost-cases/implant': ['OWNER', 'MANAGER'],
    'PUT /api/cost-cases/:id': ['OWNER', 'MANAGER'],
    // ★ 2026-09-02 cwm-costnote：「已完成」綠剔（拍板③：已鎖定都可以標）
    'PATCH /api/cost-cases/:id/status': ['OWNER', 'MANAGER'],
    'DELETE /api/cost-cases/:id': ['OWNER', 'MANAGER'],
    'POST /api/cost-cases/recompute': ['OWNER'],
    // ★ MD-F: Cost Entry bill picker
    'GET /api/cost-cases/patient-search': ['OWNER', 'MANAGER'],
    'GET /api/cost-cases/bill-search': ['OWNER', 'MANAGER'],
    // ★ cwm-payoutxlsx-20260908 D2: 雜項收入（前台日常；cost_entry 權限覆蓋見 RBAC_PERM_OVERRIDES）
    'GET /api/misc-income': ['OWNER', 'MANAGER'],
    'POST /api/misc-income': ['OWNER', 'MANAGER'],
    'PUT /api/misc-income/:id': ['OWNER', 'MANAGER'],
    'DELETE /api/misc-income/:id': ['OWNER', 'MANAGER'],
    // Lab 主檔
    'GET /api/labs': ['OWNER', 'MANAGER'],
    'POST /api/labs': ['OWNER'],
    'PUT /api/labs/:id': ['OWNER'],
    'PATCH /api/labs': ['OWNER'],
    'DELETE /api/labs': ['OWNER'],
    // Lab 月度折扣
    'GET /api/lab-discounts': ['OWNER', 'MANAGER'],
    'POST /api/lab-discounts': ['OWNER'],
    // ★ MD-C: Apricot Payment / Bill Sync
    'POST /api/apricot/sync': ['OWNER'],
    'POST /api/apricot/sync/cron': ['OWNER'], // ★ cron 專用，實際用 x-cron-key 認證
    // ★ Phase 4（MD §9.2 / §A.2）：外部當值狹窄 API — 舊 path 302 → /api/external/v1/duty-roster；
    //   v1 守門 = DB ExternalApiKey（sha256 hash、timing-safe）+ scope 檢查 + token bucket 限流（見 @/lib/external-api.ts），無 env key / IP allowlist。
    //   此 entry 純聲明用（同 apricot cron 慣例）。
    'GET /api/external/duty-roster': ['OWNER'],
    'GET /api/apricot/sync/jobs': ['OWNER', 'MANAGER'],
    'GET /api/apricot/sync/jobs/:id': ['OWNER', 'MANAGER'],
    'POST /api/apricot/sync/jobs/:id': ['OWNER'],
    'GET /api/apricot/status': ['OWNER', 'MANAGER'],
    // ★ MD-AC3: 店鋪營收卡片 — OWNER 預設，provider_payout 權限可放行
    'GET /api/apricot/clinic-revenue': ['OWNER'],
    // ★ cwm-apricotacct-20260913 E2：未綁帳號 — 直接影響拆帳，只准 OWNER。
    //   ★★★ 唔加 RBAC_PERM_OVERRIDES（坑⑧）。
    'GET /api/apricot-accounts/unassigned': ['OWNER'],
    'PUT /api/apricot-accounts': ['OWNER'],
    // ★ cwm-datasource-20261003：資料來源設定 + 憑證（貼 token）—— 憑證等同 Apricot 登入，只准 OWNER。
    //   ★★★ 唔加 RBAC_PERM_OVERRIDES（有 apricot_sync 權限都唔應該換得到登入憑證）。
    'GET /api/apricot-sources': ['OWNER'],
    'POST /api/apricot-sources': ['OWNER'],
    'PUT /api/apricot-sources': ['OWNER'],
    'PUT /api/apricot-sources/clinic': ['OWNER'],
    'PUT /api/apricot-sources/credential': ['OWNER'],
    'POST /api/apricot-sources/test': ['OWNER'],
    'GET /api/apricot-sources/health': ['OWNER'],
    'GET /api/payment-method-rules': ['OWNER', 'MANAGER'],
    'POST /api/payment-method-rules': ['OWNER'],

    // 材料主檔
    'GET /api/material-items': ['OWNER', 'MANAGER'],
    'POST /api/material-items': ['OWNER'],
    'PUT /api/material-items/:id': ['OWNER'], // ★ cwm-matedit-t1: 停用/啟用/封版（淨 isActive/effectiveTo）

    // ★ MD-D: Payout Engine — 醫生拆帳（OWNER only）
    'GET /api/payout-runs': ['OWNER'],
    'POST /api/payout-runs': ['OWNER'],
    'POST /api/payout-runs/preview': ['OWNER'],
    'GET /api/payout-runs/:id': ['OWNER'],
    'POST /api/payout-runs/:id/lock': ['OWNER'],
    'POST /api/payout-runs/:id/unlock': ['OWNER'],
    'DELETE /api/payout-runs/:id': ['OWNER'], // ★ AA4: 刪除草稿月結單
    'GET /api/payout-runs/:id/export': ['OWNER'], // ★ AA3: Excel 匯出
    'GET /api/payout-runs/clinic-report': ['OWNER'], // ★ cwm-payoutxlsx C: 全店月報（MD 坑⑧）
    'GET /api/payout-runs/daily': ['OWNER'], // ★ cwm-dailyrev-20261003: 每日大數（同月結單同一權限）
    'GET /api/payout-runs/:id/vendor-summary': ['OWNER'], // ★ 2026-08-26: 工廠總覽（跨醫生）
    'POST /api/payout-runs/clinics': ['OWNER'],
    'GET /api/payout-runs/stale-costs': ['OWNER'], // ★ cwm-costdetail-20261006: 成本異常（落單超過 2 個月未到貨）
    'GET /api/provider-referrals': ['OWNER'],
    'POST /api/provider-referrals': ['OWNER'],
    'PUT /api/provider-referrals/:id': ['OWNER'],
    'DELETE /api/provider-referrals/:id': ['OWNER'],
    'GET /api/provider-referrals/bill-lookup': ['OWNER'],
    'POST /api/provider-referrals/batch': ['OWNER'],
    'POST /api/provider-referrals/:id/reset': ['OWNER'],
    'POST /api/provider-referrals/:id/complete': ['OWNER'],
    'GET /api/sp-subsidies': ['OWNER'],
    'POST /api/sp-subsidies/scan': ['OWNER'],
    'POST /api/sp-subsidies/:id/confirm': ['OWNER'],
    'POST /api/sp-subsidies/bulk-confirm': ['OWNER'],
    'POST /api/sp-subsidies/:id/skip': ['OWNER'],
    'POST /api/sp-subsidies/:id/reset': ['OWNER'],
    // ★ MD-E: 月報對數
    'GET /api/reconciliation': ['OWNER'],
    'POST /api/reconciliation/upload': ['OWNER'],
    'POST /api/reconciliation/parse': ['OWNER'],
    // ★ D2: Payout adjustments
    'POST /api/payout-adjustments': ['OWNER'],
    // —— 醫生時間表「立即同步」（cw-pta 2026-08-21）——
    // route 行 requirePerm('scheduling')（真正把關）；呢度係角色白名單登記。
    // 冇 scheduling 嘅角色（純 ACCOUNTANT / EMPLOYEE / KIOSK）要 grant 先入得去。
    'POST /api/provider-availability/sync': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
    // ★ cwm-labdoc P1：Lab 單據（§10.4）。role 白名單 OWNER/MANAGER；
    //   EMPLOYEE 等其他角色經 RBAC_PERM_OVERRIDES 的 lab_invoice／lab_statement 放行（B10）。
    'POST /api/lab-docs/upload': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id': ['OWNER', 'MANAGER'],
    //   P2：再讀（§11；EMPLOYEE 經 RBAC_PERM_OVERRIDES 嘅 lab_invoice 放行）
    'POST /api/lab-docs/:id/retry': ['OWNER', 'MANAGER'],
    //   P2：確認頭部（§7.1）＋候選成本（§6.5/§7.3）
    'PUT /api/lab-docs/:id/header': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/new-case': ['OWNER', 'MANAGER'],
    'DELETE /api/lab-docs/:id': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/merge': ['OWNER', 'MANAGER'],
    //   P2 CHUNK 5：待處理 7 類別（§9）— 列表（lab_invoice 或 lab_statement 睇到；類別級再過濾）
    'GET /api/lab-docs/pending': ['OWNER', 'MANAGER'],
    //   P2 CHUNK 5：待處理 resolve（§11 per-doc；lab_statement）
    'POST /api/lab-docs/:id/review-amount': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/payee': ['OWNER', 'MANAGER'],
    //   P3 §8：月結單對數（全部 lab_statement）— runtime key（cuid → :id）＋
    //   check-rbac-matrix.sh 字面 dead key（greedy \[.*\] 收埋多參數 — 跟 :id/save 先例）
    'POST /api/lab-docs/:id/supersede': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/sections/:id/assign': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/sections/:id/reconcile': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/sections/:id/confirm': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/sections/:id/lines/:id/resolve': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/sections/:id/lines/:id/close-followup': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/assign': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/reconcile': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/confirm': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/resolve': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/close-followup': ['OWNER', 'MANAGER'],
    //   候選 route：normalizeRoute 唔將 1–2 位 group index 變 :id → 逐個登記 0–10
    //   （>10 分組 = matrix miss → 403 fail-closed；decision log）
    'GET /api/lab-docs/:id/groups/0/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/1/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/2/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/3/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/4/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/5/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/6/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/7/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/8/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/9/candidates': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/:id/groups/10/candidates': ['OWNER', 'MANAGER'],
    //   §7.8 儲存分組（同候選：逐個登記 0–10）
    'POST /api/lab-docs/:id/groups/0/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/1/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/2/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/3/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/4/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/5/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/6/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/7/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/8/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/9/save': ['OWNER', 'MANAGER'],
    'POST /api/lab-docs/:id/groups/10/save': ['OWNER', 'MANAGER'],
    //   註：check-rbac-matrix.sh 嘅 grep 正規化（greedy \[.*\]）將 [id]/groups/[g] 收埋 → 要求字面 key
    //   "/api/lab-docs/:id/save"（runtime normalizeRoute 唔會產出 — dead key，只係過守門用，跟 candidates 先例）
    'POST /api/lab-docs/:id/save': ['OWNER', 'MANAGER'],
    //   註：check-rbac-matrix.sh 嘅 grep 正規化（greedy \[.*\]）將 [id]/groups/[g] 收埋 → 要求字面 key
    //   "/api/lab-docs/:id/candidates"（runtime normalizeRoute 唔會產出 — dead key，只係過守門用，
    //   跟 P1 files/:id 先例）；真正 runtime key = 上面 groups/0–10 十一條
    'GET /api/lab-docs/:id/candidates': ['OWNER', 'MANAGER'],
    //   頁圖 route：normalizeRoute 唔會將 1–2 位頁碼變 :id → 逐頁登記（1–30 = PDF_MAX_PAGES）
    'GET /api/lab-docs/files/:id/pages/1': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/2': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/3': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/4': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/5': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/6': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/7': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/8': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/9': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/10': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/11': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/12': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/13': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/14': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/15': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/16': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/17': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/18': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/19': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/20': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/21': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/22': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/23': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/24': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/25': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/26': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/27': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/28': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/29': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/pages/30': ['OWNER', 'MANAGER'],
    'GET /api/lab-docs/files/:id/original': ['OWNER', 'MANAGER'],
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
  // ★ 2026-09-30 [cwm-restdebt] RS-16：舊 /api/leave-settlement 已刪（另一套口徑：前端傳月薪、日薪=月薪×12÷365、唔讀 LeaveBalance；前端冇用）
  'POST /api/employees/:id/resign-settle': ['payroll_generate'],

  // —— 發放休息日：有 scheduling 權限就可以發放（grant-restdays route 改用 scheduling 權限） ——
  'POST /api/leave/grant-restdays': ['scheduling'],

  // —— 假期修改：有 scheduling 或 leave_approve 權限可以修改/刪除假期 ——
  'PUT /api/leave-requests/:id': ['scheduling', 'leave_approve'],
  'DELETE /api/leave-requests/:id': ['scheduling', 'leave_approve'],
  'PATCH /api/leave-requests/:id': ['scheduling', 'leave_approve'],
  // ★ PL 標記：排班權限（拍板 2026-08-21 ④）
  'PATCH /api/leave-requests/:id/pl-mark': ['scheduling'],

  // —— 假期額度管理：有 leave_approve 權限可以更新/初始化假期餘額 ——
  'PATCH /api/leave-balance': ['leave_approve'],
  'POST /api/leave-balance/init': ['leave_approve'],

  // —— 員工總覽：有 employee_overview 權限可以查看員工總覽（限主屬診所） ——
  'GET /api/employees/:id/overview': ['employee_overview'],
  'GET /api/employees/:id/overview/history': ['employee_overview'],
  'GET /api/employees/:id/overview/attendance-days': ['employee_overview'],
  'GET /api/employees/:id/timebank-ledger': ['employee_overview'],
  'GET /api/employees': ['employee_overview', 'payroll_view', 'payroll_generate'],

  // ★ 2026-08-03：計糧相關 —— 側欄已開放畀有權限嘅 EMPLOYEE，
  //   API 層要跟，否則入口開咗但 403（第六次撞呢個模式）
  'GET /api/payroll-runs': ['payroll_view', 'payroll_generate'],
  'GET /api/payroll-runs/:id': ['payroll_view', 'payroll_generate'],
  'GET /api/payroll-runs/:id/employee/:id': ['payroll_view', 'payroll_generate'],
  // ★ cwm-payrollsheet-20260921 S3：同「確認計糧」（PUT :id）同一個權限 —— 會計開咗 payroll_finalize 就填得到
  'PATCH /api/payroll-runs/:id/employee/:id': ['payroll_finalize'],
  'POST /api/payroll-runs/:id/employee/:id': ['payroll_generate'], // ★ cwm-payrollsingle-20261003
  'DELETE /api/payroll-runs/:id/employee/:id': ['payroll_generate'], // ★ cwm-payrollsingle-20261003
  // ★ cwm-payrollsheet-20260921 S4：同考勤異常報表同一級（payroll_view）
  'GET /api/payroll-runs/cheque-sheet': ['payroll_view'],
  'POST /api/payroll-runs/:id/export': ['payroll_view', 'payroll_generate'],
  'POST /api/payroll-runs/bulk-export-audit': ['payroll_view', 'payroll_generate'], // ★ cwm-bulkpayslip-20261003
  'GET /api/payroll-runs/exceptions': ['payroll_view', 'payroll_generate', 'attendance_manage'],
  'POST /api/payroll-runs/preview': ['payroll_view', 'payroll_generate'],
  // ★ 生成／預檢限 payroll_generate（淨係 payroll_view 唔夠）
  'POST /api/payroll-runs': ['payroll_generate'],
  'GET /api/payroll-runs/:id/preflight': ['payroll_generate'],

  // ★ 診所範圍 — 計糧生成用獨立 route，同 POST /api/payroll-runs 同一範圍
  'GET /api/payroll-runs/allowed-clinics': ['payroll_generate'],

  // ★ cwm-acct-20260917：確認計糧／標記匯出可以授權（退回草稿仍然 OWNER-only，喺 handler 用 role 擋）
  'PUT /api/payroll-runs/:id': ['payroll_finalize'],

  // ★ 考勤補登
  'POST /api/punch-corrections': ['attendance_manage'],

  // ★ 考勤（2026-08-03）—— 範圍全公司，因為調鋪員工會喺其他店出現
  'GET /api/punches': ['attendance_manage'],
  'GET /api/punches/:id': ['attendance_manage'],
  'PUT /api/punch-corrections/:id': ['attendance_manage'],

  // ★ cwm-crossclinic-20260914：異地打卡提醒（純查詢，同 GET /api/punches 同一級）
  'GET /api/attendance/cross-clinic': ['attendance_manage'],

  // ★ 2026-08-04: 排班每日備註 —— 有 scheduling 權限可讀/寫
  'GET /api/schedule-notes': ['scheduling'],
  'PUT /api/schedule-notes': ['scheduling'],

  // ★ 2026-08-21: 排班頁月備註 —— 有 scheduling 權限可讀/寫
  'GET /api/scheduling-memo': ['scheduling'],
  'PUT /api/scheduling-memo': ['scheduling'],
  // ★ 2026-08-21: 排班頁月視圖假期總覽 —— 照 memo precedent 開 scheduling
  'GET /api/scheduling-leave-summary': ['scheduling'],

  // ★ 2026-08-15: 應返工時 —— 排班主管需要查看
  'GET /api/roster-hours': ['scheduling'],

  // —— 醫生當值排更 ——
  // ⚠️ 呢啲 route 用 requirePerm，requirePerm 唔讀本表。
  // 留喺度純粹係 check-rbac-matrix.sh 嘅登記要求 + 文件用途。
  // 真正把關喺 ROLE_DEFAULTS[role] 同埋各 route 自己嘅 resolveProviderScheduleScope。
  // ★ 2026-08-22：成本錄入要揀醫生 —— 加 cost_entry（route 改 requireAnyPerm，providers/route.ts）
  'GET /api/providers': ['provider_schedule', 'scheduling', 'cost_entry'],
  'POST /api/providers': ['provider_schedule', 'scheduling'],
  'PUT /api/providers/:id': ['provider_schedule', 'scheduling'],
  'DELETE /api/providers/:id': ['provider_schedule', 'scheduling'],
  'GET /api/provider-shifts': ['provider_schedule', 'scheduling'],
  'POST /api/provider-shifts/batch': ['provider_schedule', 'scheduling'],
  'DELETE /api/provider-shifts/:id': ['provider_schedule', 'scheduling'],
  'PATCH /api/provider-shifts/:id': ['provider_schedule', 'scheduling'], // ★ cwm-provroster S1-2
  // ★ 每週固定 pattern（cw-patwl）—— 同 provider-shifts 同一組權限
  'GET /api/provider-patterns': ['provider_schedule', 'scheduling'],
  'PUT /api/provider-patterns': ['provider_schedule', 'scheduling'],

  // —— 醫生時間表（Apricot availability）——
  // ★ 2026-08-22：route 改 requireAnyPerm(['scheduling','provider_schedule']) ——
  //   店鋪帳號（KIOSK，provider_schedule）可睇自己店時間表；KIOSK 唔開 scheduling
  //   （嗰個含員工薪酬相關查看權）。resolveProviderScheduleScope 照常收窄範圍。
  'GET /api/provider-availability': ['provider_schedule', 'scheduling'],
  // ★ 2026-08-21 cw-pta：「立即同步」掣 —— 同 GET 時間表同一組權限
  'POST /api/provider-availability/sync': ['provider_schedule', 'scheduling'],

  // —— 醫生休假 ——
  'GET /api/provider-leaves': ['provider_schedule'],
  'POST /api/provider-leaves': ['provider_schedule'],
  'DELETE /api/provider-leaves/:id': ['provider_schedule'],
  'PATCH /api/provider-leaves/:id': ['provider_schedule'], // ★ cwm-provroster S1-3

  // —— 醫生拆帳 —— OWNER only（MANAGER 冇權睇醫生收入）
  'GET /api/provider-commissions': ['provider_payout'],
  'POST /api/provider-commissions': ['provider_payout'],

  // —— 收費項目標準價 ——
  'GET /api/fee-item-list-prices': ['provider_payout'],
  'POST /api/fee-item-list-prices': ['provider_payout'],
  'PATCH /api/fee-item-list-prices/:id': ['provider_payout'],
  'DELETE /api/fee-item-list-prices/:id': ['provider_payout'],

  // —— MD-B: Cost Entry ——
  //   cost_entry 權限：MANAGER 可以錄入成本
  'GET /api/cost-cases': ['cost_entry'],
  // ★ 2026-08-22：成本錄入要揀 Lab／材料／折扣 —— GET 只讀
  //   （寫入端 = provider_payout override + OWNER role 表，一齊都唔放寬）
  'GET /api/labs': ['cost_entry'],
  'GET /api/lab-discounts': ['cost_entry'],
  'GET /api/material-items': ['cost_entry'],
  // ★ 2026-08-22：成本錄入「負責同事」picker（淨返 id + user.name）
  'GET /api/employees/dsa-options': ['cost_entry'],
  'POST /api/cost-cases': ['cost_entry'],
  'POST /api/cost-cases/implant': ['cost_entry'],
  'PUT /api/cost-cases/:id': ['cost_entry'],
  // ★ 2026-09-02 cwm-costnote：「已完成」綠剔
  'PATCH /api/cost-cases/:id/status': ['cost_entry'],
  'DELETE /api/cost-cases/:id': ['cost_entry'],
  // ★ MD-F: bill picker routes
  // ★ Y4: provider_payout 也可以用病人/帳單搜尋
  'GET /api/cost-cases/patient-search': ['cost_entry', 'provider_payout'],
  'GET /api/cost-cases/bill-search': ['cost_entry', 'provider_payout'],
  // ★ cwm-payoutxlsx-20260908 D2: 雜項收入 —— 前台日常工作，同成本錄入同一批人（cost_entry）
  //   睇月報／出月結先係 OWNER，呢度唔放寬到 provider_payout
  'GET /api/misc-income': ['cost_entry'],
  'POST /api/misc-income': ['cost_entry'],
  'PUT /api/misc-income/:id': ['cost_entry'],
  'DELETE /api/misc-income/:id': ['cost_entry'],
  //   provider_payout 權限：折扣設定 / 材料單價（只 OWNER）
  'POST /api/cost-cases/recompute': ['provider_payout'],
  'POST /api/labs': ['provider_payout'],
  'PUT /api/labs/:id': ['provider_payout'],
  'PATCH /api/labs': ['provider_payout'],
  'DELETE /api/labs': ['provider_payout'],
  'POST /api/lab-discounts': ['provider_payout'],
  'POST /api/material-items': ['provider_payout'],
  'PUT /api/material-items/:id': ['provider_payout'], // ★ cwm-matedit-t1: 跟 POST 模式

  // —— MD-C: Apricot Data Layer ——
  // ★ 2026-08-22：Apricot 同步獨立 key（apricot_sync）—— 寫（發起同步）只 apricot_sync；
  //   讀（job 進度 poll）= apricot_sync / cost_entry / provider_payout
  'POST /api/apricot/sync': ['apricot_sync'],
  // ★ 2026-08-22：同步 job 讀寫 —— 讀（睇進度）開放俾攞權限者，寫（取消）只 apricot_sync
  'GET /api/apricot/sync/jobs': ['apricot_sync', 'cost_entry', 'provider_payout'],
  'GET /api/apricot/sync/jobs/:id': ['apricot_sync', 'cost_entry', 'provider_payout'],
  'POST /api/apricot/sync/jobs/:id': ['apricot_sync'],
  'GET /api/apricot/status': ['provider_payout'],
  // ★ MD-AC3: 店鋪營收卡片
  'GET /api/apricot/clinic-revenue': ['provider_payout'],
  'GET /api/payment-method-rules': ['provider_payout'],
  'POST /api/payment-method-rules': ['provider_payout'],

  // —— MD-D: Payout Engine ——
  'GET /api/payout-runs': ['provider_payout'],
  'POST /api/payout-runs': ['provider_payout'],
  'POST /api/payout-runs/preview': ['provider_payout'],
  'GET /api/payout-runs/:id': ['provider_payout'],
  'POST /api/payout-runs/:id/lock': ['provider_payout'],
  'POST /api/payout-runs/:id/unlock': ['provider_payout'],
  'DELETE /api/payout-runs/:id': ['provider_payout'], // ★ AA4
  'GET /api/payout-runs/:id/export': ['provider_payout'], // ★ AA3
  'GET /api/payout-runs/clinic-report': ['provider_payout'], // ★ cwm-payoutxlsx C: 全店月報（同單張匯出同一套權限）
  'GET /api/payout-runs/daily': ['provider_payout'], // ★ cwm-dailyrev-20261003
  'GET /api/payout-runs/:id/vendor-summary': ['provider_payout'], // ★ 2026-08-26: 工廠總覽（同月結單同一權限，MD §3.3）
  'POST /api/payout-runs/clinics': ['provider_payout'],
  'GET /api/payout-runs/stale-costs': ['provider_payout'], // ★ cwm-costdetail-20261006（同月結頁同一權限）
  'GET /api/provider-referrals': ['provider_payout'],
  'POST /api/provider-referrals': ['provider_payout'],
  'PUT /api/provider-referrals/:id': ['provider_payout'],
  'DELETE /api/provider-referrals/:id': ['provider_payout'],
  'GET /api/provider-referrals/bill-lookup': ['provider_payout'],
  'POST /api/provider-referrals/batch': ['provider_payout'],
  'POST /api/provider-referrals/:id/reset': ['provider_payout'],
  'POST /api/provider-referrals/:id/complete': ['provider_payout'],
  'GET /api/sp-subsidies': ['provider_payout'],
  'POST /api/sp-subsidies/scan': ['provider_payout'],
  'POST /api/sp-subsidies/:id/confirm': ['provider_payout'],
  'POST /api/sp-subsidies/bulk-confirm': ['provider_payout'],
  'POST /api/sp-subsidies/:id/skip': ['provider_payout'],
  'POST /api/sp-subsidies/:id/reset': ['provider_payout'],
  // ★ MD-E: 月報對數
  'GET /api/reconciliation': ['provider_payout'],
  'POST /api/reconciliation/upload': ['provider_payout'],
  'POST /api/reconciliation/parse': ['provider_payout'],
  // ★ D2: Payout adjustments
  'POST /api/payout-adjustments': ['provider_payout'],
  // ★ cwm-labdoc P1：Lab 單據 — §10.2：上傳、檔案庫、睇檔／下載原檔 = lab_invoice ✅ lab_statement ✅
  'POST /api/lab-docs/upload': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/:id': ['lab_invoice', 'lab_statement'],
  // ★ cwm-labdoc P2：再讀 = lab_invoice（§11）
  'POST /api/lab-docs/:id/retry': ['lab_invoice'],
  // ★ cwm-labdoc P2 CHUNK 5：待處理（§9）— 列表 = lab_invoice 或 lab_statement；
  //   resolve = lab_statement（AMOUNT_REVIEW／NEW_PAYEE）
  'GET /api/lab-docs/pending': ['lab_invoice', 'lab_statement'],
  //   P2 CHUNK 5：待處理 resolve（§11 per-doc = lab_statement）
  'POST /api/lab-docs/:id/review-amount': ['lab_statement'],
  'POST /api/lab-docs/:id/payee': ['lab_statement'],
  // ★ cwm-labdoc P3 §8：月結單對數 = lab_statement（§10.2：識別、處理差異、確認、取代舊版）
  'POST /api/lab-docs/:id/supersede': ['lab_statement'],
  'POST /api/lab-docs/:id/sections/:id/assign': ['lab_statement'],
  'POST /api/lab-docs/:id/sections/:id/reconcile': ['lab_statement'],
  'POST /api/lab-docs/:id/sections/:id/confirm': ['lab_statement'],
  'POST /api/lab-docs/:id/sections/:id/lines/:id/resolve': ['lab_statement'],
  'POST /api/lab-docs/:id/sections/:id/lines/:id/close-followup': ['lab_statement'],
  'POST /api/lab-docs/:id/assign': ['lab_statement'],
  'POST /api/lab-docs/:id/reconcile': ['lab_statement'],
  'POST /api/lab-docs/:id/confirm': ['lab_statement'],
  'POST /api/lab-docs/:id/resolve': ['lab_statement'],
  'POST /api/lab-docs/:id/close-followup': ['lab_statement'],
  // ★ cwm-labdoc P2 §7：確認／對成本 = lab_invoice
  'PUT /api/lab-docs/:id/header': ['lab_invoice'],
  'POST /api/lab-docs/:id/new-case': ['lab_invoice'],
  'DELETE /api/lab-docs/:id': ['lab_invoice'],
  'POST /api/lab-docs/merge': ['lab_invoice'],
  // 候選 route：同 RBAC_MATRIX 一樣要逐個 group index 登記（normalizeRoute 唔會將 1–2 位數字變 :id）
  'GET /api/lab-docs/:id/groups/0/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/1/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/2/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/3/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/4/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/5/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/6/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/7/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/8/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/9/candidates': ['lab_invoice'],
  'GET /api/lab-docs/:id/groups/10/candidates': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/0/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/1/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/2/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/3/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/4/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/5/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/6/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/7/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/8/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/9/save': ['lab_invoice'],
  'POST /api/lab-docs/:id/groups/10/save': ['lab_invoice'],
  'GET /api/lab-docs/files/:id/pages/1': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/2': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/3': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/4': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/5': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/6': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/7': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/8': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/9': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/10': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/11': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/12': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/13': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/14': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/15': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/16': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/17': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/18': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/19': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/20': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/21': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/22': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/23': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/24': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/25': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/26': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/27': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/28': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/29': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/pages/30': ['lab_invoice', 'lab_statement'],
  'GET /api/lab-docs/files/:id/original': ['lab_invoice', 'lab_statement'],
}

export type Role = typeof CONFIG.ROLES[keyof typeof CONFIG.ROLES]
