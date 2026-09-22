// ★ cwm-consistency Stage 1.1：同一員工嘅「排班／假期／打卡／補登／時間帳戶」寫入串行化
//   pg_advisory_xact_lock：tx commit／rollback 自動釋放，唔會漏 unlock。
//   只鎖同一個員工 —— 唔同員工照樣並行（20 人同時打卡互不排隊）。
import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'

export async function lockEmployee(tx: Prisma.TransactionClient, employeeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'emp:' + employeeId}))`
}

/** 兩個員工（例如交換）→ 按 id 排序先鎖，避免 deadlock */
export async function lockEmployees(tx: Prisma.TransactionClient, ids: Array<string | null | undefined>): Promise<void> {
  for (const id of [...new Set(ids.filter(Boolean) as string[])].sort()) await lockEmployee(tx, id)
}

/** tx 入面 throw → route catch 轉 HTTP status（業務衝突唔好變 500） */
export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message)
  }
}

/** ★ cwm-provroster B3（CHECK P-3）：generic key 版鎖（同 lockEmployee 同一把 pg_advisory_xact_lock，
 *  key 前綴自己揀，例如 `prov:${providerId}` 串行醫生休假寫入）。 */
export const lockKey = (tx: any, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`

/** route catch 用：HttpError / P2002 → response；其他 → null（交返原本處理） */
export function toHttpResponse(e: any, dupMessage = '已處理（重複提交）'): NextResponse | null {
  if (e instanceof HttpError) return NextResponse.json({ error: e.message, ...(e.extra ?? {}) }, { status: e.status })
  if (e?.code === 'P2002') return NextResponse.json({ error: dupMessage }, { status: 409 })
  return null
}
