export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { withApricotLockRetry, searchPatients } from '@/lib/apricot/client'
import { listApricotAccounts, withApricotAccount, normalizeApricotAccount } from '@/lib/apricot/account'
import { defaultSourceName } from '@/lib/apricot/sources'
import { sourceErrorText } from '@/lib/patient-search'
import { probeTarget, phoneSearchVariants, patientPhoneStrings, phoneFieldMatches, phoneShape } from '@/lib/apricot/phone-probe'

// ============================================================
// POST /api/internal/apricot-phone-probe — Apricot「用電話搵病人」探測（唯讀，一次性診斷）
// cwi-patient-identify-probe-20261017
//
// body: { phone: string }（任何寫法：91234567／+852 9123 4567／13812345678／+86 …）
// 做法：逐個 Apricot 帳號 × 逐種寫法打 clinic-patients?keyword=（同病人搜尋頁同一條 API），
//   再核對回嘅病人電話欄係咪同一個號碼。
//
// 🔴 只回：帳號顯示名、寫法格式（數字變 d）、回應筆數、核對到嘅筆數、電話欄格式形狀、欄位名。
//    零病人資料（冇姓名、編號、id、電話數字）；log 亦只記筆數。號碼本身唔寫 log、唔落庫。
// 🔴 唔寫 Apricot（只係搜尋）；同病人搜尋一樣經 withApricotLockRetry（唔同其他 sync 爭鎖）。
// 驗證：x-cron-key = APRICOT_CRON_KEY（同 sync-availability 同一個 key；未設 = 503）。
// ============================================================

function safeTokenEqual(header: string | null, expected: string): boolean {
  if (!header) return false
  const a = Buffer.from(header, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const PAUSE_MS = 300

export async function POST(req: NextRequest) {
  const expected = process.env.APRICOT_CRON_KEY
  if (!expected) return NextResponse.json({ error: 'cron key not configured' }, { status: 503 })
  if (!safeTokenEqual(req.headers.get('x-cron-key'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => null)) as { phone?: unknown } | null
  const target = typeof body?.phone === 'string' ? probeTarget(body.phone) : null
  if (!target) return NextResponse.json({ error: 'phone 格式認唔到（要 8 位香港號、852／86 開頭或 11 位內地手機號）' }, { status: 400 })

  const clinics = await prisma.clinic.findMany({
    where: { apricotClinicId: { not: null } },
    select: { name: true, apricotAccount: true },
    orderBy: { name: 'asc' },
  })
  const labelOf = (account: string) =>
    defaultSourceName(clinics.filter(c => normalizeApricotAccount(c.apricotAccount) === account).map(c => c.name))

  const t0 = Date.now()
  const variants = phoneSearchVariants(target)
  const accounts = []
  for (const account of await listApricotAccounts()) {
    const rows = []
    const matchedShapes = new Set<string>()
    let fieldNames: string[] = []
    let accountError: string | null = null
    for (const v of variants) {
      const t1 = Date.now()
      try {
        const raw = await withApricotAccount(account, () => withApricotLockRetry(() => searchPatients(v)))
        const arr = Array.isArray(raw) ? raw : []
        if (!fieldNames.length && arr[0] && typeof arr[0] === 'object') fieldNames = Object.keys(arr[0]).sort()
        let verified = 0
        for (const p of arr) {
          const hits = patientPhoneStrings(p).filter(f => phoneFieldMatches(f, target))
          if (hits.length) {
            verified++
            hits.forEach(f => matchedShapes.add(phoneShape(f)))
          }
        }
        rows.push({ variant: phoneShape(v), found: arr.length, verified, ms: Date.now() - t1 })
      } catch (e) {
        const err = sourceErrorText(e)
        rows.push({ variant: phoneShape(v), found: 0, verified: 0, ms: Date.now() - t1, error: err })
        if (/憑證|未設定/.test(err)) { accountError = err; break } // 成個帳號用唔到 → 唔使逐種試
      }
      await new Promise(r => setTimeout(r, PAUSE_MS))
    }
    console.info(`[phone-probe] 來源=${labelOf(account)} ${rows.map(r => `${r.variant}:${r.found}/${r.verified}`).join(' ')}`)
    accounts.push({
      source: labelOf(account),
      error: accountError,
      variants: rows,
      // Apricot 病人檔電話欄實際格式（數字變 d）— 決定正規化要處理邊啲寫法
      storedPhoneShapes: [...matchedShapes],
      // 病人物件有咩欄位（只欄位名）— 確認電話欄叫咩
      fieldNames,
    })
  }

  return NextResponse.json({
    kind: target.kind,
    variantsTried: variants.length,
    durationMs: Date.now() - t0,
    accounts,
  })
}
