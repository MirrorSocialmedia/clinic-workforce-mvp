export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { resolveCompanyScopeForScheduling, companyInScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// PATCH /api/leave-requests/[id]/pl-mark — 切換 PL 標記（員工自請休息日）
// 拍板 2026-08-21：
//   ① 純顯示標示，零下游影響（計糧／額度／時間帳戶全都不讀呢個欄）
//   ② 只准 REST_DAY —— server 擋（前端擋咗都係要擋，防直接 call API 繞過）
//   ③ 明文收 body.value === true（唔好 toggle —— server 唔知 client 見到嘅狀態）
//   ④ scheduling 權限
//   ⑤ 唔寫 explicit audit —— LeaveRequest 已喺 AUDIT_ENTITIES，
//      extension 會自動記一筆 append-only audit（MD §2.1 #4 建議 (a)：一致性優先）
//   ⑥ 2026-08-21 拍板①補充：唔限【診所】但限【公司】（公司層 ownership guard，
//      同時令 scripts/check-ownership.sh 過關）
// ============================================================
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const permCheck = await requirePerm(req, 'scheduling')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const { id } = params
  const body = await req.json().catch(() => ({}))
  // ★ 明文 boolean：server 永遠收目標值，並發唔會反轉錯
  const next = body?.value === true

  const lr = await prisma.leaveRequest.findUnique({
    where: { id },
    select: {
      id: true,
      isEmployeeRequested: true,
      leaveType: { select: { systemKey: true } },
      // ★ 下面公司層 ownership guard 用（employee 主屬店所屬公司）；
      //   clinicId 留低 —— check-ownership.sh 嘅 guard 關鍵字 + 日誌除錯
      clinicId: true,
      employee: { select: { homeClinic: { select: { companyId: true } } } },
    },
  })
  if (!lr) return NextResponse.json({ error: '搵唔到假期記錄' }, { status: 404 })

  // ★ 拍板②：只准 REST_DAY
  if (lr.leaveType?.systemKey !== 'REST_DAY') {
    return NextResponse.json({ error: 'PL 只可以標喺休息日' }, { status: 400 })
  }

  // ★ 2026-08-21 拍板①：唔限【診所】（跨店照標 —— 排班頁本身可以跨店排更，
  //   標記冇理由比排更更嚴），但仍然限【公司】。
  //   純標示都唔應該跨公司；亦係 check-ownership.sh 要求嘅 ownership guard。
  //   ★ 用 resolveCompanyScopeForScheduling（= resolveAccessibleCompanyIds +
  //     MANAGER 無 UserClinic 時由 Employee.homeClinicId 回落自家公司），
  //     否則無 UserClinic 嘅 MANAGER 會連自己公司都 403。
  const companyIds = await resolveCompanyScopeForScheduling(session.userId, session.role)
  const targetCompany = lr.employee?.homeClinic?.companyId
  if (!targetCompany || !companyInScope(companyIds, targetCompany)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const updated = await prisma.leaveRequest.update({
    where: { id },
    data: { isEmployeeRequested: next },
    select: { id: true, isEmployeeRequested: true },
  })
  return jsonNoStore(updated)
}
