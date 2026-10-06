// ★ cwm-labdoc P4 CHUNK 2：GET /api/lab-aliases — §11 alias 管理 list（lab_statement）
//
// 四種 alias 表統一 list（§11：LabAlias、LabCustomerNo、ClinicNameAlias、ProviderNameAlias）：
//   ?type=LabAlias|LabCustomerNo|ClinicNameAlias|ProviderNameAlias（唔傳 = 全部四種）
//   ?labId=<cuid>（可選 — 只對 LabAlias／LabCustomerNo 有效；其餘 type 傳 labId = 400）
// 統一 row 形狀（設定頁 /lab-docs/settings 每 Lab 一卡直接渲染）：
//   { type, id, labId?, labName?, kind? (LabAlias), rawNorm? / customerNo?, clinicId?, clinicName?, providerId?, providerName?, createdBy, createdAt }
// alias 重記 = P2 assign「記住」已有（本 route 只 list／delete — §11「只刪」）
// 權限：lab_statement（§10.2「alias 管理」）— RBAC_MATRIX + RBAC_PERM_OVERRIDES 雙登記
// ownership-ok: alias 係 Lab／診所／醫生維度（全集團），冇病人數據
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

export const ALIAS_TYPES = ['LabAlias', 'LabCustomerNo', 'ClinicNameAlias', 'ProviderNameAlias'] as const
export type AliasType = (typeof ALIAS_TYPES)[number]

const LAB_ID_RE = /^[a-z0-9]{25}$/
const MAX_LIMIT = 500

export interface AliasRow {
  type: AliasType
  id: string
  labId: string | null
  labName: string | null
  /** LabAlias only：NAME_EN | NAME_CN | PAYEE */
  kind: string | null
  /** LabAlias／ClinicNameAlias／ProviderNameAlias 嘅正規化名 */
  rawNorm: string | null
  /** LabCustomerNo only */
  customerNo: string | null
  clinicId: string | null
  clinicName: string | null
  providerId: string | null
  providerName: string | null
  createdBy: string
  createdAt: string
}

async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { perms } = auth
  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const typeParam = sp.get('type') ?? ''
  let types: AliasType[]
  if (typeParam === '') {
    types = [...ALIAS_TYPES]
  } else if ((ALIAS_TYPES as readonly string[]).includes(typeParam)) {
    types = [typeParam as AliasType]
  } else {
    return jsonNoStore(
      { error: `type 必須係 ${ALIAS_TYPES.join(' / ')}（或唔傳 = 全部）` },
      { status: 400 },
    )
  }

  const labId = sp.get('labId') ?? ''
  if (labId !== '') {
    if (!LAB_ID_RE.test(labId)) return jsonNoStore({ error: 'labId 格式錯誤' }, { status: 400 })
    if (types.includes('ClinicNameAlias') || types.includes('ProviderNameAlias')) {
      return jsonNoStore({ error: 'labId filter 唔适用 ClinicNameAlias / ProviderNameAlias（佢哋冇 Lab 維度）' }, { status: 400 })
    }
  }

  const limitRaw = Number(sp.get('limit') ?? MAX_LIMIT)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : MAX_LIMIT))

  const rows: AliasRow[] = []

  if (types.includes('LabAlias')) {
    const labAliases = await prisma.labAlias.findMany({
      where: labId ? { labId } : undefined,
      include: { lab: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
    for (const a of labAliases) {
      rows.push({
        type: 'LabAlias',
        id: a.id,
        labId: a.labId,
        labName: a.lab.name,
        kind: a.kind,
        rawNorm: a.rawNorm,
        customerNo: null,
        clinicId: null,
        clinicName: null,
        providerId: null,
        providerName: null,
        createdBy: a.createdBy,
        createdAt: a.createdAt.toISOString(),
      })
    }
  }

  if (types.includes('LabCustomerNo')) {
    const custNos = await prisma.labCustomerNo.findMany({
      where: labId ? { labId } : undefined,
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
    const clinicIds = [...new Set(custNos.map((c) => c.clinicId))]
    const clinicMap = new Map(
      (await prisma.clinic.findMany({ where: { id: { in: clinicIds } }, select: { id: true, name: true } })).map(
        (c) => [c.id, c.name],
      ),
    )
    for (const c of custNos) {
      rows.push({
        type: 'LabCustomerNo',
        id: c.id,
        labId: c.labId,
        labName: null,
        kind: null,
        rawNorm: null,
        customerNo: c.customerNo,
        clinicId: c.clinicId,
        clinicName: clinicMap.get(c.clinicId) ?? null,
        providerId: c.providerId,
        providerName: null,
        createdBy: c.createdBy,
        createdAt: c.createdAt.toISOString(),
      })
    }
  }

  if (types.includes('ClinicNameAlias')) {
    const cnAliases = await prisma.clinicNameAlias.findMany({
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
    const cnIds = [...new Set(cnAliases.map((a) => a.clinicId))]
    const cnMap = new Map(
      (await prisma.clinic.findMany({ where: { id: { in: cnIds } }, select: { id: true, name: true } })).map(
        (c) => [c.id, c.name],
      ),
    )
    for (const a of cnAliases) {
      rows.push({
        type: 'ClinicNameAlias',
        id: a.id,
        labId: null,
        labName: null,
        kind: null,
        rawNorm: a.rawNorm,
        customerNo: null,
        clinicId: a.clinicId,
        clinicName: cnMap.get(a.clinicId) ?? null,
        providerId: null,
        providerName: null,
        createdBy: a.createdBy,
        createdAt: a.createdAt.toISOString(),
      })
    }
  }

  if (types.includes('ProviderNameAlias')) {
    const pnAliases = await prisma.providerNameAlias.findMany({
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
    const pnIds = [...new Set(pnAliases.map((a) => a.providerId))]
    const pnMap = new Map(
      (await prisma.provider.findMany({ where: { id: { in: pnIds } }, select: { id: true, name: true } })).map(
        (p) => [p.id, p.name],
      ),
    )
    for (const a of pnAliases) {
      rows.push({
        type: 'ProviderNameAlias',
        id: a.id,
        labId: null,
        labName: null,
        kind: null,
        rawNorm: a.rawNorm,
        customerNo: null,
        clinicId: null,
        clinicName: null,
        providerId: a.providerId,
        providerName: pnMap.get(a.providerId) ?? null,
        createdBy: a.createdBy,
        createdAt: a.createdAt.toISOString(),
      })
    }
  }

  return jsonNoStore({ count: rows.length, aliases: rows })
}

export { GET }
