export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { resolveCompanyScopeForScheduling, companyInScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// /api/scheduling-memo — 排班頁月備註（拍板 2026-08-21：新表、按公司）
// ★ 只做記事 —— 唔入計糧／唔入 audit／唔影響任何計算
//
// GET ?companyId=&periodMonth=YYYY-MM → { text, updatedAt }（冇 row → text:''）
// PUT { companyId, periodMonth, text } → upsert；空白 = delete（同 ScheduleNote 一致）
//
// 權限：scheduling（RBAC 雙表登記）。
// 公司 scope：OWNER 全公司；其他角色只可以寫自己被指派診所所屬嘅公司
//   （拍板：MANAGER 唔可以寫其他公司 → 403）
// ★ 2026-08-21 補充：用 resolveCompanyScopeForScheduling（帶 MANAGER 無 UserClinic
//   嘅 homeClinic fallback）—— 純 resolveAccessibleCompanyIds 只睇 UserClinic，
//   無 UserClinic 嘅 MANAGER 會空陣列 → 連自己公司都 403。
// ============================================================

const MAX_LEN = 500
const PERIOD_MONTH_RE = /^\d{4}-\d{2}$/

export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const sp = new URL(req.url).searchParams
  const companyId = sp.get('companyId')
  const periodMonth = sp.get('periodMonth') ?? ''

  // ★ 參數缺失/格式錯 → 按「冇備註」回（純顯示用途，唔好 400 攞走整頁）
  if (!companyId || !PERIOD_MONTH_RE.test(periodMonth)) {
    return jsonNoStore({ text: '', updatedAt: null })
  }

  // ★ 公司 scope —— MANAGER 唔可以讀其他公司（帶 homeClinic fallback）
  const scope = await resolveCompanyScopeForScheduling(session.userId, session.role)
  if (!companyInScope(scope, companyId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const row = await prisma.schedulingMemo.findUnique({
    where: { companyId_periodMonth: { companyId, periodMonth } },
    select: { text: true, updatedAt: true },
  })
  return jsonNoStore(row ?? { text: '', updatedAt: null })
}

export async function PUT(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json().catch(() => ({}))
  const { companyId, periodMonth, text } = body

  if (!PERIOD_MONTH_RE.test(String(periodMonth ?? ''))) {
    return NextResponse.json({ error: 'periodMonth 格式要 YYYY-MM' }, { status: 400 })
  }
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }
  // ★ 上限 —— 純文字欄唔可以無上限（防貼成篇嘢入去）
  const clean = String(text ?? '').slice(0, MAX_LEN)

  // ★ 公司 scope —— MANAGER 唔可以寫其他公司（拍板 2026-08-21；帶 homeClinic fallback）
  const scope = await resolveCompanyScopeForScheduling(session.userId, session.role)
  if (!companyInScope(scope, companyId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ★ 空白 = 刪 —— 同 ScheduleNote 一致，唔留空字串 row
  if (!clean.trim()) {
    await prisma.schedulingMemo.deleteMany({ where: { companyId, periodMonth } })
    return jsonNoStore({ text: '' })
  }

  const saved = await prisma.schedulingMemo.upsert({
    where: { companyId_periodMonth: { companyId, periodMonth } },
    update: { text: clean, updatedBy: session.userId },
    create: { companyId, periodMonth, text: clean, updatedBy: session.userId },
    select: { text: true, updatedAt: true },
  })
  return jsonNoStore(saved)
}
