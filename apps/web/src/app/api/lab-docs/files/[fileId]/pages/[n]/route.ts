// ★ cwm-labdoc P1：GET /api/lab-docs/files/:fileId/pages/:n?v=thumb|display
// 解密後頁面圖（§4.3）— 只可以由 LabFile.pagesJson 讀，唔准 query/檔名拼路徑
// 回應：inline JPEG + Cache-Control: private, no-store + X-Content-Type-Options: nosniff
// 已 purge（purgedAt != null）→ 410
// 權限：lab_invoice 或 lab_statement（§10.2 檔案庫行 ✅✅）；全集團範圍（B16）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { readEncrypted } from '@/lib/labdoc/storage'

const FILE_ID_RE = /^[a-z0-9]{25}$/
const PDF_MAX_PAGES = 30 // 同 §4.2 上限

/** HK wall-clock YYYY-MM-DD（同 app 慣例） */
function hkDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function imgResponse(buf: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(buf.length),
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function GET(
  req: NextRequest,
  { params }: { params: { fileId: string; n: string } },
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  // §10.3：所有 labdoc route 用 resolveClinicScope — 有 lab 權限 = 全集團（B16）
  const scope = await resolveClinicScope(session, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ error: '冇任何診所範圍，唔可以睇檔' }, { status: 403 })
  }

  const { fileId, n } = params
  if (!FILE_ID_RE.test(fileId)) {
    return NextResponse.json({ error: '檔案 ID 格式錯誤' }, { status: 400 })
  }
  const pageNo = Number(n)
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > PDF_MAX_PAGES) {
    return NextResponse.json({ error: `頁碼要係 1–${PDF_MAX_PAGES} 整數` }, { status: 400 })
  }
  const v = req.nextUrl.searchParams.get('v') ?? 'display'
  if (v !== 'thumb' && v !== 'display') {
    return NextResponse.json({ error: 'v 要係 thumb 或 display' }, { status: 400 })
  }

  const file = await prisma.labFile.findUnique({
    where: { id: fileId },
    include: { pages: { select: { documentId: true } } },
  })
  if (!file) return NextResponse.json({ error: '檔案唔存在' }, { status: 404 })

  // 檔要屬於至少一張單據（無主檔唔俾睇 — 正常流程 DB commit 先至有 pages）
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

  // 有限範圍用戶：檔要屬於範圍內嘅單據先睇到（fail-closed）
  if (scope !== null) {
    const inScope = await prisma.labDocument.count({
      where: { id: { in: file.pages.map((p) => p.documentId) }, clinicId: { in: scope } },
    })
    if (inScope === 0) return NextResponse.json({ error: '檔案唔存在' }, { status: 404 })
  }

  // 頁 key 只由 pagesJson 讀（§4.1：唔准 query/檔名拼路徑）
  const pj = (file.pagesJson ?? []) as Array<{ page: number; displayKey?: string; thumbKey?: string }>
  const page = pj.find((p) => p.page === pageNo)
  const key = v === 'thumb' ? page?.thumbKey : page?.displayKey
  if (!page || !key) {
    return NextResponse.json({ error: '頁面唔存在' }, { status: 404 })
  }

  let buf: Buffer
  try {
    buf = await readEncrypted(key)
  } catch (e) {
    console.error('[labdoc/files] 讀頁失敗', { fileId, pageNo, v, err: (e as Error)?.message })
    return NextResponse.json({ error: '讀檔失敗，請重試' }, { status: 500 })
  }

  return imgResponse(buf, `labdoc-${fileId}-p${pageNo}.jpg`)
}
