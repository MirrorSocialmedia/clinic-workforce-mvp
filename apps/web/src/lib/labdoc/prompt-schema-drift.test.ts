/**
 * cwm-labdoc P2 — prompt / schema 契約防漂移測試
 * 跑法: npx tsx --test src/lib/labdoc/prompt-schema-drift.test.ts
 *
 * 契約鏈（兩 repo 防漂移）：
 *   CWM prompt.ts 常量  ≡  CWM test/fixtures/labdoc/prompt.v1.txt  ≡  W src/lib/labdoc/prompt.ts 模板
 *   CWM test/fixtures/labdoc/schema.v1.json  ≡  W src/lib/labdoc/schema.json（byte-identical）
 *   （W repo 自己嘅 scripts/unit-labdoc-extract.ts 鎖 W 側；本檔鎖 CWM 側。）
 *   改文字要兩邊同步 + 更新 fixture（同一個 PR）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LABDOC_EXTRACT_PROMPT, buildLabDocPrompt, LABDOC_MAX_HINT_CHARS } from './prompt'
import { labDocResultSchema } from './schema'

const FIX_DIR = join(process.cwd(), 'test/fixtures/labdoc')

describe('prompt 契約', () => {
  it('LABDOC_EXTRACT_PROMPT === prompt.v1.txt（byte-identical）', () => {
    const fixture = readFileSync(join(FIX_DIR, 'prompt.v1.txt'), 'utf8')
    assert.equal(LABDOC_EXTRACT_PROMPT, fixture)
  })

  it('buildLabDocPrompt(null) — 佔位行整行移除（其餘逐字不變）', () => {
    const noHint = buildLabDocPrompt(null)
    assert.ok(!noHint.includes('{labHint}'))
    // 移除最後一行（{labHint}）→ 同原始字串前段一致
    assert.ok(LABDOC_EXTRACT_PROMPT.startsWith(noHint.replace(/\n$/, '')) || LABDOC_EXTRACT_PROMPT.startsWith(noHint))
    assert.equal(noHint.trimEnd().endsWith('f. 付款、承上結餘、服務費行要標 lineType（PAYMENT／BF／CHARGE）。'), true)
  })

  it('buildLabDocPrompt("") — 空白 hint 視同 null（整行移除）', () => {
    assert.equal(buildLabDocPrompt('   '), buildLabDocPrompt(null))
  })

  it('buildLabDocPrompt(hint) — 佔位行替換成 trim 後 hint；cap 500 字', () => {
    const withHint = buildLabDocPrompt('Modern 名後 4 位係病人編號')
    assert.ok(!withHint.includes('{labHint}'))
    assert.ok(withHint.endsWith('Modern 名後 4 位係病人編號\n'))

    const long = 'x'.repeat(LABDOC_MAX_HINT_CHARS + 50)
    const capped = buildLabDocPrompt(`  ${long}  `)
    assert.ok(capped.endsWith(`\n${'x'.repeat(LABDOC_MAX_HINT_CHARS)}\n`))
  })

  it('spec §5.3 九條規則關鍵句都在（防手改漏行）', () => {
    for (const key of [
      '只輸出一個 JSON 物件',
      'INVOICE（單張發票／送貨單）或 STATEMENT',
      '讀唔到填 null，唔好估',
      'YYYY-MM-DD',
      'CHEQUE_PRESENT',
      'List Price',
      '打橫或倒轉',
      '本行金額',
      'agingBucket',
    ]) {
      assert.ok(LABDOC_EXTRACT_PROMPT.includes(key), `prompt 應該包含「${key}」`)
    }
  })
})

describe('schema 契約', () => {
  it('schema.v1.json 可 parse；$id = labdoc-extract-result.v1', () => {
    const j = JSON.parse(readFileSync(join(FIX_DIR, 'schema.v1.json'), 'utf8'))
    assert.equal(j.$id, 'labdoc-extract-result.v1')
    assert.equal(j.type, 'object')
  })

  it('zod 頂層必填欄位 === fixture required（一對一）', () => {
    const j = JSON.parse(readFileSync(join(FIX_DIR, 'schema.v1.json'), 'utf8'))
    const shape = labDocResultSchema._zod.def.shape as Record<string, unknown>
    const zodKeys = Object.keys(shape).sort()
    assert.deepEqual(zodKeys, [...j.required].sort())
  })

  it('zod enum 同 fixture 一致（kind / lineType）', () => {
    const j = JSON.parse(readFileSync(join(FIX_DIR, 'schema.v1.json'), 'utf8'))
    // zod 4：shape 可能係 object 或 function；array item 喺 _zod.def.element
    const shapeOf = (s: any) => {
      const sh = s._zod.def.shape
      return typeof sh === 'function' ? sh() : sh
    }
    const shape = shapeOf(labDocResultSchema)
    const kindEntries = Object.keys((shape.kind._zod.def.entries as unknown) as Record<string, unknown>)
    assert.deepEqual(kindEntries.sort(), [...(j.properties.kind.enum as string[])].sort())
    const lineType = shapeOf(shapeOf((shape.sections as any)._zod.def.element).lines._zod.def.element).lineType
    const lineTypeEntries = Object.keys((lineType._zod.def.entries as unknown) as Record<string, unknown>)
    const fixtureLineType = j.properties.sections.items.properties.lines.items.properties.lineType.enum as string[]
    assert.deepEqual(lineTypeEntries.sort(), [...fixtureLineType].sort())
  })

  it('zod 行為同 fixture 語義一致：必填缺 → 拒；INVOICE sections=[]／STATEMENT groups=[]；多餘欄位丟棄', () => {
    const ok: Record<string, unknown> = {
      kind: 'INVOICE',
      lab: { nameRaw: null, nameCnRaw: null, payeeRaw: null },
      billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
      docNoRaw: null, docNoLabel: null, dateRaw: null, date: null, deliveryDate: null, orderReceivedDate: null,
      statementMonth: null,
      groups: [], sections: [],
      subtotal: null, total: null, readIssues: [],
    }
    assert.ok(labDocResultSchema.safeParse(ok).success)
    // 必填缺 → bad_response
    const missing = { ...ok }
    delete (missing as any).total
    assert.ok(!labDocResultSchema.safeParse(missing).success)
    // INVOICE 帶 sections → 拒
    const invWithSections = { ...ok, sections: [{ clinicRaw: null, doctorRaw: null, customerNoRaw: null, addressRaw: null, pageFrom: null, pageTo: null, total: null, currentTotal: null, lines: [] }] }
    assert.ok(!labDocResultSchema.safeParse(invWithSections).success)
    // STATEMENT 帶 groups → 拒
    const stWithGroups = { ...ok, kind: 'STATEMENT', groups: [{ patientNameRaw: null, patientCodeRaw: null, labCaseRef: null, lines: [] }] }
    assert.ok(!labDocResultSchema.safeParse(stWithGroups).success)
    // 多餘欄位 → 丟棄（非 strict）
    const withExtra = { ...ok, bogusField: 123 }
    const parsed = labDocResultSchema.safeParse(withExtra)
    assert.ok(parsed.success)
    assert.ok(!('bogusField' in parsed.data))
    // 日期格式 → 拒
    const badDate = { ...ok, date: '05/10/2026' }
    assert.ok(!labDocResultSchema.safeParse(badDate).success)
  })
})
