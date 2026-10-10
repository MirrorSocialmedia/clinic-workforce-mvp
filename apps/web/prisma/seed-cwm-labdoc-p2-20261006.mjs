#!/usr/bin/env node
/**
 * cwm-labdoc P2 seed（工單 CHUNK 5「seed 補」）：
 *   1. 五間 Lab（Goodwill/KEA/Modern/Sodental/Excel）— 固定 id，冪等
 *   2. LabProfile ×5 + LabAlias（與 seed-cwm-labdoc-20261005.mjs 同口徑 —
 *      含 Sodental 兩 PAYEE：honestygiftsintl（禾呈大圍 HONESTY GIFTS，老細已確認）+ sodental（土瓜灣））
 *   3. Clinics：臻善牙科（大圍2）（shortName TW，addressEn = 圍方 418）＋ 滙樂牙科（土瓜湾）（shortName TKW）
 *   4. Providers：Dr Esmond Tong ＋ Dr Yiu Tsz Ching（姚子晴）＋ ProviderClinic 連 TKW 店（工單已定決定 3）
 *   5. ClinicNameAlias：'huilokdentaltukwawan' → TKW（e2e fixture 「HUI LOK DENTAL (TUK WA WAN)」識別用）
 *
 * 冪等：固定 id + SELECT-then-INSERT / ON CONFLICT；零 delete（重跑安全）。
 * 為什麼需要：P1 seed 對「搵唔到嘅 lab」只係 warn + 跳過（假設 prod 已有）；
 *   P2 嘅 fresh DB cwm_labdoc_p2 冇任何 lab/clinic/provider — 識別鏈（§6.1–6.3）
 *   同 T9 dedup（partial unique index 要 labId 非 null）都係死嘅。
 *
 * ⚠ 2026-10-10 修（模擬發現）：
 *   - Lab 改用 name upsert（正式庫已有同名 Lab、id 唔同 → 舊 ON CONFLICT (id) 撞 Lab_name_key 直接 crash）；
 *     profile／alias 用返 DB 實際 lab id。
 *   - 第 3–5 步（測試診所／醫生／HUI LOK alias）只係 e2e fixture — 預設唔跑；
 *     要 LABDOC_SEED_FIXTURES=1 先寫（正式庫千祈唔好開）。
 *
 * Run: DATABASE_URL="postgresql://..." node prisma/seed-cwm-labdoc-p2-20261006.mjs
 *      e2e／fresh DB：LABDOC_SEED_FIXTURES=1 DATABASE_URL=... node prisma/seed-cwm-labdoc-p2-20261006.mjs
 *   （DATABASE_URL 可以帶 ?schema=public — 此處會剷走 query 部分俾 pg）
 */
import pg from 'pg'

const DATABASE_URL = (process.env.DATABASE_URL ?? '').split('?')[0]
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1) }
const SEED_BY = 'seed:cwm-labdoc-p2-20261006'

