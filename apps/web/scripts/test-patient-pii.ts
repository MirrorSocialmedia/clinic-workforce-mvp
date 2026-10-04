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
  const { findNameFieldPath, assertNoNameFields, labdocAudit, LabDocAuditPIIError } =
    await import('../src/lib/labdoc/audit')

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

  // 3) labdocAudit：before/after 含姓名欄 → 一定要 throw（guard 喺 prisma 寫入前）
  for (const payload of [
    { action: 'LAB_DOC_CONFIRM', entity: 'LabDocument', entityId: 'x', after: { patientNameRaw: '陳大文' } },
    { action: 'LAB_DOC_CONFIRM', entity: 'LabDocument', entityId: 'x', before: { lines: [{ patientRaw: 'x' }] } },
  ]) {
    let threw = false
    try {
      await labdocAudit(payload as any)
    } catch (e) {
      if (e instanceof LabDocAuditPIIError) threw = true
      else throw e
    }
    if (!threw) throw new Error(`labdocAudit 應該 throw（payload 含姓名欄）：${JSON.stringify(payload)}`)
  }

  console.log('✅ labdocAudit PII guard 測試通過 — 姓名欄進 audit 前必 throw')
}

testLabdocAuditPiiGuard().catch((e) => {
  console.error('❌ labdocAudit PII guard 測試失敗', e)
  process.exit(1)
})
