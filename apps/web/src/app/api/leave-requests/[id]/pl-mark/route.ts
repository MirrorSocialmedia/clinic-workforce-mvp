export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
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
// ============================================================
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const permCheck = await requirePerm(req, 'scheduling')
  if (isAuthError(permCheck)) return permCheck.error

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
    },
  })
  if (!lr) return NextResponse.json({ error: '搵唔到假期記錄' }, { status: 404 })

  // ★ 拍板②：只准 REST_DAY
  if (lr.leaveType?.systemKey !== 'REST_DAY') {
    return NextResponse.json({ error: 'PL 只可以標喺休息日' }, { status: 400 })
  }

  // ★ 2026-08-21 拍板①：PL 純標示、零下游影響 —— 唔限診所。
  //   排班頁本身可以跨店排更，標記冇理由比排更更嚴。
  //   權限仍然靠 requirePerm('scheduling')（上面已經行咗）。

  const updated = await prisma.leaveRequest.update({
    where: { id },
    data: { isEmployeeRequested: next },
    select: { id: true, isEmployeeRequested: true },
  })
  return jsonNoStore(updated)
}