// 同 P1 seed 完全一致嘅 lab 定義（profiles/aliases 口徑唔好分叉）
const LABS = [
  {
    id: 'labdocseedgoodwill0000001', key: 'goodwill', name: 'Goodwill', sortOrder: 10,
    profile: { statementKind: 'INVOICE_LIST', statementDocNoSameAsInvoice: true, defaultDocNoKind: 'INVOICE_NO', extractionHint: null },
    aliases: [
      ['NAME_EN', 'goodwill'],
      ['NAME_CN', '佳譽'],
      ['PAYEE', 'goodwill'],
    ],
  },
  {
    id: 'labdocseedkea000000000001', key: 'kea', name: 'KEA', sortOrder: 20,
    profile: {
      statementKind: 'INVOICE_LIST', statementDocNoSameAsInvoice: true, defaultDocNoKind: 'CASE_NO',
      extractionHint: "D/C % 係收費百分比（80 = 收 80%）；amount 用 U'Price／Amount 欄。",
    },
    aliases: [['NAME_EN', 'kea']],
  },
  {
    id: 'labdocseedmodern00000000001', key: 'modern', name: 'Modern', sortOrder: 30,
    profile: {
      statementKind: 'INVOICE_LIST', statementDocNoSameAsInvoice: false, defaultDocNoKind: 'INVOICE_NO',
      extractionHint: 'amount 用 DEBIT 欄，唔好用 BALANCE（累計）欄；CREDIT 欄係貸項（負數）。',
    },
    aliases: [
      ['NAME_EN', 'modern'],
      ['NAME_CN', '現代'],
      ['PAYEE', 'modern'],
    ],
  },
  {
    id: 'labdocseedsodental000000001', key: 'sodental', name: 'Sodental', sortOrder: 40,
    profile: {
      statementKind: 'DETAIL', statementDocNoSameAsInvoice: true, defaultDocNoKind: 'INVOICE_NO',
      extractionHint: '產品結算表：每頁一個醫生；INVOICE# 係合併儲存格，空白行沿用上一個單號；每行要抄牙位、單位、單價、數量、總額。',
    },
    aliases: [
      ['NAME_EN', 'sodental'],
      ['NAME_CN', '禾呈'],
      ['PAYEE', 'honestygiftsintl'], // "HONESTY GIFTS INT'L LIMITED"（禾呈大圍 — 老細已確認合法收款人）
      ['PAYEE', 'sodental'],         // "SODENTAL COMPANY LIMITED"（土瓜灣）
    ],
  },
  {
    id: 'labdocseedexcel00000000001', key: 'excel', name: 'Excel', sortOrder: 50,
    profile: {
      statementKind: 'OUTSTANDING', statementDocNoSameAsInvoice: true, defaultDocNoKind: 'INVOICE_NO',
      extractionHint: '病人欄格式：姓名 [4 位病人編號] [7 位 Lab 編號]；7 位數字係 labCaseRef，唔係病人編號。',
    },
    aliases: [
      ['NAME_EN', 'excel'],
      ['PAYEE', 'excel'],
    ],
  },
]

// §6.2 shortName 對照（工單已定決定 1）：TW=大圍 / TKW=土瓜灣
const CLINICS = [
  {
    id: 'labdocseedtwclinic00000001',
    name: '臻善牙科（大圍2）',
    shortName: 'TW',
    address: '新界大圍車公廟路18號圍方418號舖',
    addressEn: 'Shop 418, Wai Fong, 18 Che Kung Miu Road, Tai Wai',
  },
  {
    id: 'labdocseedtkwclinic000001',
    name: '滙樂牙科（土瓜湾）',
    shortName: 'TKW',
    address: null,
    addressEn: null,
  },
]

const PROVIDERS = [
  { id: 'labdocseedprovtkw000000001', name: 'Dr Esmond Tong', tkw: true },
  { id: 'labdocseedprovtkw000000002', name: 'Dr Yiu Tsz Ching（姚子晴）', tkw: true },
]

