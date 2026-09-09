import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { validateMiscIncome, miscIncomeScopeClinics, serializeMiscIncome } from '@/lib/misc-income'
import { resolveMethodRule } from '@/lib/apricot/allocate'

// ============================================================
// /api/misc-income — 店舖雜項收入（cwm-payoutxlsx-20260908 D2）
// GET    ?clinicId=&periodMonth=  列表（void 行照返，前端灰線顯示用）
//   ★ 每行帶 feePercent —— server 端用同一個 resolveMethodRule resolve（D3：
//     前端三行合計/手續費/淨額直接用 API 值，唔好前端重算兩邊唔同數；
//     規則其後被刪 = null（讀取時無規則，顯示按 0 計））
// POST   新增
// Roles: OWNER, MANAGER + cost_entry 權限覆蓋（RBAC_PERM_OVERRIDES）
// ★ periodMonth 恆由 server 從 incomeAt（HK 時區）derive —— 前端傳都忽略
// ============================================================

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const sp = new URL(req.url).searchParams
  const clinicId = sp.get('clinicId')
  const periodMonth = sp.get('periodMonth')

  const scopeClinics = await miscIncomeScopeClinics(session, scope, session.clinics)

  const where: Record<string, unknown> = {}
  if (scopeClinics) {
    // ★ fail-closed：scope 外嘅 clinicId filter 降級為全 scope（唔會突破）
    where.clinicId = clinicId && scopeClinics.includes(clinicId) ? clinicId : { in: scopeClinics }
  } else if (clinicId) {
    where.clinicId = clinicId
  }
  if (periodMonth) where.periodMonth = periodMonth
  // ★ void 行照返（isVoid 唔做 filter）

  const rows = await prisma.miscIncome.findMany({
    where,
    orderBy: [{ incomeAt: 'desc' }, { id: 'desc' }],
  })

  // ★ feePercent：同 POST 驗證同一個 resolveMethodRule（methodNorm + incomeAt）——
  //   讀取時規則已刪 → needsReview → null（前端按 0 計；寫入時仍會 400 擋未知方法）
  const allRules = await prisma.paymentMethodRule.findMany()
  return jsonNoStore({
    items: rows.map(r => {
      const rule = resolveMethodRule(r.methodNorm, r.incomeAt, allRules)
      return { ...serializeMiscIncome(r), feePercent: rule.needsReview ? null : rule.feePercent }
    }),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = null
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: '請求格式錯誤' }, { status: 400 })
  }

  const scopeClinics = await miscIncomeScopeClinics(session, scope, session.clinics)
  const allRules = await prisma.paymentMethodRule.findMany()
  const v = validateMiscIncome(body as Record<string, unknown>, allRules)
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: 400 })
  }

  // ★ scope guard：診所必須喺 session scope 內
  if (scopeClinics && !scopeClinics.includes(v.data.clinicId)) {
    return NextResponse.json(
      { error: 'You do not have access to this clinic' },
      { status: 403 },
    )
  }

  const row = await prisma.miscIncome.create({
    data: {
      clinicId: v.data.clinicId,
      incomeAt: v.data.incomeAt,
      category: v.data.category,
      itemName: v.data.itemName,
      note: v.data.note,
      methodNorm: v.data.methodNorm,
      amount: v.data.amount,
      periodMonth: v.data.periodMonth, // ★ server derive
      createdBy: session.userId,
    },
  })

  // ★ audit（MISC_INCOME_CREATE — SENSITIVE_AUDIT_SPEC）
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'MISC_INCOME_CREATE',
      entity: 'MiscIncome',
      entityId: row.id,
      clinicId: row.clinicId,
      afterJson: JSON.stringify(serializeMiscIncome(row)),
      notes: `新增雜項收入: ${row.itemName} $${row.amount} (${row.periodMonth})`,
    },
  } as any)

  return NextResponse.json(
    { item: serializeMiscIncome(row) },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  )
}
