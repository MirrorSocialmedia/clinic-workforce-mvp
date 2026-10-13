// ★ cwm-labstmtprog-20261012：GET /api/lab-docs/statement-progress?month=YYYY-MM
//   某月 Lab 月結單逐間診所：已對／對數中／未對＋未收到（有 Lab 成本但冇月結單）—— 計法見 lib/labdoc/statement-progress.ts
//   範圍同 /api/lab-docs（labdocScope：KIOSK = 自己店；有 lab 權限 = 全集團）。純讀，唔出病人資料。
// → { month, clinics: [{ clinicId, clinicName, reconciled, inProgress, open, missingLabs: string[], todo: [...] }], unassigned }
// ★ 2026-10-12：todo 逐項（kind OPEN 未對／MISSING 未收到，labName、providerName、docId、sectionId、diff）
// ★ 2026-10-13：kind CARRY 結轉等單（上月標「計入下個月」、本月未有同 Lab＋醫生月結單可以帶入）＋頂層 carryWaiting
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'
import { labdocScope } from '@/lib/labdoc/kiosk-scope'
import { statementProgress, carryWaiting, STATEMENT_EXCLUDED } from '@/lib/labdoc/statement-progress'
import { shiftMonth, NEXT_MONTH } from '@/lib/labdoc/statement-carry'
import { isNonPrimaryMember } from '@/lib/labdoc/statement-combine'

