import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/fee-item-list-prices — List all standard prices
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const items = await prisma.feeItemListPrice.findMany({
    orderBy: [{ feeItemCode: 'asc' }, { effectiveFrom: 'desc' }],
  })

  const serialized = items.map((i: any) => ({
    ...i,
    listPrice: Number(i.listPrice),
    effectiveFrom: i.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: i.effectiveTo ? i.effectiveTo.toISOString().slice(0, 10) : null,
  }))

  return jsonNoStore({ items: serialized })
}

// ============================================================
// POST /api/fee-item-list-prices — Create
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  const body = await req.json()
  const { feeItemCode, label, listPrice, effectiveFrom, effectiveTo } = body

  if (!feeItemCode || !label || listPrice == null || !effectiveFrom) {
    return NextResponse.json({ error: 'feeItemCode, label, listPrice, effectiveFrom required' }, { status: 400 })
  }

  const item = await prisma.feeItemListPrice.create({
    data: {
      feeItemCode,
      label,
      listPrice: Number(listPrice),
      effectiveFrom: new Date(effectiveFrom),
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
      createdBy: auth.session.userId,
    },
  })

  return NextResponse.json({ item }, { status: 201 })
}

// ============================================================
// PATCH /api/fee-item-list-prices/:id — Update
// ============================================================
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req, 'PATCH', req.url)
  if (isAuthError(auth)) return auth.error

  // Extract id from URL path
  const url = new URL(req.url)
  const id = url.pathname.split('/').pop()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const body = await req.json()
  const { label, listPrice, effectiveFrom, effectiveTo } = body

  const item = await prisma.feeItemListPrice.update({
    where: { id },
    data: {
      ...(label != null && { label }),
      ...(listPrice != null && { listPrice: Number(listPrice) }),
      ...(effectiveFrom != null && { effectiveFrom: new Date(effectiveFrom) }),
      ...(effectiveTo != null && { effectiveTo: new Date(effectiveTo) }),
    },
  })

  return NextResponse.json({ item })
}

// ============================================================
// DELETE /api/fee-item-list-prices/:id — Delete
// ============================================================
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error

  const url = new URL(req.url)
  const id = url.pathname.split('/').pop()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  await prisma.feeItemListPrice.delete({ where: { id } })

  return NextResponse.json({ success: true })
}
