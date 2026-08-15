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