// normClinicName 複製（identify.ts §6.1：全形轉半形→細階→去非 a-z0-9/CJK）
function normClinicName(s) {
  return s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

const client = new pg.Client({ connectionString: DATABASE_URL })
await client.connect()

// 1. Labs（按 name upsert — 已有同名 Lab 就用佢嘅 id，唔郁 sortOrder）
for (const lab of LABS) {
  const r = await client.query(
    `INSERT INTO "Lab" (id, name, "isActive", "sortOrder", "createdAt", "updatedAt")
     VALUES ($1, $2, true, $3, now(), now())
     ON CONFLICT (name) DO UPDATE SET "updatedAt" = "Lab"."updatedAt"
     RETURNING id`,
    [lab.id, lab.name, lab.sortOrder],
  )
  const dbId = r.rows[0].id
  console.log(`Lab ${lab.name}: ${dbId === lab.id ? '已建／seed id' : '已存在'}（${dbId}）`)
  lab.id = dbId
}

// 2. LabProfile + LabAlias
for (const lab of LABS) {
  const p = lab.profile
  await client.query(
    `INSERT INTO "LabProfile" ("labId", "statementKind", "statementDocNoSameAsInvoice", "defaultDocNoKind", "extractionHint", "updatedBy", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT ("labId") DO UPDATE
       SET "statementKind" = EXCLUDED."statementKind",
           "statementDocNoSameAsInvoice" = EXCLUDED."statementDocNoSameAsInvoice",
           "defaultDocNoKind" = EXCLUDED."defaultDocNoKind",
           "extractionHint" = EXCLUDED."extractionHint",
           "updatedBy" = EXCLUDED."updatedBy",
           "updatedAt" = now()`,
    [lab.id, p.statementKind, p.statementDocNoSameAsInvoice, p.defaultDocNoKind, p.extractionHint, SEED_BY],
  )
  console.log(`LabProfile ${lab.name}: 寫入（${p.statementKind} / ${p.defaultDocNoKind}）`)
  for (const [kind, rawNorm] of lab.aliases) {
    // 同 P1 seed 同一 fixedId 公式（必含 rawNorm — 同一 lab 可有多條同 kind alias）
    const fixedId = 'labdocseed' + lab.key + kind.toLowerCase().replace(/[^a-z]/g, '') + rawNorm.replace(/[^a-z0-9]/g, '')
    const r = await client.query(
      `INSERT INTO "LabAlias" (id, "labId", kind, "rawNorm", "createdBy", "createdAt")
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (kind, "rawNorm") DO NOTHING`,
      [fixedId, lab.id, kind, rawNorm, SEED_BY],
    )
    console.log(`LabAlias ${kind} ${rawNorm} → ${lab.name}: ${r.rowCount ? '已建' : '已存在/被佔'}`)
  }
}

const FIXTURES = process.env.LABDOC_SEED_FIXTURES === '1'
if (!FIXTURES) {
  console.log('（略過第 3–5 步：測試診所／醫生／HUI LOK alias — e2e 先要 LABDOC_SEED_FIXTURES=1）')
  await client.end()
  console.log('seed-cwm-labdoc-p2-20261006: done（只 Lab／profile／alias）')
  process.exit(0)
}

// 3. Clinics（只 e2e fixture）
for (const c of CLINICS) {
  const r = await client.query(
    `INSERT INTO "Clinic" (id, name, "shortName", address, "addressEn", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, "shortName" = EXCLUDED."shortName",
           address = EXCLUDED.address, "addressEn" = EXCLUDED."addressEn", "updatedAt" = now()
     RETURNING id`,
    [c.id, c.name, c.shortName, c.address, c.addressEn],
  )
  console.log(`Clinic ${c.name}（${c.shortName}）: ${r.rowCount ? '已建' : '已存在'}（${r.rows[0].id}）`)
}

// 4. Providers + ProviderClinic（TKW）
const tkwClinicId = CLINICS[1].id
for (const p of PROVIDERS) {
  await client.query(
    `INSERT INTO "Provider" (id, name, "isActive", "sortOrder", "createdAt", "updatedAt")
     VALUES ($1, $2, true, 0, now(), now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = now()`,
    [p.id, p.name],
  )
  console.log(`Provider ${p.name}: 已建`)
  if (p.tkw) {
    await client.query(
      `INSERT INTO "ProviderClinic" (id, "providerId", "clinicId", "createdAt")
       VALUES ($1, $2, $3, now())
       ON CONFLICT ("providerId", "clinicId") DO NOTHING`,
      ['labdocseedpc' + p.id.slice(-6), p.id, tkwClinicId],
    )
    console.log(`ProviderClinic ${p.name} → TKW: 已建`)
  }
}

// 5. ClinicNameAlias（e2e fixture 識別口徑；rawNorm 用 identify.ts 同一 norm）
{
  const raw = 'HUI LOK DENTAL (TUK WA WAN)'
  const rn = normClinicName(raw)
  await client.query(
    `INSERT INTO "ClinicNameAlias" (id, "rawNorm", "clinicId", "createdBy", "createdAt")
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT ("rawNorm") DO NOTHING`,
    ['labdocseedcna00000000001', rn, tkwClinicId, SEED_BY],
  )
  console.log(`ClinicNameAlias ${rn} → TKW: 已建`)
}

await client.end()
console.log('seed-cwm-labdoc-p2-20261006: done')
