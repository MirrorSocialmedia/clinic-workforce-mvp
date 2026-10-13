/**
 * ★ 2026-10-13：月結單人手改行／加行（AI 讀漏／讀錯 — 用家拍板 1／2／3 全部按建議）
 *   1. 加行：金額必填；單號、日期、項目、病人編號、原因選填；有單號 → 檢查同 Lab 其他有效月結單有冇同一個單號（有 → 問用家）
 *   2. AI 讀到嘅行唔可以刪，只可以改（或者照舊標備貨／唔關我哋事）；人手加嘅行先可以刪
 *   3. 「再讀」前警告：有人手改／加嘅行會清走（retry route）
 *
 * 錢嘅規則：
 *   - 分段（或者「兩份加埋一齊對」組入面任何一段）已確認 → 唔准改
 *   - 文件作廢／被取代／重複 → 唔准改
 *   - 上月結轉副本（carriedFromLineId）→ 要返上月改
 *   - 標咗「計入下個月」嘅行 → 要先取消（下個月副本嘅金額係抄嗰陣嘅）
 *   - 人手配對咗成本嘅行改金額 → 要先「未配對到」（配對嗰陣驗過金額）
 *   - 「以月結單為準」改過系統嘅行 → 唔准改
 *   - 文件 version 樂觀鎖（兩個人同時改 → 後嗰個 409）
 *   - 改完即刻重新對數；audit 記低（唔記病人編號／姓名嘅值）
 */
import { NextResponse } from 'next/server'
import { jsonNoStore } from '@/lib/api-response'
import { labdocScope, kioskDocGuard } from '@/lib/labdoc/kiosk-scope'
import { sectionCombineGroup } from '@/lib/labdoc/statement-combine'
import { normDocNo } from '@/lib/labdoc/identify'
import { NEXT_MONTH } from '@/lib/labdoc/statement-carry'

export const ID_RE = /^[a-z0-9]{25}$/
const INACTIVE_DOC = ['VOID', 'SUPERSEDED', 'DUPLICATE']
const MAX_AMOUNT = 10_000_000

export interface LineInput {
  amount?: number
  docNoRaw?: string | null
  date?: Date | null
  description?: string | null
  patientCode?: string | null
}

/** 驗證 body（requireAmount = 加行）。只回傳有傳入嘅欄位；null／'' = 清空。 */
export function parseLineInput(body: any, opts: { requireAmount: boolean }): { input: LineInput; note: string | null } | { error: string } {
  const input: LineInput = {}
  if (body?.amount !== undefined || opts.requireAmount) {
    const raw = typeof body?.amount === 'string' ? body.amount.replace(/[,\s$]/g, '').replace(/^HK/i, '') : body?.amount
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN
    if (!Number.isFinite(n)) return { error: '金額要係數字' }
    if (Math.abs(n) > MAX_AMOUNT) return { error: '金額太大' }
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { error: '金額最多兩個小數位' }
    input.amount = Math.round(n * 100) / 100
  }
  const str = (k: string, max: number, label: string): string | null | undefined | { error: string } => {
    const v = body?.[k]
    if (v === undefined) return undefined
    if (v === null) return null
    if (typeof v !== 'string') return { error: `${label}格式錯誤` }
    const t = v.trim()
    if (t.length > max) return { error: `${label}最多 ${max} 字` }
    return t === '' ? null : t
  }
  for (const [k, max, label, target] of [
    ['docNo', 50, '單號', 'docNoRaw'],
    ['description', 200, '項目', 'description'],
    ['patientCode', 30, '病人編號', 'patientCode'],
  ] as const) {
    const r = str(k, max, label)
    if (r && typeof r === 'object') return r
    if (r !== undefined) (input as any)[target] = r
  }
  if (body?.date !== undefined) {
    if (body.date === null || body.date === '') input.date = null
    else if (typeof body.date !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(body.date)) return { error: '日期要 YYYY-MM-DD' }
    else {
      const d = new Date(`${body.date}T00:00:00Z`)
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== body.date) return { error: '日期唔存在' }
      input.date = d
    }
  }
  const noteR = str('note', 200, '原因')
  if (noteR && typeof noteR === 'object') return noteR
  return { input, note: (noteR as string | null | undefined) ?? null }
}

