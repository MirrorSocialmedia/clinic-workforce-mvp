// ★ cwm-money-20260917 P2-7：計糧 run-lock 統一守衛。
// rev.1 假設 guardPayrollLock 係既有 function（原單 P1 遺留依賴）——全 repo 實查唔存在。
// CEO 2026-09-17 判定：按 rev.1 語義新建最小版（本檔）。
//
// 語義：dates 涉及嘅任何 periodMonth（YYYY-MM）有 PayrollRun status in [FINALIZED, EXPORTED]
//       → 409（該月計糧已確認／已匯出，唔可以再改）；冇 → null。
//
// 對齊既有模式：
// - periodMonth match 用 `hkDateOnly(\`${pm}-01\`)`（跟 holiday-ot-adjustments self-guard）。
// - match 只按 periodMonth + status in [FINALIZED, EXPORTED]，**無 clinic filter**：
//   跟舊 self-guard 口徑（rev.1 意圖「已出糧月份唔准再改」，保守 = 舊行為 + EXPORTED）。
//   ⚠️ CTO-3 2026-09-17 收窄：初版跟 shifts 警告模式加咗 clinic OR
//   `[{clinicId: null}, {clinicId: employee.homeClinicId}]` —— 但 run 係 clinic-scoped
//   而員工 homeClinic 唔同（轉铺／多店）就 match 唔到 → 已 FINALIZED 月份照改到（G1 實測 200）。
//   刪走 clinic OR：任何該月已出糧 run 都鎖住所有員工嘅該月寫入。
// - audit：shifts 守衛 block 時寫 AuditLog（SHIFT_EDIT_AFTER_PAYROLL）→ 呢度跟上，
//   寫 PAYROLL_LOCK_BLOCKED（已入 SENSITIVE_AUDIT_SPEC）。audit 寫入失敗只 log 唔阻擋 409。
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateOnly, toHKDateStr } from '@/lib/hk-date'

/**
 * 計糧 run-lock 守衛：該月計糧已確認（FINALIZED）／已匯出（EXPORTED）就回 409。
 * match 只按 periodMonth + status（無 clinic filter —— 已出糧月份，所有員工都鎖）。
 *
 * @param session   認證 session（actorId 落 audit；RBAC 由 caller route 負責）
 * @param employeeId 受影響員工（落 audit；唔影響 match 範圍）
 * @param dates     ['YYYY-MM-DD', ...] 涉及日期
 * @param what      audit label，例 '假期返工 OT 扣減'
 * @returns 409 NextResponse（已鎖）或 null（未鎖，可繼續）
 */
export async function guardPayrollLock(
  session: { userId: string; role: string },
  employeeId: string,
  dates: string[],
  what: string,
): Promise<NextResponse | null> {
  // 涉及嘅 periodMonth（YYYY-MM）去重；空 / 格式錯 → 唔 check（input 驗證係 caller 嘅事）
  const pms = [...new Set(dates.map(d => String(d ?? '').slice(0, 7)))].filter(Boolean)
  if (pms.length === 0) return null

  const runs = await prisma.payrollRun.findMany({
    where: {
      periodMonth: { in: pms.map(pm => hkDateOnly(`${pm}-01`)) },
      status: { in: ['FINALIZED', 'EXPORTED'] },
    },
    select: { id: true, status: true, periodMonth: true },
  })
  if (runs.length === 0) return null

  const months = [...new Set(
    runs.map(r => toHKDateStr(r.periodMonth).slice(0, 7)),
  )]
  const hasExported = runs.some(r => r.status === 'EXPORTED')
  const stateWord = hasExported ? '已確認或已匯出' : '已確認'

  // audit：記錄被擋嘅寫入（跟 SHIFT_EDIT_AFTER_PAYROLL 模式；try/catch 令 audit 失敗唔變 500）
  try {
    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: 'PAYROLL_LOCK_BLOCKED',
        entity: 'PayrollRun',
        entityId: runs[0].id,
        targetEmployeeId: employeeId,
        notes: `${what} 被擋：${months.join('、')} 計糧${stateWord}，唔可以再改（runs: ${runs.map(r => r.id).join(', ')}）`,
      },
    })
  } catch (e) {
    console.error(`[payroll-lock] audit write failed (action=PAYROLL_LOCK_BLOCKED)`, e)
  }

  return NextResponse.json(
    { error: `${months.join('、')} 計糧${stateWord} —— 唔可以再改，請先喺計糧退回草稿` },
    { status: 409 },
  )
}
