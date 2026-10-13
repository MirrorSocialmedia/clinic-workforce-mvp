// ★ 2026-10-13：成本錄入逐筆月結單核對（OK 綠／CHANGED 改咗價／MISSING 月結冇呢筆）
//   跑法: TZ=UTC npx tsx --test src/lib/labdoc/cost-statement-links.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linksFromSections, costStatementLinks, type LinkCostIn, type LinkSectionIn } from './cost-statement-links'

const C = (id: string, o: Partial<LinkCostIn> = {}): LinkCostIn => ({
  id, labId: 'hc', clinicId: 'tkw', providerId: 'drA', periodMonth: '2026-09', finalCost: 440, status: 'PRICED', ...o,
})
const S = (id: string, pairs: Array<[string, number | null]>, o: Partial<LinkSectionIn> & { extraCosts?: Array<[string, number]>; rj?: unknown } = {}): LinkSectionIn => ({
  id, documentId: `doc-${id}`, clinicId: 'tkw', providerId: 'drA', labId: 'hc', statementMonth: '2026-09',
  resultJson: o.rj !== undefined ? o.rj : {
    mode: 'COST',
    pairs: pairs.map(([costCaseId]) => ({ costCaseId, lineIds: [`l-${costCaseId}`] })),
    costs: [...pairs, ...(o.extraCosts ?? [])].map(([cid, fc]) => ({ id: cid, finalCost: fc })),
  },
  ...o,
})

test('配對到、價錢同範圍冇變 → OK（指去嗰段）', () => {
  const m = linksFromSections([C('c1')], [S('s1', [['c1', 440]])])
  assert.deepEqual(m.get('c1'), { state: 'OK', docId: 'doc-s1', sectionId: 's1', confirmedFinalCost: 440 })
})

test('確認之後改咗價 → CHANGED（帶確認時價），唔係 OK', () => {
  const m = linksFromSections([C('c1', { finalCost: 480 })], [S('s1', [['c1', 440]])])
  assert.equal(m.get('c1')?.state, 'CHANGED')
  assert.equal(m.get('c1')?.confirmedFinalCost, 440)
})

test('改價少過一仙（浮點誤差）仍然 OK；改咗一仙 → CHANGED', () => {
  assert.equal(linksFromSections([C('c1', { finalCost: 440.001 })], [S('s1', [['c1', 440]])]).get('c1')?.state, 'OK')
  assert.equal(linksFromSections([C('c1', { finalCost: 440.01 })], [S('s1', [['c1', 440]])]).get('c1')?.state, 'CHANGED')
})

test('確認之後改咗醫生／月份／Lab／診所 → CHANGED（confirmedFinalCost = null），唔會因為價錢一樣就綠', () => {
  for (const o of [{ providerId: 'drB' }, { periodMonth: '2026-10' }, { labId: 'md' }, { clinicId: 'yl' }]) {
    const m = linksFromSections([C('c1', o)], [S('s1', [['c1', 440]])])
    assert.equal(m.get('c1')?.state, 'CHANGED', JSON.stringify(o))
    assert.equal(m.get('c1')?.confirmedFinalCost, null)
  }
})

test('改咗價之後未有價（finalCost null）→ CHANGED，唔會當 OK', () => {
  assert.equal(linksFromSections([C('c1', { finalCost: null })], [S('s1', [['c1', 440]])]).get('c1')?.state, 'CHANGED')
})

test('範圍有已確認分段但冇配到 → MISSING（指去嗰段）', () => {
  const m = linksFromSections([C('c1'), C('c2', { finalCost: 320 })], [S('s1', [['c1', 440]], { extraCosts: [['c2', 320]] })])
  assert.equal(m.get('c1')?.state, 'OK')
  assert.deepEqual(m.get('c2'), { state: 'MISSING', docId: 'doc-s1', sectionId: 's1', confirmedFinalCost: null })
})

test('確認之後先加嘅成本（唔喺快照）→ MISSING', () => {
  const m = linksFromSections([C('new1', { finalCost: 99 })], [S('s1', [['c1', 440]])])
  assert.equal(m.get('new1')?.state, 'MISSING')
})

test('其他範圍（另一個醫生／月份／Lab）嘅已確認分段 → 唔會標 MISSING', () => {
  const m = linksFromSections(
    [C('c1', { providerId: 'drB' }), C('c2', { periodMonth: '2026-10' }), C('c3', { labId: 'md' }), C('c4', { clinicId: 'yl' })],
    [S('s1', [['x', 1]])],
  )
  assert.equal(m.size, 0)
})

test('未到貨（periodMonth null）／冇 Lab → 冇標示', () => {
  const m = linksFromSections([C('c1', { periodMonth: null }), C('c2', { labId: null })], [S('s1', [['x', 1]])])
  assert.equal(m.size, 0)
})

