// ★ cwm-labdoc P2：GET /api/lab-docs/:id/groups/:g/candidates — 病人配對＋候選成本（§6.5、§7.3）
//
// 權限：lab_invoice；全集團範圍（B16）＋ clinicId 範圍檢查（同 [id] 詳情）。
// 參數：g = 分組 index（0 起）；?code= 員工揀咗「其他前綴」後傳入嘅 patientCodeNorm（重算候選）。
//
// 注意（RBAC matrix）：normalizeRoute 只將 ≥3 位純數字變 :id — 1–2 位 group index 係字面量，
// 所以要逐個登記 0–10（>10 分組 = matrix miss → 403 fail-closed；decision log）。
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { jsonNoStore } from '@/lib/api-response'
import { getCandidatesForGroup } from '@/lib/labdoc/candidates'

const DOC_ID_RE = /^[a-z0-9]{25}$/

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; g: string } },
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return jsonNoStore({ error: '冇任何診所範圍，唔可以睇單據' }, { status: 403 })
  }

  const { id, g } = params
  if (!DOC_ID_RE.test(id)) {
    return NextResponse.json({ error: '單據 ID 格式錯誤' }, { status: 400 })
  }
  const groupIndex = Number(g)
  if (!Number.isInteger(groupIndex) || groupIndex < 0) {
    return NextResponse.json({ error: '分組編號格式錯' }, { status: 400 })
  }

  const doc = await prisma.labDocument.findUnique({ where: { id }, select: { clinicId: true, kind: true, status: true } })
  if (!doc) return jsonNoStore({ error: '單據唔存在' }, { status: 404 })
  if (scope !== null && !(doc.clinicId && scope.includes(doc.clinicId))) {
    return jsonNoStore({ error: '單據唔存在' }, { status: 404 })
  }
  if (doc.kind !== 'INVOICE') {
    return jsonNoStore({ error: '月結單唔適用候選成本' }, { status: 400 })
  }

  const codeOverride = req.nextUrl.searchParams.get('code')
  const clinic = doc.clinicId ? await prisma.clinic.findUnique({ where: { id: doc.clinicId }, select: { shortName: true } }) : null

  const res = await getCandidatesForGroup(id, groupIndex, {
    clinicShortName: clinic?.shortName ?? null,
    codeOverride: codeOverride || null,
  })
  if (!res) return jsonNoStore({ error: '單據唔存在' }, { status: 404 })

  return jsonNoStore(res)
}
