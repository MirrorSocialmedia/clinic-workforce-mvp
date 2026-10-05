#!/usr/bin/env node
/**
 * cwm-labdoc P1 seed（施工單 §3.3）：Lab / LabProfile / LabAlias + Clinic.addressEn
 *
 * 冪等：固定 id + ON CONFLICT（重跑安全；不刪任何 row）。
 *
 * 內容（§2.3 五間 Lab 嘅已知格式）：
 *   1. Lab「Excel」：name ILIKE '%excel%' 冇 → 建（sortOrder 排最後）
 *   2. LabProfile：五間（Goodwill/KEA/Modern/Sodental/Excel）— 按 name ILIKE 搵 lab id；
 *      搵唔到 → console.warn + 跳過（其餘四間應該已喺 prod；dev 環境可能全部跳過 = 預期）
 *   3. LabAlias：NAME_EN / NAME_CN / PAYEE（normLabName §6.1 預正規化 — P2 實現必須同呢啲值一致）
 *   4. Clinic.addressEn：大圍（name ILIKE '%大圍%'）→ 'Shop 418, Wai Fong, 18 Che Kung Miu Road, Tai Wai'
 *
 * Run: DATABASE_URL=postgresql://... node prisma/seed-cwm-labdoc-20261005.mjs
 */
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1) }

const SEED_BY = 'seed:cwm-labdoc-20261005'

// §2.3 五間 Lab：dbPatterns = 搵已有 lab 用嘅 name ILIKE 順序；
// aliases = [kind, rawNorm]（rawNorm 已照 §6.1 normLabName 正規化：
//   轉細階 → 全形轉半形 → 去標點同空格 → 去 limited|ltd|co|company|laboratory|lab|dental|solutions|有限公司|牙科器材|牙科）
const LABS = [
  {
    key: 'goodwill',
    name: 'Goodwill',
    dbPatterns: ['%goodwill%', '%佳譽%'],
    profile: { statementKind: 'INVOICE_LIST', statementDocNoSameAsInvoice: true, defaultDocNoKind: 'INVOICE_NO', extractionHint: null },
    aliases: [
      ['NAME_EN', 'goodwill'],                 // "Goodwill"
      ['NAME_CN', '佳譽'],                     // "佳譽牙科器材有限公司"
      ['PAYEE', 'goodwill'],                   // "Goodwill Dental Laboratory Limited"
    ],
  },
  {
    key: 'kea',
    name: 'KEA',
    dbPatterns: ['%kea%'],
    profile: {
      statementKind: 'INVOICE_LIST',
      statementDocNoSameAsInvoice: true,       // §2.3：未核實 → 預設 true（待 P3 真 KEA 月結單核實）
      defaultDocNoKind: 'CASE_NO',             // 冇 invoice 單號；Case No. 0254131
      extractionHint: "D/C % 係收費百分比（80 = 收 80%）；amount 用 U'Price／Amount 欄。",
    },
    aliases: [
      ['NAME_EN', 'kea'],                      // "KEA Dental Solutions"
    ],
  },
  {
    key: 'modern',
    name: 'Modern',
    dbPatterns: ['%modern%', '%現代%'],
    profile: {
      statementKind: 'INVOICE_LIST',
      statementDocNoSameAsInvoice: false,      // §2.3：月結單用 IN-MDL... → 預設 false（未核實）
      defaultDocNoKind: 'INVOICE_NO',
      extractionHint: 'amount 用 DEBIT 欄，唔好用 BALANCE（累計）欄；CREDIT 欄係貸項（負數）。',
    },
    aliases: [
      ['NAME_EN', 'modern'],                   // "Modern"
      ['NAME_CN', '現代'],                     // "現代牙科器材"
      ['PAYEE', 'modern'],                     // "Modern Dental Laboratory Company Limited"
    ],
  },
  {
    key: 'sodental',
    name: 'Sodental',
    dbPatterns: ['%sodental%', '%禾呈%'],
    profile: {
      statementKind: 'DETAIL',
      statementDocNoSameAsInvoice: true,
      defaultDocNoKind: 'INVOICE_NO',
      extractionHint: '產品結算表：每頁一個醫生；INVOICE# 係合併儲存格，空白行沿用上一個單號；每行要抄牙位、單位、單價、數量、總額。',
    },
    aliases: [
      ['NAME_EN', 'sodental'],                 // "Sodental"
      ['NAME_CN', '禾呈'],                     // "禾呈牙科器材"
      ['PAYEE', 'honestygiftsintl'],           // "HONESTY GIFTS INT'L LIMITED"（大圍）
      ['PAYEE', 'sodental'],                   // "SODENTAL COMPANY LIMITED"（土瓜灣）
    ],
  },
  {
    key: 'excel',
    name: 'Excel',
    dbPatterns: ['%excel%'],
    profile: {
      statementKind: 'OUTSTANDING',
      statementDocNoSameAsInvoice: true,
      defaultDocNoKind: 'INVOICE_NO',
      extractionHint: '病人欄格式：姓名 [4 位病人編號] [7 位 Lab 編號]；7 位數字係 labCaseRef，唔係病人編號。',
    },
    aliases: [
      ['NAME_EN', 'excel'],                    // "Excel"
      ['PAYEE', 'excel'],                      // "Excel Dental Lab Limited"
    ],
  },
]