test('作廢成本 → 冇標示（就算之前配對過）', () => {
  assert.equal(linksFromSections([C('c1', { status: 'VOID' })], [S('s1', [['c1', 440]])]).size, 0)
})

test('舊格式 resultJson（冇 pairs）／唔係 COST 模式／null → 唔計，唔會亂出 MISSING', () => {
  for (const rj of [null, { mode: 'COST' }, { mode: 'INVOICE', pairs: [] }, { mode: 'COST', pairs: 'x' }]) {
    assert.equal(linksFromSections([C('c1')], [S('s1', [], { rj })]).size, 0, JSON.stringify(rj))
  }
})

test('壞資料：pairs 入面有 null／冇 costCaseId → 跳過唔死', () => {
  const m = linksFromSections([C('c1')], [S('s1', [], { rj: { mode: 'COST', pairs: [null, {}, { costCaseId: 5 }, { costCaseId: 'c1' }], costs: [{ id: 'c1', finalCost: '440.00' }] } })])
  assert.equal(m.get('c1')?.state, 'OK') // 快照價係字串（Decimal 序列化）都照比
})

test('配對到但快照冇呢筆價 → CHANGED（唔可以證明冇改）', () => {
  const m = linksFromSections([C('c1')], [S('s1', [], { rj: { mode: 'COST', pairs: [{ costCaseId: 'c1' }], costs: [] } })])
  assert.equal(m.get('c1')?.state, 'CHANGED')
})

test('「兩份加埋一齊對」組：每段都有同一份 pairs → 一筆只得一個 OK，指去第一段', () => {
  const m = linksFromSections([C('c1')], [S('a', [['c1', 440]]), S('b', [['c1', 440]])])
  assert.equal(m.size, 1)
  assert.equal(m.get('c1')?.sectionId, 'a')
})

test('一段改咗價（CHANGED）、另一段價啱（OK）→ OK 優先', () => {
  const m = linksFromSections([C('c1')], [S('old', [['c1', 400]]), S('new', [['c1', 440]])])
  assert.equal(m.get('c1')?.state, 'OK')
  assert.equal(m.get('c1')?.sectionId, 'new')
})

test('搬咗範圍：舊段配對到（CHANGED）＋新範圍有段冇配到（MISSING）→ CHANGED 優先', () => {
  const m = linksFromSections(
    [C('c1', { periodMonth: '2026-10' })],
    [S('sep', [['c1', 440]]), S('oct', [['x', 1]], { statementMonth: '2026-10' })],
  )
  assert.equal(m.get('c1')?.state, 'CHANGED')
  assert.equal(m.get('c1')?.sectionId, 'sep')
})

test('分段未揀醫生（冇範圍）→ 唔會令人 MISSING；但佢 pairs 仍然唔當 OK（範圍對唔上）', () => {
  const m = linksFromSections([C('c1'), C('c2')], [S('s1', [['c1', 440]], { providerId: null })])
  assert.equal(m.get('c1')?.state, 'CHANGED')
  assert.equal(m.has('c2'), false)
})

test('costStatementLinks：只查已確認＋有效文件；全部作廢成本／冇月份 → 唔查 DB', async () => {
  const calls: any[] = []
  const fake = { labStatementSection: { findMany: async (a: any) => { calls.push(a); return [] } } }
  assert.equal((await costStatementLinks(fake, [C('c1', { status: 'VOID' })])).size, 0)
  assert.equal((await costStatementLinks(fake, [C('c1', { periodMonth: null })])).size, 0)
  assert.equal(calls.length, 0)
  await costStatementLinks(fake, [C('c1'), C('c2', { clinicId: 'yl', periodMonth: '2026-10' })])
  assert.equal(calls.length, 1)
  const w = calls[0].where
  assert.equal(w.status, 'CONFIRMED')
  assert.deepEqual(w.document.status, { notIn: ['VOID', 'SUPERSEDED', 'DUPLICATE'] })
  assert.equal(w.document.kind, 'STATEMENT')
  assert.deepEqual(w.clinicId.in.sort(), ['tkw', 'yl'])
  assert.deepEqual(w.document.statementMonth.in.sort(), ['2026-09', '2026-10'])
})

test('costStatementLinks：只讀 — client 冇任何寫方法都照跑', async () => {
  const ro = { labStatementSection: { findMany: async () => [{ id: 's1', documentId: 'd1', clinicId: 'tkw', providerId: 'drA', resultJson: { mode: 'COST', pairs: [{ costCaseId: 'c1' }], costs: [{ id: 'c1', finalCost: 440 }] }, document: { labId: 'hc', statementMonth: '2026-09' } }] } }
  const m = await costStatementLinks(ro, [C('c1')])
  assert.equal(m.get('c1')?.state, 'OK')
})
