export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requirePerm, requireAnyPerm, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { findDuplicateProviderAccounts } from '@/lib/apricot-accounts'

export async function GET(req: NextRequest) {
  // ★ 2026-08-22：cost_entry（成本錄入）要揀醫生 —— 同一份讀開多一個權限
  //   （provider_schedule 排前：現有使用者 scope 行為完全唔變）
  const auth = await requireAnyPerm(req, ['provider_schedule', 'cost_entry'])
  if (isAuthError(auth)) return auth.error

  const includeInactive = req.nextUrl.searchParams.get('includeInactive') === '1'
  const providers = await prisma.provider.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      clinics: { select: { clinicId: true } },
      // ★ cwm-apricotacct Stage 2：帳號由 ApricotPractitioner（唯一來源）——
      //   Provider 舊欄已剷走，反查一律經呢度。
      apricotAccounts: {
        where: { kind: 'PROVIDER' },
        select: { apricotId: true, name: true },
        orderBy: { apricotId: 'asc' },
      },
    },
  })
  // Map to flat clinicIds for frontend
  const result = providers.map(p => ({
    ...p,
    clinicIds: p.clinics.map(c => c.clinicId),
    apricotAccounts: p.apricotAccounts.map(({ apricotId, name: acctName }) => ({ apricotId, name: acctName })),
  }))
  // Remove nested clinics from output
  const output = result.map(({ clinics, ...rest }) => rest)
  // ★ C 章（cost-entry）：前端改由 API 回嘅 map 反查 practitioner.id → providerId，
  //   唔好前端自己 hold 帳號清單。一個醫生多個帳號 → 每個帳號都指向同一個 provider。
  const providerByApricotId: Record<string, string> = {}
  for (const p of providers) {
    for (const { apricotId } of p.apricotAccounts) {
      providerByApricotId[apricotId] = p.id
    }
  }
  return jsonNoStore({ providers: output, providerByApricotId })
}

export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'scheduling')
  if (isAuthError(auth)) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { name, shortName, phone, color, apricotAccounts, apricotUserId, companyId, sortOrder, clinicIds, showInCostEntry } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name 必填' }, { status: 400 })
  }

  // ★ F 章：apricotAccounts = [{ apricotId, name? }]（多帳號）；舊單一欄已剷走。
  const accounts: Array<{ apricotId: string; name?: string }> = Array.isArray(apricotAccounts)
    ? apricotAccounts.filter((a: any) => a && typeof a.apricotId === 'string' && a.apricotId.trim()) // ApricotPractitioner 帳號輸入
      .map((a: any) => ({ apricotId: a.apricotId.trim(), name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : undefined })) // ApricotPractitioner 帳號輸入
    : []
  // 重複 apricotId 守衛（同 PUT 共用）
  const dup = await findDuplicateProviderAccounts(prisma, accounts, null)
  if (dup) {
    return NextResponse.json({ error: dup }, { status: 409 })
  }

  // ★ D4: Validate clinicIds exist before creating
  if (Array.isArray(clinicIds) && clinicIds.length) {
    const existingClinics = await prisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: { id: true },
    })
    const validIds = new Set(existingClinics.map((c: any) => c.id))
    const invalidIds = clinicIds.filter((cid: string) => !validIds.has(cid))
    if (invalidIds.length) {
      return NextResponse.json(
        { error: `無效的診所 ID：${invalidIds.join(', ')}` },
        { status: 400 }
      )
    }
  }

  try {
    const provider = await prisma.$transaction(async (tx) => {
      const p = await tx.provider.create({
        data: {
          name: name.trim(),
          shortName: shortName?.trim() || null,
          phone: phone?.trim() || null,
          color,
          apricotUserId: apricotUserId?.trim() || null,
          companyId: companyId || null,
          sortOrder: sortOrder ?? 0,
          // ★ cwm-costentry-20260827 §1：成本錄入顯示開關（唔傳 = schema default true）
          ...(showInCostEntry !== undefined && { showInCostEntry: !!showInCostEntry }),
        },
      })

      // ★ F 章：Apricot 帳號寫新表（kind=PROVIDER）；name 缺省用醫生名
      if (accounts.length > 0) {
        await tx.apricotPractitioner.createMany({
          data: accounts.map(({ apricotId, name: acctName }) => ({
            apricotId,
            name: acctName || name.trim(),
            kind: 'PROVIDER' as const,
            providerId: p.id,
          })),
        })
      }

      if (Array.isArray(clinicIds) && clinicIds.length) {
        await tx.providerClinic.createMany({
          data: clinicIds.map((cid: string) => ({ providerId: p.id, clinicId: cid })),
          skipDuplicates: true,
        })
      }

      return p
    })

    await prisma.auditLog.create({
      data: {
        actorId: auth.session!.userId,
        action: 'PROVIDER_CREATE',
        entity: 'Provider',
        entityId: provider.id,
        notes: `新增醫生：${provider.name}`,
        afterJson: JSON.stringify({ id: provider.id, name: provider.name, apricotAccounts: accounts }),
      },
    }).catch(e => console.error('[providers] audit failed', e))

    // Return with clinicIds + apricotAccounts
    const withRelations = await prisma.provider.findUnique({
      where: { id: provider.id },
      include: {
        clinics: { select: { clinicId: true } },
        apricotAccounts: { where: { kind: 'PROVIDER' }, select: { apricotId: true, name: true } },
      },
    })
    if (!withRelations) return jsonNoStore({ error: '建立失敗' }, { status: 500 })
    return jsonNoStore({
      provider: {
        ...withRelations,
        clinicIds: withRelations.clinics.map(c => c.clinicId),
        apricotAccounts: withRelations.apricotAccounts.map(({ apricotId, name: acctName }) => ({ apricotId, name: acctName })),
        clinics: undefined,
      },
    })
  } catch (e: any) {
    console.error('[providers] POST failed', e)
    // ★ F 章：重複 apricotId 由前置 findDuplicateProviderAccounts 攔咗；
    //   呢度只留 race-condition fallback（同 PUT 一致訊息，唔知邊個 → 通用文案）
    if (e?.code === 'P2002') {
      return NextResponse.json(
        { error: 'Apricot ID 已經綁咗其他帳號（可能係同時編輯），請刷新重試' },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: '建立失敗' }, { status: 500 })
  }
}
