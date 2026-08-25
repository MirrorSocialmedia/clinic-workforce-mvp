// clinic-prefix unit tests — 跑法: pnpm test (tsx --test 'src/**/*.test.ts')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guessClinicByPatientCode,
  matchClinicPrefix,
  applyPatientPick,
} from './clinic-prefix'

// 本地 clinic 形態：TW / TKW / TY 同 T 開頭（重現長短嵌套）
const CLINICS = [
  { id: 'cl-tw', shortName: 'TW' },      // 大圍
  { id: 'cl-tkw', shortName: 'TKW' },    // 土瓜環
  { id: 'cl-ty', shortName: 'TY' },      // 屯門
  { id: 'cl-qs', shortName: '青' },      // 青衣（單中文字）
  { id: 'cl-none', shortName: null },    // 無簡稱 → 要 filter 走
]

test('#16: TW007446 → 推 TW（大圍）', () => {
  assert.equal(guessClinicByPatientCode('TW007446', CLINICS), 'cl-tw')
  assert.equal(matchClinicPrefix('TW007446', CLINICS), 'TW')
})

test('#19: TKW002004 → 推 TKW（土瓜環），唔會被短 TW 搶走', () => {
  // 長短排序：TKW(3) 先於 TW(2)
  assert.equal(guessClinicByPatientCode('TKW002004', CLINICS), 'cl-tkw')
  assert.equal(matchClinicPrefix('TKW002004', CLINICS), 'TKW')
})

test('TY001 開頭 → 推 TY（唔會撞 TW/TKW）', () => {
  assert.equal(guessClinicByPatientCode('TY001', CLINICS), 'cl-ty')
})

test('#20: A00123（冇對應前綴）→ null，唔好亂填', () => {
  assert.equal(guessClinicByPatientCode('A00123', CLINICS), null)
  assert.equal(matchClinicPrefix('A00123', CLINICS), null)
})

test('edge: 空 / 空白 / 小寫', () => {
  assert.equal(guessClinicByPatientCode('', CLINICS), null)
  assert.equal(guessClinicByPatientCode('   ', CLINICS), null)
  assert.equal(guessClinicByPatientCode('tw007446', CLINICS), 'cl-tw') // case-insensitive
})

test('edge: shortName=null 嘅 clinic 唔參與 match', () => {
  assert.equal(guessClinicByPatientCode('NONE001', CLINICS), null)
})

test('#16: applyPatientPick — 未揀診所 + TW code → 自動填 TW + 標記推斷', () => {
  const r = applyPatientPick({
    prevClinicId: '',
    patientCode: 'TW007446',
    patientName: '劉永康',
    clinics: CLINICS,
  })
  assert.equal(r.clinicId, 'cl-tw')
  assert.equal(r.guessed, true)
  assert.equal(r.prefix, 'TW')
  assert.equal(r.patientCode, 'TW007446')
  assert.equal(r.patientName, '劉永康')
})

test('#18: applyPatientPick — 先揀咗診所再搜病人 → 唔覆蓋', () => {
  const r = applyPatientPick({
    prevClinicId: 'cl-qs', // 用戶已揀青衣
    patientCode: 'TW007446', // 前綴會推 TW
    patientName: '劉永康',
    clinics: CLINICS,
  })
  assert.equal(r.clinicId, 'cl-qs') // 保持人手選擇
  assert.equal(r.guessed, false)
  assert.equal(r.prefix, null)
})

test('#17: applyPatientPick — 推斷後用戶改诊所 → 純 UI select 行為，lib 唔擋', () => {
  // 推斷係一次性（guessed 標記），之後用戶改诊所由 select 控制 — 呢度只驗
  // 推斷唔會鎖定：第二次 pick 唔同病人，prevClinicId 已有值 → 唔再推
  const r = applyPatientPick({
    prevClinicId: 'cl-tkw', // 用戶已手動改成 TKW
    patientCode: 'TW007446',
    patientName: '某人',
    clinics: CLINICS,
  })
  assert.equal(r.clinicId, 'cl-tkw')
  assert.equal(r.guessed, false)
})

test('applyPatientPick — 無前綴病人（#20）→ 诊所留空', () => {
  const r = applyPatientPick({
    prevClinicId: '',
    patientCode: 'A00123',
    patientName: '林小姐',
    clinics: CLINICS,
  })
  assert.equal(r.clinicId, '')
  assert.equal(r.guessed, false)
})
