// ★ cwm-exportzip-20261012：一鍵匯出 ZIP 檔名
//   跑法: TZ=UTC npx tsx --test src/lib/payout/export-zip-names.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipFileName } from './export-zip-names'

test('醫生全名做檔名；唔准用嘅字元換做 _；同名加 (2)', () => {
  const used = new Set<string>()
  assert.equal(zipFileName('何嘉俊醫生-YL-2026-09', used), '何嘉俊醫生-YL-2026-09.xlsx')
  assert.equal(zipFileName('何嘉俊醫生-YL-2026-09', used), '何嘉俊醫生-YL-2026-09 (2).xlsx')
  assert.equal(zipFileName('Dr. A/B: "C"-YL-2026-09', used), 'Dr. A_B_ _C_-YL-2026-09.xlsx')
  assert.equal(zipFileName('   ', used), '未命名.xlsx')
})
