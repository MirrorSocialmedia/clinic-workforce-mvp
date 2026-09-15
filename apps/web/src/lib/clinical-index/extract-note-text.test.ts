/**
 * extract-note-text.ts 單測（cwi-followup-p1-20260915 S1 — MD §0.3 唯一寫法）
 *
 * 覆蓋：
 *   - A 標準樣板（四平欄，含部分欄）
 *   - B 自訂樣板（storedTemplate.sections[].questions[] type=2 + text）
 *   - 🔴 負測：latestTemplate 永遠唔讀（MD §0.3 關鍵陷阱 — answer.text 永遠空）
 *   - firstLineOf ≤60 字（列表 API 口徑）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractNoteText, firstLineOf } from './extract-note-text'
import type { NoteTemplate } from './types'

describe('extractNoteText — MD §0.3', () => {
  it('A 標準樣板 — 四平欄原樣', () => {
    const r = extractNoteText({
      complaints: '牙痛 3 日',
      findings: 'Caries #36',
      diagnosis: 'Deep caries',
      actions: '預留填充',
    })
    assert.deepEqual(r, {
      kind: 'STANDARD',
      complaints: '牙痛 3 日',
      findings: 'Caries #36',
      diagnosis: 'Deep caries',
      actions: '預留填充',
    })
  })

  it('A 部分欄 — 缺欄變空字串（唔 fallback 去 TEMPLATE）', () => {
    const r = extractNoteText({ diagnosis: 'Pulpitis' })
    assert.deepEqual(r, { kind: 'STANDARD', complaints: '', findings: '', diagnosis: 'Pulpitis', actions: '' })
  })

  it('A 四欄皆空字串 — 仍係 STANDARD（`in` 判斷，唔係 truthiness）', () => {
    const r = extractNoteText({ complaints: '', findings: '', diagnosis: '', actions: '' })
    assert.equal(r.kind, 'STANDARD')
  })

  it('B 自訂樣板 — 只收 storedTemplate type=2 且有文本', () => {
    const note = {
      storedTemplate: {
        des: 'CS Template v3',
        sections: [
          {
            questions: [
              { question: '主訴', type: 2, answer: { text: '  牙齦腫  ' } }, // trim 後收
              { question: '空白', type: 2, answer: { text: '   ' } }, // 空白 → 剔
              { question: '簽名', type: 1, answer: { text: 'Dr X' } }, // 非 type=2 → 剔
              { question: '無答', type: 2, answer: null }, // 無 answer → 剔
              { question: '無文', type: 2, answer: { text: '' } }, // 空文 → 剔
            ],
          },
          { questions: [{ question: '第二段', type: 2, answer: { text: '復診 1 週' } }] },
        ],
      },
    }
    const r = extractNoteText(note)
    assert.equal(r.kind, 'TEMPLATE')
    assert.equal(r.templateName, 'CS Template v3')
    assert.deepEqual(r.blocks, [
      { label: '主訴', text: '牙齦腫' },
      { label: '第二段', text: '復診 1 週' },
    ])
  })

  it('🔴 負測 1：只有 latestTemplate（answer 有內容）→ blocks 必空（永遠唔讀 latestTemplate）', () => {
    const note = {
      latestTemplate: {
        sections: [{ questions: [{ question: 'X', type: 2, answer: { text: 'SHOULD-NOT-APPEAR' } }] }],
      },
    }
    const r = extractNoteText(note)
    assert.equal(r.kind, 'TEMPLATE')
    assert.equal((r as NoteTemplate).templateName, null)
    assert.deepEqual((r as NoteTemplate).blocks, [])
    assert.ok(!JSON.stringify(r).includes('SHOULD-NOT-APPEAR'))
  })

  it('🔴 負測 2：storedTemplate + latestTemplate 同時在 → 結果只含 storedTemplate 內容', () => {
    const note = {
      storedTemplate: { des: 'S', sections: [{ questions: [{ question: 'A', type: 2, answer: { text: 'from-stored' } }] }] },
      latestTemplate: { sections: [{ questions: [{ question: 'B', type: 2, answer: { text: 'from-latest' } }] }] },
    }
    const r = extractNoteText(note)
    const rt = r as NoteTemplate
    assert.deepEqual(rt.blocks, [{ label: 'A', text: 'from-stored' }])
    assert.ok(JSON.stringify(r).includes('from-stored'))
    assert.ok(!JSON.stringify(r).includes('from-latest'))
  })
})

describe('firstLineOf — 列表 API ≤60 字', () => {
  it('STANDARD — complaints→findings→diagnosis→actions 第一個非空行', () => {
    assert.equal(firstLineOf({ kind: 'STANDARD', complaints: '', findings: '甲行\n乙行', diagnosis: '', actions: '' }), '甲行')
    assert.equal(firstLineOf({ kind: 'STANDARD', complaints: '  ', findings: '', diagnosis: '診斷行', actions: '' }), '診斷行')
  })
  it('TEMPLATE — 第一個 block', () => {
    assert.equal(
      firstLineOf({ kind: 'TEMPLATE', templateName: null, blocks: [{ label: 'x', text: 'B1\nB2' }, { label: 'y', text: 'B2b' }] }),
      'B1',
    )
  })
  it('截斷 60 字（ASCII）', () => {
    const r = firstLineOf({ kind: 'STANDARD', complaints: 'a'.repeat(80), findings: '', diagnosis: '', actions: '' })
    assert.equal(r, 'a'.repeat(60))
  })
  it('CJK 按字數唔係 bytes', () => {
    const r = firstLineOf({ kind: 'STANDARD', complaints: '牙'.repeat(61), findings: '', diagnosis: '', actions: '' })
    assert.equal(r, '牙'.repeat(60))
  })
  it('null / 空 → null', () => {
    assert.equal(firstLineOf(null), null)
    assert.equal(firstLineOf({ kind: 'STANDARD', complaints: '', findings: '', diagnosis: '', actions: '' }), '')
  })
})
