// ★ cwm-reconclinic-20261006：由 upload/route.ts 搬出嚟（parse 同 upload 共用）
import { prisma } from '@/lib/prisma'

/**
 * ★ cwm-recon-clinic-20260909 A2：由報表 meta.clinic 搵返 Clinic。
 * ★★★ 搵唔到／冇 apricotClinicId 一律 throw —— 【唔准】fallback 去「全部診所」。
 *    今次個 bug 就係因為 meta.clinic 讀咗但冇用，靜靜對晒全部診所，
 *    畫面照樣出一個「差異」數字，冇人知係口徑錯。寧願上載失敗都唔好出錯數。
 * ★ 錯誤訊息用 REPORT_ 開頭 → upload catch 會當用戶錯誤回 422，唔會當 500。
 */
export async function resolveClinic(metaClinic: string) {
	const key = (metaClinic || '').trim()
	if (!key) {
		throw new Error('REPORT_CLINIC_MISSING: 報表冇 Clinic 欄，判斷唔到係邊間診所嘅數')
	}
	const clinics = await prisma.clinic.findMany({
		select: { id: true, name: true, shortName: true, apricotClinicId: true },
	})
	const norm = (s: string | null) => (s ?? '').trim().toLowerCase()
	const hit =
		clinics.find(c => c.apricotClinicId && norm(c.apricotClinicId) === norm(key)) ??
		clinics.find(c => c.shortName && norm(c.shortName) === norm(key)) ??
		clinics.find(c => norm(c.name) === norm(key))

	if (!hit) {
		throw new Error(
			`REPORT_CLINIC_UNKNOWN: 報表寫住 Clinic「${key}」，但系統搵唔到對應診所。` +
			`已知診所：${clinics.map(c => c.shortName || c.name).join('／')}`,
		)
	}
	if (!hit.apricotClinicId) {
		throw new Error(
			`REPORT_CLINIC_NO_APRICOT_ID: 診所「${hit.shortName || hit.name}」冇設定 apricotClinicId，` +
			`對唔到 PaymentAllocation.clinicExtId。請先喺診所設定補返。`,
		)
	}
	return hit
}

