// ★ cwm-labdoc P1：GET /api/lab-docs/files/:fileId/original
// 解密後原檔（PDF 或 JPEG，§4.3）— 只可以由 LabFile.storageKey 讀
// 回應：inline（Content-Type = 原檔 mime）+ Cache-Control: private, no-store + nosniff
// 已 purge（purgedAt != null）→ 410
// audit：LAB_DOC_FILE_DOWNLOAD（§14 EXEMPT — fileId only，零姓名）
// 權限：lab_invoice 或 lab_statement（§10.2 檔案庫行 ✅✅）；全集團範圍（B16）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { readEncrypted } from '@/lib/labdoc/storage'
import { labdocAudit } from '@/lib/labdoc/audit'

const FILE_ID_RE = /^[a-z0-9]{25}$/

/** HK wall-clock YYYY-MM-DD（同 app 慣例） */
function hkDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

export async function GET(
  req: NextRequest,
  { params }: { params: { fileId: string } },
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  // §10.3：所有 labdoc route 用 resolveClinicScope — 有 lab 權限 = 全集團（B16）
  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以下載' }, { status: 403 })
  }

  const { fileId } = params
  if (!FILE_ID_RE.test(fileId)) {
    return NextResponse.json({ error: '檔案 ID 格式錯誤' }, { status: 400 })
  }

  const file = await prisma.labFile.findUnique({
    where: { id: fileId },
    include: { pages: { select: { documentId: true } } },
  })
  if (!file) return NextResponse.json({ error: '檔案唔存在' }, { status: 404 })
  if (file.pages.length === 0) {
    return NextResponse.json({ error: '檔案唔存在' }, { status: 404 })
  }

  // 已到期 → 410（§4.3）
  if (file.purgedAt) {
    return NextResponse.json(
      { error: `原檔已按保留政策（7 年）於 ${hkDate(file.purgedAt)} 刪除` },
      { status: 410 },
    )
  }

  // 有限範圍用戶：檔要屬於範圍內嘅單據先俾下載（fail-closed）
  let docClinicId: string | null = null
  if (scope !== null) {
    const docs = await prisma.labDocument.findMany({
      where: { id: { in: file.pages.map((p) => p.documentId) }, clinicId: { in: scope } },
      select: { clinicId: true },
    })
    if (docs.length === 0) return NextResponse.json({ error: '檔案唔存在' }, { status: 404 })
    docClinicId = docs[0].clinicId
  }

  let buf: Buffer
  try {
    buf = await readEncrypted(file.storageKey)
  } catch (e) {
    console.error('[labdoc/files] 讀原檔失敗', { fileId, err: (e as Error)?.message })
    return NextResponse.json({ error: '讀檔失敗，請重試' }, { status: 500 })
  }

  const ext = file.mime === 'application/pdf' ? 'pdf' : 'jpg'
  const res = new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': file.mime,
      'Content-Length': String(buf.length),
      'Content-Disposition': `inline; filename="labdoc-${fileId}.${ext}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })

  // §14：LAB_DOC_FILE_DOWNLOAD（EXEMPT；fileId only）
  await labdocAudit({
    action: 'LAB_DOC_FILE_DOWNLOAD',
    entity: 'LabFile',
    entityId: fileId,
    actorId: session.userId,
    clinicId: docClinicId,
    ipAddress: req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || null,
    userAgent: req.headers.get('user-agent') || null,
    after: { fileId },
  }).catch((e) => {
    // audit 失敗唔擋下載（file 已讀出）— 但必留 log
    console.error('[labdoc/files] LAB_DOC_FILE_DOWNLOAD audit 失敗', e)
  })

  return res
}
