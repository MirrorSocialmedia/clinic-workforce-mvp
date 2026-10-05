// ★ MD-F: Patient PII leak test — verify toCleanPatients strips all PII except fullName
import { toCleanPatients } from '../src/lib/apricot/sanitize'

const dirty = [{
  id: 'x',
  code: 'TKW001',
  fullName: '陳大文',
  medicalHistory: '其他，請註明: 癌',
  personalIdentifier: 'A1234567',
  address: '旺角彌敦道',
  phoneNum: '9xxx1234',
  dateOfBirth: '1980-01-01',
  bloodType: 'B+',
  diagnosis: '高血壓',
  drugHistory: '阿士匹靈',
  clinicPatient: { id: 1, name: '陳大文' },
  email: 'test@example.com',
  phoneList: [{ number: '9xxx' }],
  emergencyContact: '李小姐',
  occupation: '醫生',
}]

const clean = toCleanPatients(dirty)
const json = JSON.stringify(clean)

// These must NOT appear in clean output
const mustNotLeak = [
  'medicalHistory', 'personalIdentifier', 'address', 'phoneNum',
  'dateOfBirth', 'bloodType', 'diagnosis', 'drugHistory',
  'clinicPatient', 'email', 'phoneList', 'emergencyContact', 'occupation',
  // values
  '癌', 'A1234567', '旺角', '9xxx1234', '1980-01-01', 'B+',
  '高血壓', '阿士匹靈', '李小姐', '醫生',
]

for (const leak of mustNotLeak) {
  if (json.includes(leak)) {
    throw new Error(`PII 洩漏：${leak}`)
  }
}

// fullName MUST be retained (income report needs it)
if (!json.includes('陳大文')) {
  throw new Error('fullName 應該被保留但消失了')
}

console.log('✅ patient PII 測試通過 — 所有 PII 已清除，fullName 正確保留')

// ============================================================
// ★ cwm-labdoc（§14）：labdocAudit PII guard — 收到含姓名欄嘅 object 要 throw
// ============================================================
async function testLabdocAuditPiiGuard() {
  // ⚠️ 只可以 import 純函數（audit-pii.ts）：deploy.sh 喺冇 node_modules 嘅 worktree 跑呢個 script，
  //    import audit.ts 會拉 @prisma/client → MODULE_NOT_FOUND
  const { findNameFieldPath, assertNoNameFields, assertAuditInputClean, LabDocAuditPIIError } =
    await import('../src/lib/labdoc/audit-pii')

  // 1) findNameFieldPath：巢狀姓名欄一定要捉到
  const hit1 = findNameFieldPath({ a: { patientNameRaw: '陳大文' } })
  if (hit1 !== '$.a.patientNameRaw') throw new Error(`findNameFieldPath 錯：${hit1}`)
  const hit2 = findNameFieldPath({ rows: [{ patientRaw: 'x' }] })
  if (hit2 !== '$.rows[0].patientRaw') throw new Error(`findNameFieldPath 錯：${hit2}`)
  const hit3 = findNameFieldPath({ patientName: 'x' })
  if (hit3 !== '$.patientName') throw new Error(`findNameFieldPath 錯：${hit3}`)
  if (findNameFieldPath({ docNo: 'IN123', patientCode: 'TW007159', total: 100 }) !== null) {
    throw new Error('findNameFieldPath 誤報：非姓名欄')
  }

  // 2) assertNoNameFields：乾淨 object 唔 throw
  assertNoNameFields({ fileIds: ['a'], kind: 'INVOICE', sha256Prefix: ['abc123'] })

  // 3) labdocAudit 寫入前檢查：before/after/notes 含姓名欄 → 一定要 throw
  for (const payload of [
    { after: { patientNameRaw: '陳大文' } },
    { before: { lines: [{ patientRaw: 'x' }] } },
    { notes: 'patientNameRaw=陳大文' },
  ]) {
    let threw = false
    try {
      assertAuditInputClean(payload)
    } catch (e) {
      if (e instanceof LabDocAuditPIIError) threw = true
      else throw e
    }
    if (!threw) throw new Error(`labdocAudit guard 應該 throw（payload 含姓名欄）：${JSON.stringify(payload)}`)
  }
  assertAuditInputClean({ notes: '上傳 2 個檔', after: { fileIds: ['a'] } })

  // 4) labdocAudit 一定要喺寫 DB 之前叫 guard（讀 source，唔使 import prisma）
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(__dirname, '../src/lib/labdoc/audit.ts'), 'utf8')
  const fn = src.slice(src.indexOf('export async function labdocAudit'))
  const guardAt = fn.indexOf('assertAuditInputClean(input)')
  const writeAt = fn.indexOf('prisma.auditLog.create')
  if (guardAt < 0 || writeAt < 0 || guardAt > writeAt) {
    throw new Error('labdocAudit 要喺 prisma.auditLog.create 之前叫 assertAuditInputClean(input)')
  }

  console.log('✅ labdocAudit PII guard 測試通過 — 姓名欄進 audit 前必 throw')
}

testLabdocAuditPiiGuard().catch((e) => {
  console.error('❌ labdocAudit PII guard 測試失敗', e)
  process.exit(1)
})
