/**
 * ★ 2026-10-11：KIOSK（店舖公用機）用 Lab 單據 — 只睇到、只處理自己間店。
 *
 * 老闆拍板：KIOSK 開咗 lab_invoice／lab_statement 之後可以喺店舖上傳 Lab 單，
 *   上傳默認係嗰間店；KIOSK 只見自己店嘅單（其他店病人嘅 Lab 單唔應該喺公用機見到）。
 *
 * 一般帳號（OWNER／MANAGER／有權限嘅員工）照舊：labdoc 全集團（B16）。
 * role 判斷全部喺呢度（route 唔准寫死角色 — check-role-hardcode-api.sh）。
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resolveClinicScope } from '@/lib/scope-helpers'

type Sess = { role: string; userId: string; clinics?: string[] | null }

/** KIOSK → 佢嘅店（冇店 = []，乜都睇唔到）；其他 → null（唔收窄）。 */
export function kioskClinics(session: Sess): string[] | null {
  if (session.role !== 'KIOSK') return null
  return [...(session.clinics ?? [])]
}

/** labdoc route 統一範圍：KIOSK = 自己店；其他 = resolveClinicScope companyWide（全集團）。 */
export async function labdocScope(session: Sess, perms: string[] | null | undefined): Promise<string[] | null> {
  const k = kioskClinics(session)
  if (k) return k
  return resolveClinicScope(session as any, perms ?? [], { companyWide: ['lab_invoice', 'lab_statement'] })
}

/** 單據喺唔喺 KIOSK 範圍：單據診所、上傳店、或者有分段係佢間店。 */
export async function kioskDocAllowed(session: Sess, docId: string): Promise<boolean> {
  const mine = kioskClinics(session)
  if (!mine) return true
  if (mine.length === 0) return false
  const doc = await prisma.labDocument.findUnique({
    where: { id: docId },
    select: { clinicId: true, uploadClinicId: true, sections: { select: { clinicId: true } } },
  })
  if (!doc) return false
  return (
    (!!doc.clinicId && mine.includes(doc.clinicId)) ||
    (!!doc.uploadClinicId && mine.includes(doc.uploadClinicId)) ||
    doc.sections.some((s) => !!s.clinicId && mine.includes(s.clinicId))
  )
}

/** 404 回應（唔講係權限問題，等 KIOSK 估唔到其他店有乜單）。 */
export async function kioskDocGuard(session: Sess, docId: string): Promise<NextResponse | null> {
  if (await kioskDocAllowed(session, docId)) return null
  return NextResponse.json({ error: '單據唔存在' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
}

/** 月結單分段：KIOSK 只可以處理自己店或者未揀診所嘅分段。 */
export function kioskSectionAllowed(session: Sess, sectionClinicId: string | null): boolean {
  const mine = kioskClinics(session)
  if (!mine) return true
  return sectionClinicId === null || mine.includes(sectionClinicId)
}

/** 列表 where：KIOSK 只列自己店（單據診所／上傳店／分段）。 */
export function kioskDocWhere(session: Sess): Record<string, unknown> | null {
  const mine = kioskClinics(session)
  if (!mine) return null
  return {
    OR: [
      { clinicId: { in: mine } },
      { uploadClinicId: { in: mine } },
      { sections: { some: { clinicId: { in: mine } } } },
    ],
  }
}

/**
 * 上傳店：KIOSK 一間店 → 自動；幾間店 → 要喺表單揀（requested 必須係佢嘅店）；其他帳號 → null（照舊由讀單識別）。
 */
export function kioskUploadClinic(session: Sess, requested: string | null): { clinicId: string | null } | { error: string } {
  const mine = kioskClinics(session)
  if (!mine) return { clinicId: null }
  if (mine.length === 0) return { error: '呢部 KIOSK 未設定店舖，唔可以上傳' }
  if (mine.length === 1) return { clinicId: mine[0] }
  if (!requested || !mine.includes(requested)) return { error: '請揀上傳嘅店舖' }
  return { clinicId: requested }
}

/** KIOSK 唔可以改 Lab 設定（別名、月結單類型等係全集團設定）。 */
export function kioskSettingsDenied(session: Sess): NextResponse | null {
  if (!kioskClinics(session)) return null
  return NextResponse.json({ error: 'KIOSK 唔可以改 Lab 設定' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
}