const client = new pg.Client({ connectionString: DATABASE_URL })
await client.connect()

// ------------------------------------------------------------------
// 1. Lab「Excel」：冇就建（sortOrder 排最後）
// ------------------------------------------------------------------
async function findLab(patterns) {
  for (const p of patterns) {
    const r = await client.query(`SELECT id, name FROM "Lab" WHERE name ILIKE $1 LIMIT 1`, [p])
    if (r.rows[0]) return r.rows[0]
  }
  return null
}

let excelLab
{
  const found = await findLab(['%excel%'])
  if (found) {
    excelLab = found
    console.log(`Lab Excel: 已存在（${found.name} / ${found.id}）`)
  } else {
    const r = await client.query(
      `INSERT INTO "Lab" (id, name, "isActive", "sortOrder", "createdAt", "updatedAt")
       SELECT 'labdocseedexcel0000000001', 'Excel', true,
              COALESCE((SELECT MAX("sortOrder") FROM "Lab"), 0) + 1, now(), now()
       RETURNING id`,
    )
    excelLab = { id: r.rows[0].id, name: 'Excel' }
    console.log(`Lab Excel: 已建（${excelLab.id}）`)
  }
}

// ------------------------------------------------------------------
// 2/3. LabProfile + LabAlias
// ------------------------------------------------------------------
for (const labDef of LABS) {
  const lab = labDef.key === 'excel' ? excelLab : await findLab(labDef.dbPatterns)
  if (!lab) {
    console.warn(`Lab ${labDef.name}: 搵唔到（${labDef.dbPatterns.join(' / ')}）— 跳過 profile/alias（§3.3：搵唔到就跳過並警告）`)
    continue
  }
  // profile upsert（labId = pk）
  const p = labDef.profile
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
  console.log(`LabProfile ${labDef.name}: 寫入（${p.statementKind} / docNoSame=${p.statementDocNoSameAsInvoice} / ${p.defaultDocNoKind}）`)
  // aliases（固定 id；(kind, rawNorm) 全球 unique — 被其他 lab 佔咗就 DO NOTHING + 警告）
  for (const [kind, rawNorm] of labDef.aliases) {
    // ⚠️ fixedId 必含 rawNorm — 同一 lab 可以有多條同 kind alias（例 Sodental 兩 PAYEE），
    //    只含 key+kind 會令兩條 row 撞 LabAlias_pkey → 23505（ON CONFLICT (kind,rawNorm) 唔覆蓋 PK）
    const fixedId = 'labdocseed' + labDef.key + kind.toLowerCase().replace(/[^a-z]/g, '') + rawNorm.replace(/[^a-z0-9]/g, '')
    const r = await client.query(
      `INSERT INTO "LabAlias" (id, "labId", kind, "rawNorm", "createdBy", "createdAt")
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (kind, "rawNorm") DO NOTHING`,
      [fixedId, lab.id, kind, rawNorm, SEED_BY],
    )
    if (r.rowCount === 0) {
      const owner = await client.query(`SELECT "labId" FROM "LabAlias" WHERE kind=$1 AND "rawNorm"=$2`, [kind, rawNorm])
      const ownerLabId = owner.rows[0]?.labId
      if (ownerLabId === lab.id) console.log(`LabAlias ${kind} ${rawNorm} (${labDef.name}): 已存在 — 跳過`)
      else console.warn(`LabAlias ${kind} ${rawNorm} (${labDef.name}): 已被其他 Lab 佔用（labId=${ownerLabId}）— 跳過`)
    } else {
      console.log(`LabAlias ${kind} ${rawNorm} → ${labDef.name}`)
    }
  }
}

// ------------------------------------------------------------------
// 4. Clinic.addressEn（§6.2：大圍 = 臻善 Artisan 車公廟路18號圍方418號舖）
// ------------------------------------------------------------------
{
  const addr = 'Shop 418, Wai Fong, 18 Che Kung Miu Road, Tai Wai'
  const r = await client.query(
    `UPDATE "Clinic" SET "addressEn" = $1
     WHERE name ILIKE '%大圍%' AND ("addressEn" IS NULL OR "addressEn" <> $1)`,
    [addr],
  )
  if (r.rowCount > 0) console.log(`Clinic.addressEn: 大圍 → ${addr}（${r.rowCount} 間）`)
  else console.log('Clinic.addressEn: 大圍 clinic 唔存在或已有正確值 — 跳過')
}

await client.end()
console.log('seed-cwm-labdoc-20261005: done')
