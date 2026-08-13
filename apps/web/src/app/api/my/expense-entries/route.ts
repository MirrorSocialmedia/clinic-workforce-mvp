import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr, getMonthRange } from '@/lib/hk-date'

// ============================================================
// POST /api/my/expense-entries — 員工自助申請雜項報銷
// Body: { periodMonth, amount, description, clinicId? }
// ★ employeeId 由 session 反查，唔可以由 body 傳
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  // ★ employeeId 由 session 反查
  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
    select: { id: true },
  })
  if (!employee) {
    return jsonNoStore({ error: '搵唔到員工檔案' }, { status: 400 })
  }

  const { periodMonth, amount, description, clinicId } = await req.json()

  // 守衛 1：金額
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) {
    return jsonNoStore({ error: '金額唔正確' }, { status: 400 })
  }
  if (amt > 5000) {
    return jsonNoStore({ error: '單筆超過 $5,000 請交經理代入' }, { status: 400 })
  }

  // 守衛 2：只准當月同上月
  const now = toHKDateStr(new Date()).slice(0, 7)
  const [y, m] = now.split('-').map(Number)
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
  if (periodMonth !== now && periodMonth !== prev) {
    return jsonNoStore({ error: '只可以申請當月或上月' }, { status: 400 })
  }

  // 守衛 3：已出糧月份唔准報
  const { start: pm } = getMonthRange(new Date(`${periodMonth}-01T00:00:00+08:00`))
  const locked = await prisma.payrollRun.findFirst({
    where: {
      periodMonth: pm,
      status: { in: ['FINALIZED', 'EXPORTED'] },
    },
    select: { id: true },
  })
  if (locked) {
    return jsonNoStore({ error: `${periodMonth} 已出糧，請交經理處理` }, { status: 409 })
  }

  if (!description || String(description).trim().length < 2) {
    return jsonNoStore({ error: '請填寫用途' }, { status: 400 })
  }

  const entry = await prisma.expenseEntry.create({
    data: {
      employeeId: employee.id,
      clinicId: clinicId ?? null,
      periodMonth,
      amount: amt,
      description: String(description).trim(),
      status: 'PENDING',
      submittedBy: session.userId,
      createdBy: session.userId,
    },
  })

  return jsonNoStore({ entry })
}

// ============================================================
// GET /api/my/expense-entries — 查看自己嘅申請記錄
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const employee = await prisma.employee.findUnique({
    where: { userId: session.userId },
    select: { id: true },
  })
  if (!employee) return jsonNoStore({ entries: [] })

  const entries = await prisma.expenseEntry.findMany({
    where: { employeeId: employee.id },
    orderBy: [{ periodMonth: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  })

  return jsonNoStore({ entries })
}
