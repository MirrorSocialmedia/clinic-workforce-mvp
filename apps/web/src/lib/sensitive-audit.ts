/**
 * 敏感操作審計 — 單一來源。
 * ★ 新增任何 audit action 都要喺呢度表態：放入 SPEC（入摘要）或 EXEMPT（明確豁免）。
 * scripts/check-sensitive-coverage.sh 會檢查每個自訂 action 都有冇分類。
 */

export const SENSITIVE_AUDIT_SPEC: Array<{ action: string; entity?: string; label: string }> = [
  { action: 'VOID_PUNCH', label: '作廢打卡' },
  { action: 'CREATE_PUNCH', label: '補登打卡' },
  { action: 'PUNCH_EDIT', label: '編輯打卡' },
  { action: 'ABSENT_DEDUCT', label: '缺勤扣OT' },
  { action: 'ABSENT_DEDUCT_CANCEL', label: '取消扣OT' },
  { action: 'CONVERT', label: 'OT換假' },
  { action: 'CREATE', entity: 'PunchCorrection', label: '補登申請（改時間）' },
  { action: 'UPDATE', entity: 'PunchCorrection', label: '批核補登申請' },
  { action: 'CORRECTION_SELF_APPROVE', label: '⚠️ 自批補登' },
  { action: 'EARLY_OT_APPROVE', label: '批准提早上班OT' },
  { action: 'EARLY_OT_CANCEL', label: '取消提早上班OT' },
  { action: 'EARLY_OT_AUTO_REVOKE', label: '⚠️ 打卡改動·自動撤回提早OT' },
  { action: 'EARLY_OT_SELF_APPROVE', label: '⚠️ 自批提早上班OT' },
  { action: 'FACE_REVIEW_ACTION', label: '人臉覆核批核' },
  { action: 'TIMEBANK_INIT_ADJUST', label: '初始化時間帳戶' },
  { action: 'TIMEBANK_MAKEUP', label: '補鐘' },
  { action: 'TIMEBANK_CONVERT', label: '時間帳戶兌換' },
  { action: 'TIMEBANK_ABSENT_DEDUCT', label: '缺勤扣OT鐘' },
  { action: 'TIMEBANK_REST_TO_ACCOUNT', label: '休息日還鐘' },
  { action: 'LEAVE_INIT', label: '初始化假期額度' },
  { action: 'LEAVE_ADD', label: '增加假期額度' },
  { action: 'LEAVE_BALANCE_ADJUST', label: '校正假期餘額' },
  { action: 'LEAVE_BALANCE_DELETE', label: '刪除假期餘額' },
  { action: 'DELETE', entity: 'LeaveRequest', label: '刪除請假' },
  { action: 'LEAVE_REQUEST_PATCH', label: '修改請假狀態' },
  { action: 'EXPENSE_CREATE', label: '新增雜項' },
  { action: 'EXPENSE_DELETE', label: '刪除雜項' },
  { action: 'PAYROLL_REVERT_TO_DRAFT', label: '計糧重製草稿' },
  // ★ 2026-08-05: Additional sensitive actions from coverage scan
  { action: 'ACCOUNT_DELETE', label: '刪除帳戶' },
  { action: 'ACCOUNT_PURGE', label: '⚠️ 徹底清除帳號' },
  { action: 'UPDATE_ACCOUNT', label: '更新帳戶' },
  { action: 'ADW_POLICY_CAP', label: '扣OT政策上限' },
  { action: 'CREATE_PAYROLL_RUN', label: '建立計糧批次' },
  { action: 'EMPLOYEE_REHIRE', label: '重新聘用' },
  { action: 'EMPLOYEE_RESIGN', label: '員工辭職' },
  { action: 'FACE_ENROLL_APPROVE', label: '批准人臉登記' },
  { action: 'FACE_ENROLL_REJECT', label: '拒絕人臉登記' },
  { action: 'PAY_RULE_UPDATE', label: '更新計薪規則' },
  { action: 'WAGE_HISTORY_CREATE', label: '新增工資記錄' },
  { action: 'WAGE_HISTORY_UPDATE', label: '更新工資記錄' },
  { action: 'WAGE_HISTORY_DELETE', label: '刪除工資記錄' },
  { action: 'SHIFT_EDIT_AFTER_PAYROLL', label: '⚠️ 已出糧月份改更次' },
  { action: 'SHIFT_CHANGE_APPROVE', label: '換更審批·自動撤回提早OT' },
  { action: 'PROVIDER_CREATE', label: '新增醫生' },
  { action: 'PROVIDER_UPDATE', label: '更新醫生' },
  { action: 'PROVIDER_SHIFT_BATCH', label: '批量排醫生當值' },
  { action: 'PROVIDER_SHIFT_DELETE', label: '刪除醫生當值' },
  { action: 'PROVIDER_COMMISSION_SET', label: '新增醫生拆帳設定' },
  { action: 'PROVIDER_LEAVE_SET', label: '新增醫生休假' },
  { action: 'PROVIDER_LEAVE_DELETE', label: '刪除醫生休假' },
  // ★ MD-B: Cost Entry audit actions
  { action: 'COST_CASE_CREATE', label: '新增成本記錄' },
  { action: 'COST_CASE_UPDATE', label: '更新成本記錄' },
  { action: 'COST_CASE_VOID', label: '作廢成本記錄' },
  { action: 'COST_RECOMPUTE', label: '折扣重算' },
  { action: 'LAB_DISCOUNT_SET', label: '設定 Lab 月度折扣' },
  { action: 'LAB_UPDATE', label: 'Lab 改名/停用' },
  { action: 'LAB_DELETE', label: 'Lab 刪除' },
  { action: 'MATERIAL_ITEM_CREATE', label: '新增材料項目' },
  { action: 'MATERIAL_ITEM_UPDATE', label: '材料項目停用／改到期日' },
  // ★ 2026-09-02 cwm-costnote：「已完成」綠剔狀態變更
  { action: 'COST_CASE_STATUS', label: '成本個案狀態變更（已完成標記）' },
  { action: 'PATIENT_NAME_PURGE', label: 'PII 清理 — 清除病人姓名' },
  // ★ MD-C: Apricot Data Layer
  { action: 'APRICOT_SYNC', label: 'Apricot 同步觸發' },
  { action: 'PAYMENT_METHOD_RULE_CREATE', label: '新增付款方式規則' },
  // ★ MD-D: Payout Engine
  { action: 'PAYOUT_RUN_LOCK', label: '鎖定月結單' },
  { action: 'PAYOUT_RUN_UNLOCK', label: '⚠️ 解鎖月結單' },
  { action: 'PAYOUT_RUN_DELETE', label: '⚠️ 刪除月結單草稿' },
  { action: 'PAYOUT_EXPORT', label: '匯出月結單' },
  { action: 'REFERRAL_CREATE', label: '新增轉介記錄' },
  { action: 'REFERRAL_DELETE', label: '刪除轉介記錄' },
  { action: 'REFERRAL_BATCH_CREATE', label: '批次新增轉介' },
  { action: 'DRAFT_REFERRAL_CREATE', label: '新增轉介草稿' },
  { action: 'REFERRAL_COMPLETE', label: '轉介草稿補上帳單' },
  { action: 'REFERRAL_UPDATE', label: '更新轉介' },
  { action: 'SP_SUBSIDY_CONFIRM', label: '確認 SP 補貼' },
  { action: 'SP_SUBSIDY_SKIP', label: '跳過 SP 補貼' },
  { action: 'SP_SUBSIDY_RESET', label: '取消確認 SP 補貼' },
  { action: 'PAYOUT_ADJUST_CREATE', label: '新增調整記錄' },
  // ★ MD-E: 月報對數
  { action: 'RECONCILIATION_IMPORT', label: '上載月報對數' },
  { action: 'FEE_ITEM_LIST_PRICE_SET', label: '設定項目標準價' },
  // ★ cwi-audit-20260824-s1: Apricot 寫入（write-booking.ts）— 病人預約寫入，必須審計
  { action: 'REMOVE', label: '刪單（Apricot 寫入）' },
  { action: 'RESCHEDULE', label: '改期（Apricot 寫入）' },
  // ★ providerslot-20260830 T1: 可約時段硬保留（ProviderHold）— 病人位佔用，必須審計
  { action: 'PROVIDER_HOLD_CLAIM', label: '新增硬保留（claim）' },
  { action: 'PROVIDER_HOLD_COMMIT', label: '硬保留入 Apricot（commit）' },
  { action: 'PROVIDER_HOLD_RELEASE', label: '放開硬保留（release）' },
  { action: 'PROVIDER_HOLD_AUTO_RELEASE', label: '硬保留逾時自動放開' },
]

export const SENSITIVE_AUDIT_EXEMPT = new Set([
  'LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'PASSWORD_RESET',
  'FACE_VERIFY', 'FACE_FRAME_VIEW', 'FACE_REF_VIEW',
  'WAGE_SNAPSHOT', 'MUTATE', 'UPSERT',
  'FACE_ENROLL', 'FACE_ENROLL_CODE_ISSUED', // routine face enrollment steps
  // ★ 2026-08-19: External duty-roster API（wa-inbox 專用）— metadata-only audit，冇員工 PII
  'EXTERNAL_DUTY_ROSTER_READ', 'EXTERNAL_DUTY_ROSTER_AUTH_FAIL',
  // ★ cwi-refresh-20260831: External availability/refresh（wa-inbox 專用）—
  // 只觸發單日 cache re-sync（零 PII 槽格），notes 只記 dates+ok/error code
  'EXTERNAL_AVAILABILITY_REFRESH',
])
