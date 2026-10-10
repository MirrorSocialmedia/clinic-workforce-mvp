/**
 * cwm-labdoc P2 — §6 識別規則單元測試（6.1 Lab / 6.2 診所 / 6.3 醫生 / 6.4 單號重複）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toHalfWidth,
  normLabName,
  normDocNo,
  normClinicName,
  normDoctor,
  normCustomerNo,
  clinicDistrict,
  identifyLab,
  identifyDocNo,
  identifyClinic,
  identifyProvider,
} from './identify'
import type { LabDocResult } from './schema'

function baseRes(over: Partial<LabDocResult> = {}): LabDocResult {
  return {
    kind: 'INVOICE',
    lab: { nameRaw: 'Excel', nameCnRaw: null, payeeRaw: null },
    billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
    docNoRaw: null,
    docNoLabel: null,
    dateRaw: null,
    date: null,
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: null,
    groups: [],
    sections: [],
    subtotal: null,
    total: null,
    readIssues: [],
    ...over,
  }
}

// ── 正規化 ───────────────────────────────────────────
test('toHalfWidth：全形英數／空白轉半形', () => {
  assert.equal(toHalfWidth('０１２ＡＢＣ'), '012ABC')
  assert.equal(toHalfWidth('a b　c'), 'a b c')
})

test('normLabName：細階＋去標點＋去 limited|ltd|lab|dental|有限公司|牙科', () => {
  assert.equal(normLabName('Excel Dental Laboratory Limited'), 'excel')
  assert.equal(normLabName('Excel Limited'), 'excel')
  assert.equal(normLabName('和呈牙科器材有限公司'), '和呈')
  assert.equal(normLabName('  EXCEL　dental '), 'excel')
  // company 唔會俾 co 食咗（長 token 優先）
  assert.equal(normLabName('ABC Company'), 'abc')
})

test('normDocNo：去空格、大階、全形轉半形；唔去前置 0、唔將 O 轉 0', () => {
  assert.equal(normDocNo(' inv-001 '), 'INV-001')
  assert.equal(normDocNo('０２５４１３１'), '0254131')
  assert.equal(normDocNo('0321231O'), '0321231O')
  assert.equal(normDocNo(null), null)
  assert.equal(normDocNo('   '), null)
})

// ── identifyLab ─────────────────────────────────────
test('identifyLab：alias 命中（NAME_EN）→ ALIAS', async () => {
  const prisma: any = {
    labAlias: { findFirst: async (args: any) => (args.where.rawNorm === 'excel' ? { labId: 'lab-x1' } : null) },
    lab: { findMany: async () => [] },
  }
  const r = await identifyLab(prisma, baseRes())
  assert.equal(r.labId, 'lab-x1')
  assert.equal(r.labBasis, 'ALIAS')
})

test('identifyLab：NAME 互相包含（較短邊 ≥4、只有一間中）', async () => {
  const prisma: any = {
    labAlias: { findFirst: async () => null },
    lab: { findMany: async () => [{ id: 'lab-a', name: 'Excel Dental Lab' }, { id: 'lab-b', name: 'ABC' }] },
  }
  const r = await identifyLab(prisma, baseRes({ lab: { nameRaw: 'EXCEL DENTAL', nameCnRaw: null, payeeRaw: null } }))
  assert.equal(r.labId, 'lab-a')
  assert.equal(r.labBasis, 'NAME')
})

test('identifyLab：兩間中 → null（唔確定唔亂填）', async () => {
  const prisma: any = {
    labAlias: { findFirst: async () => null },
    lab: { findMany: async () => [{ id: 'lab-a', name: 'Excel' }, { id: 'lab-b', name: 'Excel Dental' }] },
  }
  const r = await identifyLab(prisma, baseRes())
  assert.equal(r.labId, null)
  assert.equal(r.labBasis, null)
})

test('identifyLab：較短邊 < 4 → 唔算（例 lab 名「ACE」vs raw「ACE DENTAL」）', async () => {
  const prisma: any = {
    labAlias: { findFirst: async () => null },
    lab: { findMany: async () => [{ id: 'lab-a', name: 'ACE' }] },
  }
  const r = await identifyLab(prisma, baseRes({ lab: { nameRaw: 'ACE DENTAL LAB', nameCnRaw: null, payeeRaw: null } }))
  assert.equal(r.labId, null)
})

test('payeeIsNew：認到 Lab、payeeRaw 唔喺 PAYEE alias → true；喺內 → false；payeeRaw 空 → false', async () => {
  const mk = (hasAlias: boolean): any => ({
    labAlias: {
      findFirst: async (args: any) => {
        if (args.where.kind === 'NAME_EN') return { labId: 'lab-x1' }
        if (args.where.kind === 'PAYEE') return hasAlias ? { id: 'a1' } : null
        return null
      },
    },
    lab: { findMany: async () => [] },
  })
  const r1 = await identifyLab(mk(false), baseRes({ lab: { nameRaw: 'Excel', nameCnRaw: null, payeeRaw: 'Excel Ltd T/C' } }))
  assert.equal(r1.payeeIsNew, true)
  const r2 = await identifyLab(mk(true), baseRes({ lab: { nameRaw: 'Excel', nameCnRaw: null, payeeRaw: 'Excel Ltd T/C' } }))
  assert.equal(r2.payeeIsNew, false)
  const r3 = await identifyLab(mk(false), baseRes({ lab: { nameRaw: 'Excel', nameCnRaw: null, payeeRaw: null } }))
  assert.equal(r3.payeeIsNew, false)
})

// ── identifyDocNo ───────────────────────────────────
test('identifyDocNo：INVOICE_NO 撞另一張活動單 → duplicateOfId', async () => {
  const prisma: any = {
    labDocument: { findFirst: async (args: any) => (args.where.docNo === 'INV-1' ? { id: 'doc-orig' } : null) },
  }
  const r = await identifyDocNo(prisma, baseRes({ docNoRaw: 'inv-1', kind: 'INVOICE' }), {
    selfDocId: 'doc-self',
    labId: 'lab-x1',
    defaultDocNoKind: 'INVOICE_NO',
  })
  assert.equal(r.docNo, 'INV-1')
  assert.equal(r.docNoKind, 'INVOICE_NO')
  assert.equal(r.duplicateOfId, 'doc-orig')
})

test('identifyDocNo：docNoLabel 含 case → CASE_NO（唔做硬擋）', async () => {
  const prisma: any = { labDocument: { findFirst: async () => ({ id: 'doc-orig' }) } }
  const r = await identifyDocNo(prisma, baseRes({ docNoRaw: '0254131', docNoLabel: 'Case No.' }), {
    selfDocId: 'doc-self',
    labId: 'lab-x1',
    defaultDocNoKind: 'INVOICE_NO',
  })
  assert.equal(r.docNoKind, 'CASE_NO')
  assert.equal(r.duplicateOfId, null)
})

test('identifyDocNo：labId null（Others）→ 唔做硬擋', async () => {
  const prisma: any = { labDocument: { findFirst: async () => ({ id: 'doc-orig' }) } }
  const r = await identifyDocNo(prisma, baseRes({ docNoRaw: 'INV-1' }), { selfDocId: 'doc-self', labId: null, defaultDocNoKind: 'INVOICE_NO' })
  assert.equal(r.duplicateOfId, null)
})

test('identifyDocNo：冇單號 → 全 null', async () => {
  const prisma: any = { labDocument: { findFirst: async () => null } }
  const r = await identifyDocNo(prisma, baseRes({ docNoRaw: null }), { selfDocId: 'doc-self', labId: 'lab-x1', defaultDocNoKind: 'INVOICE_NO' })
  assert.equal(r.docNo, null)
  assert.equal(r.docNoKind, null)
  assert.equal(r.duplicateOfId, null)
})

// ── §6.2 正規化 ───────────────────────────────────
test('normClinicName：細階＋全形轉半形＋去標點空格（留 CJK＋英數）', () => {
  assert.equal(normClinicName('臻善牙科（大圍）'), '臻善牙科大圍')
  assert.equal(normClinicName('  Aegis　DENTAL '), 'aegisdental')
  assert.equal(normClinicName(null), '')
})

test('normDoctor：去 dr｜dr.｜doctor｜醫生＋標點空格', () => {
  assert.equal(normDoctor('Dr.Ho Ka Chun 何嘉俊醫生'), 'hokachun何嘉俊')
  assert.equal(normDoctor('doctor 張三'), '張三')
  assert.equal(normDoctor('DR. 李四'), '李四')
  assert.equal(normDoctor(null), '')
})

test('normCustomerNo：全形轉半形＋去空格＋大階（hyphen 原樣保留）', () => {
  assert.equal(normCustomerNo(' ec-101 '), 'EC-101')
  assert.equal(normCustomerNo(' ec 101 '), 'EC101')
  assert.equal(normCustomerNo('ＥＣ１０１'), 'EC101')
  assert.equal(normCustomerNo(null), '')
})

test('clinicDistrict：末尾分組地區名；少於 2 字／冇分組 → null', () => {
  assert.equal(clinicDistrict('臻善牙科（大圍）'), '大圍')
  assert.equal(clinicDistrict('滙樂牙科（AEGIS DENTAL)（土瓜湾）'), '土瓜湾')
  assert.equal(clinicDistrict('Excel'), null)
  assert.equal(clinicDistrict('店（大）'), null)
})

// ── §6.2 identifyClinic ───────────────────────────
test('identifyClinic：CUSTOMER_NO 命中 → clinicId＋providerId（同時帶出）', async () => {
  const prisma: any = {
    labCustomerNo: {
      findFirst: async (args: any) =>
        args.where.labId === 'lab-x1' && args.where.customerNo === 'EC-101'
          ? { clinicId: 'c-tw', providerId: 'p-ho' }
          : null,
    },
    clinicNameAlias: { findFirst: async () => ({ clinicId: 'c-other' }) }, // 唔應該用到
    clinic: { findMany: async () => [] },
  }
  const r = await identifyClinic(prisma, baseRes({ billTo: { nameRaw: 'X', addressRaw: null, customerNoRaw: ' ec-101 ', shortCodeRaw: null, doctorRaw: null } }), { labId: 'lab-x1' })
  assert.equal(r.clinicId, 'c-tw')
  assert.equal(r.clinicBasis, 'CUSTOMER_NO')
  assert.equal(r.providerIdFromCustomerNo, 'p-ho')
})

test('identifyClinic：labId null（Others）→ CUSTOMER_NO 路徑唔行 → 落下一步', async () => {
  const prisma: any = {
    labCustomerNo: { findFirst: async () => ({ clinicId: 'c-tw', providerId: 'p-ho' }) },
    clinicNameAlias: { findFirst: async () => null },
    clinic: { findMany: async () => [] },
  }
  const r = await identifyClinic(prisma, baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: 'EC-101', shortCodeRaw: null, doctorRaw: null } }), { labId: null })
  assert.equal(r.clinicId, null)
  assert.equal(r.clinicBasis, 'MANUAL')
  assert.equal(r.providerIdFromCustomerNo, null)
})

test('identifyClinic：CLINIC_ALIAS 命中（rawNorm 同 normClinicName 一致）', async () => {
  const prisma: any = {
    labCustomerNo: { findFirst: async () => null },
    clinicNameAlias: {
      findFirst: async (args: any) => (args.where.rawNorm === '臻善牙科大圍' ? { clinicId: 'c-tw' } : null),
    },
    clinic: { findMany: async () => [] },
  }
  const r = await identifyClinic(prisma, baseRes({ billTo: { nameRaw: '臻善牙科（大圍）', addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }), { labId: 'lab-x1' })
  assert.equal(r.clinicId, 'c-tw')
  assert.equal(r.clinicBasis, 'CLINIC_ALIAS')
})

test('identifyClinic：ADDRESS — 英地址（shop 418 唔會食咗 18 號）＋中地址；兩間中 → 唔揀', async () => {
  const mkPrisma = (clinics: any[]) => ({
    labCustomerNo: { findFirst: async () => null },
    clinicNameAlias: { findFirst: async () => null },
    clinic: { findMany: async () => clinics },
  })
  // 英：18 Che Kung Miu Road 對上 Clinic.addressEn（shop 418 喺入面但門牌 18 先算）
  const r1 = await identifyClinic(
    mkPrisma([
      { id: 'c-tw', name: '臻善（大圍）', shortName: null, address: null, addressEn: 'Shop 418, Wai Fong, 18 Che Kung Miu Road, Tai Wai' },
      { id: 'c-418', name: 'X（旺角）', shortName: null, address: '418 Che Kung Miu Road', addressEn: null },
    ]),
    baseRes({ billTo: { nameRaw: null, addressRaw: '18 Che Kung Miu Road, Tai Wai', customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }),
    { labId: null },
  )
  assert.equal(r1.clinicId, 'c-tw')
  assert.equal(r1.clinicBasis, 'ADDRESS')

  // 中：車公廟路18號
  const r2 = await identifyClinic(
    mkPrisma([{ id: 'c-tw', name: '臻善（大圍）', shortName: null, address: '臻善 Artisan 車公廟路18號圍方418號舖', addressEn: null }]),
    baseRes({ billTo: { nameRaw: null, addressRaw: '車公廟路18號圍方', customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }),
    { labId: null },
  )
  assert.equal(r2.clinicBasis, 'ADDRESS')

  // 兩間中同一街道 → 唔確定 → MANUAL（落晒所有步）
  const r3 = await identifyClinic(
    mkPrisma([
      { id: 'c-a', name: 'A（甲地）', shortName: null, address: 'Che Kung Miu Road 18', addressEn: null },
      { id: 'c-b', name: 'B（乙地）', shortName: null, address: 'Che Kung Miu Road 18', addressEn: null },
    ]),
    baseRes({ billTo: { nameRaw: null, addressRaw: '18 Che Kung Miu Road', customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }),
    { labId: null },
  )
  assert.equal(r3.clinicBasis, 'MANUAL')
})

test('identifyClinic：SHORT_CODE 大階唔敏感完全一樣；兩間同 code → 唔揀', async () => {
  const mk = (clinics: any[]) => ({
    labCustomerNo: { findFirst: async () => null },
    clinicNameAlias: { findFirst: async () => null },
    clinic: { findMany: async () => clinics },
  })
  const r1 = await identifyClinic(
    mk([{ id: 'c-tw', name: '臻善（大圍）', shortName: 'tw', address: null, addressEn: null }]),
    baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: 'TW', doctorRaw: null } }),
    { labId: null },
  )
  assert.equal(r1.clinicBasis, 'SHORT_CODE')
  assert.equal(r1.clinicId, 'c-tw')

  const r2 = await identifyClinic(
    mk([
      { id: 'c-a', name: 'A', shortName: 'TW', address: null, addressEn: null },
      { id: 'c-b', name: 'B', shortName: 'tw', address: null, addressEn: null },
    ]),
    baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: 'TW', doctorRaw: null } }),
    { labId: null },
  )
  assert.equal(r2.clinicBasis, 'MANUAL')
})

test('identifyClinic：NAME 地區名（大圍）＋簡繁 湾→灣；兩間同地區 → 唔揀', async () => {
  const mk = (clinics: any[]) => ({
    labCustomerNo: { findFirst: async () => null },
    clinicNameAlias: { findFirst: async () => null },
    clinic: { findMany: async () => clinics },
  })
  const r1 = await identifyClinic(
    mk([{ id: 'c-tw', name: '臻善牙科（大圍）', shortName: null, address: null, addressEn: null }]),
    baseRes({ billTo: { nameRaw: '臻善牙科 大圍店', addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }),
    { labId: null },
  )
  assert.equal(r1.clinicBasis, 'NAME')
  assert.equal(r1.clinicId, 'c-tw')
  assert.equal(r1.evidence, '臻善牙科 大圍店')

  // 簡體 湾 → 灣 先得
  const r2 = await identifyClinic(
    mk([{ id: 'c-tkw', name: '滙樂牙科（土瓜灣）', shortName: null, address: null, addressEn: null }]),
    baseRes({ billTo: { nameRaw: '滙樂 土瓜湾', addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }),
    { labId: null },
  )
  assert.equal(r2.clinicBasis, 'NAME')

  // 兩間同地區 → 唔確定
  const r3 = await identifyClinic(
    mk([
      { id: 'c-a', name: 'A 牙科（大圍）', shortName: null, address: null, addressEn: null },
      { id: 'c-b', name: 'B 牙科（大圍）', shortName: null, address: null, addressEn: null },
    ]),
    baseRes({ billTo: { nameRaw: '大圍某店', addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }),
    { labId: null },
  )
  assert.equal(r3.clinicBasis, 'MANUAL')
})

test('identifyClinic：順序 — alias 贏過 shortCode；全部唔中 → MANUAL；STATEMENT 用 section.clinicRaw', async () => {
  const mk = (clinics: any[], aliasHit: boolean) => ({
    labCustomerNo: { findFirst: async () => null },
    clinicNameAlias: { findFirst: async (args: any) => (aliasHit && args.where.rawNorm === '滙樂土瓜湾' ? { clinicId: 'c-alias' } : null) },
    clinic: { findMany: async () => clinics },
  })
  const clinics = [{ id: 'c-sc', name: 'X（旺角）', shortName: 'WK', address: null, addressEn: null }]
  const r1 = await identifyClinic(mk(clinics, true), baseRes({ billTo: { nameRaw: '滙樂（土瓜湾）', addressRaw: null, customerNoRaw: null, shortCodeRaw: 'WK', doctorRaw: null } }), { labId: null })
  assert.equal(r1.clinicBasis, 'CLINIC_ALIAS')
  assert.equal(r1.clinicId, 'c-alias')

  const r2 = await identifyClinic(mk([], false), baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }), { labId: null })
  assert.equal(r2.clinicBasis, 'MANUAL')
  assert.equal(r2.clinicId, null)

  // STATEMENT：section.clinicRaw 做 alias 候選
  const statement: any = {
    ...baseRes({ kind: 'STATEMENT' }),
    billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
    sections: [{
      clinicRaw: '滙樂（土瓜湾）',
      doctorRaw: null,
      customerNoRaw: null,
      addressRaw: null,
      pageFrom: null, pageTo: null, total: null, currentTotal: null, lines: [],
    }],
  }
  const r3 = await identifyClinic(mk([], true), statement, { labId: null })
  assert.equal(r3.clinicBasis, 'CLINIC_ALIAS')
})

// ── §6.3 identifyProvider ─────────────────────────
test('identifyProvider：CUSTOMER_NO（§6.2.1 帶出）最優先', async () => {
  const prisma: any = { providerNameAlias: { findFirst: async () => ({ providerId: 'p-alias' }) }, provider: { findMany: async () => [] } }
  const r = await identifyProvider(prisma, baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: 'EC-101', shortCodeRaw: null, doctorRaw: 'Dr Ho' } }), {
    customerNoProviderId: 'p-cn',
    customerNoRaw: 'EC-101',
  })
  assert.equal(r.providerId, 'p-cn')
  assert.equal(r.providerBasis, 'CUSTOMER_NO')
})

test('identifyProvider：DOCTOR_ALIAS 命中', async () => {
  const prisma: any = {
    providerNameAlias: { findFirst: async (args: any) => (args.where.rawNorm === 'hokachun何嘉俊' ? { providerId: 'p-ho' } : null) },
    provider: { findMany: async () => [] },
  }
  const r = await identifyProvider(prisma, baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: 'Dr.Ho Ka Chun 何嘉俊醫生' } }), {
    customerNoProviderId: null,
    customerNoRaw: null,
  })
  assert.equal(r.providerId, 'p-ho')
  assert.equal(r.providerBasis, 'DOCTOR_ALIAS')
})

test('identifyProvider：NAME — norm 後相等；英文名全部字包含（只一個中先揀）', async () => {
  const mk = (providers: any[]) => ({
    providerNameAlias: { findFirst: async () => null },
    provider: { findMany: async () => providers },
  })
  // 相等：'Dr. 何嘉俊 醫生' → '何嘉俊' == provider '何嘉俊醫生' → '何嘉俊'
  const r1 = await identifyProvider(mk([{ id: 'p-ho', name: '何嘉俊醫生', shortName: null }]), baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: 'Dr. 何嘉俊 醫生' } }), { customerNoProviderId: null, customerNoRaw: null })
  assert.equal(r1.providerBasis, 'NAME')
  assert.equal(r1.providerId, 'p-ho')

  // 全字包含：'Ho Ka Chun' ⊂ 'Dr.Ho Ka Chun 何嘉俊醫生'
  const r2 = await identifyProvider(mk([{ id: 'p-ho', name: 'Dr.Ho Ka Chun 何嘉俊醫生', shortName: null }]), baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: 'Ho Ka Chun' } }), { customerNoProviderId: null, customerNoRaw: null })
  assert.equal(r2.providerBasis, 'NAME')

  // 兩個中 → 唔確定 → MANUAL
  const r3 = await identifyProvider(mk([
    { id: 'p-a', name: 'Dr.Ho Ka Chun 何嘉俊醫生', shortName: null },
    { id: 'p-b', name: 'Ho Ka Chun 何嘉俊醫生', shortName: null },
  ]), baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: 'Ho Ka Chun' } }), { customerNoProviderId: null, customerNoRaw: null })
  assert.equal(r3.providerBasis, 'MANUAL')
  assert.equal(r3.providerId, null)
})

test('identifyProvider：冇醫生名 → MANUAL；單字英文（Lee）唔會靠包含命中', async () => {
  const prisma: any = {
    providerNameAlias: { findFirst: async () => null },
    provider: { findMany: async () => [{ id: 'p-lee', name: 'Dr. Lee 李医生', shortName: null }, { id: 'p-wong', name: 'Wong Ka Mei 黃嘉美', shortName: null }] },
  }
  const r1 = await identifyProvider(prisma, baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null } }), { customerNoProviderId: null, customerNoRaw: null })
  assert.equal(r1.providerBasis, 'MANUAL')

  const r2 = await identifyProvider(prisma, baseRes({ billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: 'Lee' } }), { customerNoProviderId: null, customerNoRaw: null })
  assert.equal(r2.providerBasis, 'MANUAL') // 'lee' 單字 < 2 words → 包含規則唔啟用
})

test('identifyProvider：STATEMENT 用 section.doctorRaw', async () => {
  const prisma: any = {
    providerNameAlias: { findFirst: async (args: any) => (args.where.rawNorm === 'hokachun何嘉俊' ? { providerId: 'p-ho' } : null) },
    provider: { findMany: async () => [] },
  }
  const statement: any = {
    ...baseRes({ kind: 'STATEMENT' }),
    billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
    sections: [{
      clinicRaw: null,
      doctorRaw: 'Dr.Ho Ka Chun 何嘉俊醫生',
      customerNoRaw: null,
      addressRaw: null,
      pageFrom: null, pageTo: null, total: null, currentTotal: null, lines: [],
    }],
  }
  const r = await identifyProvider(prisma, statement, { customerNoProviderId: null, customerNoRaw: null })
  assert.equal(r.providerBasis, 'DOCTOR_ALIAS')
})