/** 共用載入＋權限＋鎖檢查。回傳 doc／section，或者 NextResponse（錯誤）。 */
export async function loadEditableSection(
  client: any,
  args: { docId: string; sid: string; session: any; perms: string[] | null | undefined; version: unknown },
): Promise<{ doc: any; section: any } | { res: NextResponse }> {
  const kioskDeny = await kioskDocGuard(args.session, args.docId)
  if (kioskDeny) return { res: kioskDeny }
  if (!(args.perms ?? []).includes('lab_statement')) return { res: jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 }) }
  if (!ID_RE.test(args.docId) || !ID_RE.test(args.sid)) return { res: jsonNoStore({ error: 'ID 格式錯誤' }, { status: 400 }) }
  if (typeof args.version !== 'number' || !Number.isInteger(args.version)) {
    return { res: jsonNoStore({ error: 'version 必填（請重新載入）' }, { status: 400 }) }
  }
  const scope = await labdocScope(args.session, args.perms)
  if (scope !== null && scope.length === 0) return { res: jsonNoStore({ error: '冇任何診所範圍' }, { status: 403 }) }

  const doc = await client.labDocument.findUnique({
    where: { id: args.docId },
    select: { id: true, kind: true, status: true, version: true, labId: true, statementMonth: true },
  })
  if (!doc || doc.kind !== 'STATEMENT' || INACTIVE_DOC.includes(doc.status)) {
    return { res: jsonNoStore({ error: '單據唔存在或者唔係有效月結單' }, { status: 404 }) }
  }
  const section = await client.labStatementSection.findFirst({
    where: { id: args.sid, documentId: doc.id },
    select: { id: true, clinicId: true, providerId: true, status: true, sectionIndex: true },
  })
  if (!section) return { res: jsonNoStore({ error: '分段唔屬於呢張單' }, { status: 404 }) }
  if (scope !== null && section.clinicId && !scope.includes(section.clinicId)) {
    return { res: jsonNoStore({ error: '診所唔喺你嘅範圍' }, { status: 403 }) }
  }
  if (section.status === 'CONFIRMED') return { res: jsonNoStore({ error: '分段已確認 — 唔可以再改', code: 'CONFIRMED' }, { status: 409 }) }
  const group = await sectionCombineGroup(client, section.id)
  if (group) {
    const n = await client.labStatementSection.count({ where: { id: { in: group.memberIds }, status: 'CONFIRMED' } })
    if (n > 0) return { res: jsonNoStore({ error: '加埋一齊對嘅另一份已確認 — 唔可以再改', code: 'CONFIRMED' }, { status: 409 }) }
  }
  if (doc.version !== args.version) {
    return { res: jsonNoStore({ error: '版本衝突（單據已更新）— 請重新載入', code: 'VERSION' }, { status: 409 }) }
  }
  return { doc, section }
}

/** 行層面嘅鎖（改／刪）。amountChanging：改緊金額。 */
export function lineEditBlock(line: any, opts: { amountChanging: boolean; deleting?: boolean }): string | null {
  if (line.carriedFromLineId) return '呢行係上月結轉過嚟 — 要返上個月嗰份單改'
  if (line.resolution === NEXT_MONTH) return '呢行標咗「計入下個月」— 要先取消標記先可以改'
  if (line.resolution === 'STATEMENT_WINS') return '呢行之前用「以月結單為準」改咗系統 — 唔可以再改'
  if ((opts.amountChanging || opts.deleting) && line.pairMode === 'MANUAL') return '呢行人手配對咗成本 — 要先撳「未配對到」拆開先可以改金額／刪'
  if (opts.deleting && line.manualSource !== 'ADDED') return 'AI 讀到嘅行唔可以刪 — 可以改，或者標「唔關我哋事／備貨」'
  return null
}

/** 同 Lab 其他有效月結單有冇同一個單號（唔計結轉副本、唔計自己）。 */
export async function findDocNoElsewhere(client: any, args: { labId: string | null; docNo: string | null; excludeLineId?: string }): Promise<{ month: string | null } | null> {
  if (!args.labId || !args.docNo) return null
  const hit = await client.labStatementLine.findFirst({
    where: {
      docNo: args.docNo,
      carriedFromLineId: null,
      ...(args.excludeLineId ? { id: { not: args.excludeLineId } } : {}),
      section: { document: { kind: 'STATEMENT', labId: args.labId, status: { notIn: INACTIVE_DOC } } },
    },
    select: { section: { select: { document: { select: { statementMonth: true } } } } },
  })
  return hit ? { month: hit.section?.document?.statementMonth ?? null } : null
}

export const docNoOf = (raw: string | null | undefined): string | null => (raw ? normDocNo(raw) : null)