const KIND_ORDER: Record<string, number> = { OPEN: 0, CARRY: 1, MISSING: 2 }

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, perms } = auth

  const month = req.nextUrl.searchParams.get('month') ?? ''
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return jsonNoStore({ error: 'month 要 YYYY-MM' }, { status: 400 })

  const scope = await labdocScope(session, perms)
  if (scope !== null && scope.length === 0) return jsonNoStore({ month, clinics: [], unassigned: 0 })

  const statements = await prisma.labDocument.findMany({
    where: { kind: 'STATEMENT', statementMonth: month, status: { notIn: [...STATEMENT_EXCLUDED] } },
    select: {
      id: true, labId: true, status: true, clinicId: true, uploadClinicId: true,
      sections: { orderBy: { sectionIndex: 'asc' }, select: { id: true, clinicId: true, providerId: true, status: true, resultJson: true } },
    },
  })
  const costs = await prisma.costCase.findMany({
    where: { category: 'LAB', periodMonth: month, status: { not: 'VOID' }, labId: { not: null }, ...(scope ? { clinicId: { in: scope } } : {}) },
    select: { clinicId: true, labId: true, providerId: true },
    distinct: ['clinicId', 'labId', 'providerId'],
  })
  // 「加埋一齊對」：主段要仲係有效先跳過其他段（主段作廢咗 → 其他段自己計）
  const activeIds = new Set<string>(statements.flatMap(s => s.sections.map(sec => sec.id)))
  const r = statementProgress(
    statements.map(s => ({
      ...s,
      sections: s.sections.map(sec => {
        const rj = (sec.resultJson ?? {}) as { mode?: string; diff?: unknown }
        return { id: sec.id, clinicId: sec.clinicId, providerId: sec.providerId, status: sec.status, diff: rj.mode === 'COST' && typeof rj.diff === 'number' ? rj.diff : null, skipTodo: isNonPrimaryMember(sec.id, sec.resultJson, activeIds) }
      }),
    })),
    costs.map(c => ({ clinicId: c.clinicId, labId: c.labId as string, providerId: c.providerId })),
  )
  // ★ 2026-10-13：結轉等單 — 上月有效月結單入面標咗「計入下個月」嘅行（包括結轉副本再標），本月冇同範圍分段
  const prevMonth = shiftMonth(month, -1)
  const carryRows = await prisma.labStatementLine.findMany({
    where: {
      resolution: NEXT_MONTH,
      lineType: { in: ['INVOICE', 'CREDIT', 'CHARGE'] },
      section: {
        clinicId: scope ? { in: scope } : { not: null },
        providerId: { not: null },
        document: { kind: 'STATEMENT', statementMonth: prevMonth, labId: { not: null }, status: { notIn: [...STATEMENT_EXCLUDED] } },
      },
    },
    select: { amount: true, sectionId: true, section: { select: { clinicId: true, providerId: true, documentId: true, document: { select: { labId: true } } } } },
    orderBy: [{ sectionId: 'asc' }, { lineIndex: 'asc' }],
  })
  const targetKeys = new Set<string>()
  for (const st of statements) for (const sec of st.sections) if (st.labId && sec.clinicId && sec.providerId) targetKeys.add(`${st.labId}|${sec.clinicId}|${sec.providerId}`)
  const waiting = carryWaiting(carryRows.map(l => ({
    amount: Number(l.amount),
    labId: l.section.document.labId,
    clinicId: l.section.clinicId,
    providerId: l.section.providerId,
    docId: l.section.documentId,
    sectionId: l.sectionId,
  })), targetKeys)
  for (const w of waiting) {
    let c = r.clinics.find(x => x.clinicId === w.clinicId)
    if (!c) { c = { clinicId: w.clinicId, reconciled: 0, inProgress: 0, open: 0, missingLabIds: [], todo: [] }; r.clinics.push(c) }
    c.todo.push({ kind: 'CARRY', labId: w.labId, providerId: w.providerId, docId: w.docId, sectionId: w.sectionId, amount: w.amount, count: w.count })
  }

  const clinicsOut = scope ? r.clinics.filter(c => scope.includes(c.clinicId)) : r.clinics

  const todoLabIds = clinicsOut.flatMap(c => c.todo.map(t => t.labId)).filter((x): x is string => !!x)
  const todoProvIds = [...new Set(clinicsOut.flatMap(c => c.todo.map(t => t.providerId)).filter((x): x is string => !!x))]
  const [clinics, labs, provs] = await Promise.all([
    prisma.clinic.findMany({ where: { id: { in: clinicsOut.map(c => c.clinicId) } }, select: { id: true, name: true, shortName: true } }),
    prisma.lab.findMany({ where: { id: { in: [...new Set([...clinicsOut.flatMap(c => c.missingLabIds), ...todoLabIds])] } }, select: { id: true, name: true } }),
    todoProvIds.length ? prisma.provider.findMany({ where: { id: { in: todoProvIds } }, select: { id: true, name: true } }) : Promise.resolve([] as Array<{ id: string; name: string }>),
  ])
  const clinicName = new Map(clinics.map(c => [c.id, c.name || c.shortName || c.id]))
  const labName = new Map(labs.map(l => [l.id, l.name]))
  const provName = new Map(provs.map(p => [p.id, p.name]))

  return jsonNoStore({
    month,
    clinics: clinicsOut
      .map(c => ({
        clinicId: c.clinicId,
        clinicName: clinicName.get(c.clinicId) ?? c.clinicId,
        reconciled: c.reconciled,
        inProgress: c.inProgress,
        open: c.open,
        missingLabs: c.missingLabIds.map(id => labName.get(id) ?? id).sort((a, b) => a.localeCompare(b)),
        // 未對先、未收到後；同類按 Lab 名
        todo: c.todo
          .map(t => ({
            kind: t.kind,
            labName: t.labId ? labName.get(t.labId) ?? '未識別 Lab' : '未識別 Lab',
            providerName: t.providerId ? provName.get(t.providerId) ?? null : null,
            docId: t.docId ?? null,
            sectionId: t.sectionId ?? null,
            diff: t.diff ?? null,
            amount: t.amount ?? null,
            count: t.count ?? null,
          }))
          // 未對 → 結轉等單 → 未收到；同類按 Lab 名
          .sort((a, b) => (a.kind === b.kind ? a.labName.localeCompare(b.labName) : KIND_ORDER[a.kind] - KIND_ORDER[b.kind])),
      }))
      .sort((a, b) => a.clinicName.localeCompare(b.clinicName, 'zh-HK')),
    // ★ 2026-10-13：結轉等單（列表頂一欄用；同 todo CARRY 一樣嘅數）
    fromMonth: prevMonth,
    carryWaiting: waiting
      .filter(w => !scope || scope.includes(w.clinicId))
      .map(w => ({
        clinicName: clinicName.get(w.clinicId) ?? w.clinicId,
        labName: labName.get(w.labId) ?? '未識別 Lab',
        providerName: provName.get(w.providerId) ?? null,
        amount: w.amount,
        count: w.count,
        docId: w.docId,
        sectionId: w.sectionId,
      }))
      .sort((a, b) => a.clinicName.localeCompare(b.clinicName, 'zh-HK') || a.labName.localeCompare(b.labName)),
    // 唔知邊間店嘅單（未分段又冇單頭店／上傳店）—— 只畀全集團範圍睇
    unassigned: scope ? 0 : r.unassigned,
  })
}
