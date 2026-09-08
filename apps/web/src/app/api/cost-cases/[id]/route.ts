import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr } from '@/lib/hk-date'
import { resolveMaterials } from '@/lib/cost-entry/resolve-materials'

// ============================================================
// PUT /api/cost-cases/:id — Update a cost case
// Roles: OWNER, MANAGER
// ⚠️ lockedByRunId != null → 409「已出月結，請用下期調整」
// ============================================================
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { id } = await params
  // ★ cwm-payoutcost-20260908 C2：帶埋 materials（audit 前後對比要用）
  const existing = await prisma.costCase.findUnique({
    where: { id },
    include: { materials: { orderBy: { id: 'asc' } } },   // ★ P0-2：同 GET 同一次序
  })

  if (!existing) {
    return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })
  }

  // ★ 鎖定後唔准改
  if (existing.lockedByRunId != null) {
    return jsonNoStore({ error: '已出月結，請用下期調整' }, { status: 409 })
  }

  const body = await req.json()
  const {
    patientCode, patientName, orderedAt, itemType,
    labId, labOrderNo, dsaName,
    baseCost, receivedAt, appointmentAt, status,
    // ★ 2026-08-25 拍板③：全欄可改 — providerId / clinicId / category
    //   ⚠️ 呢三個直接改變【拆帳歸屬】同【成本分類】，一定要入 audit
    providerId, clinicId, category,
    // ★ 2026-08-25 拍板①：重做（REDO）
    redoAt, redoReason,
    // ★ 2026-09-02 cwm-costnote：自由備註
    note,
    // ★ C2：材料明細（只對 IMPLANT 有效；undefined = 唔改）
    materials,
  } = body

  // ★ Q2: Look up discount from LabMonthlyDiscount table (ignore body discountPct)
  const effectiveLabId = labId !== undefined ? (labId || null) : existing.labId
  // ★ 2026-08-27 拍板①：periodMonth 跟 receivedAt 唔跟 orderedAt（未到貨 = null）
  const effectiveReceivedAt = receivedAt !== undefined ? receivedAt : existing.receivedAt
  const effectivePeriodMonth = effectiveReceivedAt
    ? toHKDateStr(effectiveReceivedAt).slice(0, 7)
    : null

  // ★ 2026-08-25 守衛①：改醫生／診所要驗存在性（FK 撞 = 400 唔係 500）
  if (providerId !== undefined && providerId !== existing.providerId) {
    const ok = await prisma.provider.count({ where: { id: providerId, isActive: true } })
    if (!ok) return jsonNoStore({ error: '醫生唔存在或已停用' }, { status: 400 })
  }
  if (clinicId !== undefined && clinicId !== existing.clinicId) {
    const ok = await prisma.clinic.count({ where: { id: clinicId } })
    if (!ok) return jsonNoStore({ error: '診所唔存在' }, { status: 400 })
  }

  // ★ 2026-08-25 守衛②：category 只准三個值
  if (category !== undefined && !['LAB', 'IMPLANT', 'INVISALIGN'].includes(category)) {
    return jsonNoStore({ error: 'category 唔合法' }, { status: 400 })
  }

  // ★ 2026-09-02 cwm-costnote：備註最多 200 字（前端 maxLength 繞得過，後端兜底）
  if (note != null && String(note).length > 200) {
    return jsonNoStore({ error: '備註最多 200 字' }, { status: 400 })
  }

  // ★ 2026-08-25 守衛③：改落單日會換 periodMonth — 目標月份已 LOCKED 唔准改
  //   ⚠️ PayoutRun status 實值只有 DRAFT | LOCKED（2026-08-25 grep 確認；
  //      MD 寫嘅 EXPORTED 係 PayrollRun 嘅狀態，唔係 PayoutRun 嘅）
  if (effectivePeriodMonth !== existing.periodMonth) {
    // ★ 2026-08-27：null（由有到貨變未到貨）唔使檢查目標月（#13 唔會 409）
    if (effectivePeriodMonth) {
      const lockedRun = await prisma.payoutRun.findFirst({
        where: { periodMonth: effectivePeriodMonth, status: 'LOCKED' },
        select: { id: true },
      })
      if (lockedRun) {
        return jsonNoStore(
          { error: `${effectivePeriodMonth} 已出月結，唔可以改到嗰個月` }, { status: 409 })
      }
    }
  }

  // ★ 2026-08-25 拍板①：REDO 守衛 — 重做日期 + 原因都要有（月尾對數要查得返）
  const nextStatus = status !== undefined ? status : existing.status
  const nextRedoAt = redoAt !== undefined ? redoAt : (existing.redoAt ?? null)
  if (nextStatus === 'REDO') {
    if (!nextRedoAt) {
      return jsonNoStore({ error: '重做要填重做日期' }, { status: 400 })
    }
    const nextRedoReason = redoReason !== undefined ? redoReason : existing.redoReason
    if (!nextRedoReason || !String(nextRedoReason).trim()) {
      return jsonNoStore({ error: '重做要填原因' }, { status: 400 })
    }
  }
  let discountPctNum: number | null = null
  // ★ 2026-08-27：periodMonth null（未到貨）→ 冇月度折扣，finalCost = baseCost
  if (effectiveLabId && effectivePeriodMonth) {
    const d = await prisma.labMonthlyDiscount.findUnique({
      where: { labId_periodMonth: { labId: effectiveLabId, periodMonth: effectivePeriodMonth } },
      select: { discountPct: true },
    })
    discountPctNum = d ? Number(d.discountPct) : null
  }

  // ★ cwm-payoutcost-20260908 C2：材料明細可改（IMPLANT 專用）
  //   effectiveCategory 要用【改完之後】嗰個
  const effectiveCategory = category !== undefined ? category : existing.category
  const effectiveOrderedAt = orderedAt !== undefined ? new Date(orderedAt) : existing.orderedAt
  let materialsChanged = materials !== undefined && Array.isArray(materials)

  // ★ cwm-payoutcost-fix-20260908 P0-2：材料冇【實質】改動 → 唔 resolve。
  //   點解要咁：resolveMaterials 用 name + isActive:true 撈，材料一更名／全版本停用，
  //   舊個案就算淨係改備註都會 400「冇生效記錄」。冇改就唔洗 resolve，問題自然消失，
  //   而且順便保住快照 —— 冇碰過嘅材料行唔應該因為主檔改咗價而被重算。
  //   ⚠️ 逐位比對，靠上面兩處 orderBy: { id: 'asc' } 保證次序一致。
  if (materialsChanged && materials.length === existing.materials.length) {
    const oldIds = [...new Set(existing.materials.map(m => m.materialItemId))]
    const oldRows = oldIds.length > 0
      ? await prisma.materialItem.findMany({
          where: { id: { in: oldIds } },          // ★ 唔准加 isActive —— 就係要撈停用咗嘅
          select: { id: true, name: true },
        })
      : []
    const nameById = new Map(oldRows.map(r => [r.id, r.name]))
    const same = existing.materials.every((old, i) => {
      const m: any = materials[i]
      if (!m) return false
      if (String(m.materialName ?? '') !== (nameById.get(old.materialItemId) ?? '')) return false
      if (Number(m.qty) !== old.qty) return false
      // unitPrice 冇送 = 冇覆寫 = 跟舊快照，唔當有改
      if (m.unitPrice != null && Number(m.unitPrice) !== Number(old.unitPriceUsed)) return false
      if ((m.note?.trim() || null) !== (old.note ?? null)) return false
      return true
    })
    if (same) materialsChanged = false
  }

  let resolvedMaterials: Awaited<ReturnType<typeof resolveMaterials>> | null = null
  if (materialsChanged) {
    if (effectiveCategory !== 'IMPLANT') {
      return jsonNoStore({ error: '只有植牙個案先有材料明細' }, { status: 400 })
    }
    if (materials.length === 0) {
      return jsonNoStore({ error: '植牙個案至少要一項材料' }, { status: 400 })
    }
    try {
      resolvedMaterials = await resolveMaterials(materials, effectiveOrderedAt)
    } catch (e: any) {
      return jsonNoStore({ error: e.message }, { status: 400 })
    }
  }

  // Compute finalCost if baseCost or labId changed
  // ★ cwm-costentry-20260827 #22：body 唔傳 discountPct（Q2 後本來就忽略 body）；
  //   labId 未傳（工場未變）時重算用 existing.discountPct（已存 snapshot），
  //   防止表行缺漏把有折扣嘅單靜靜變零折扣
  let finalCost: number | null = existing.finalCost ? Number(existing.finalCost) : null

  // ★ cwm-payoutcost-20260908 C2：IMPLANT 材料有改 → baseCost/finalCost 一律由材料合計決定，
  //   完全唔行工場折扣線（implant 唔套折扣，同 implant/route.ts 一致）
  if (resolvedMaterials) {
    finalCost = resolvedMaterials.totalBaseCost
  } else if (baseCost !== undefined || labId !== undefined) {
    // ★ baseCost 明確傳 null = 清空；undefined = 冇改動先 fallback
    const bc = baseCost !== undefined
      ? (baseCost != null ? Number(baseCost) : null)
      : (existing.baseCost ? Number(existing.baseCost) : null)
    // ★ 2026-08-27：periodMonth null（未到貨）→ 冇月度折扣，finalCost = baseCost；
    //   個案仲喺月份入面先 fallback 去 existing 快照（防表行缺漏靜靜變零折扣）
    const dp = effectivePeriodMonth
      ? (labId !== undefined
        ? discountPctNum
        : (existing.discountPct ? Number(existing.discountPct) : discountPctNum))
      : null

    if (bc != null && dp != null) {
      finalCost = Number((bc * (100 - dp) / 100).toFixed(2))
    } else if (bc != null) {
      finalCost = bc
    } else if (baseCost !== undefined) {
      // ★ 2026-08-27：baseCost 明確傳 null（清空）→ finalCost 一併清 NULL。
      //   undefined = 冇改動（純改 labId），保持舊值（#6 回歸）。
      finalCost = null
    }
  }

  const data: any = {}
  if (patientCode !== undefined) data.patientCode = patientCode
  if (patientName !== undefined) data.patientName = patientName
  if (orderedAt !== undefined) data.orderedAt = new Date(orderedAt)
  // ★ 2026-08-27：periodMonth 跟 receivedAt（守衛③已驗證目標月未鎖）
  if (effectivePeriodMonth !== existing.periodMonth) {
    data.periodMonth = effectivePeriodMonth
  }
  if (itemType !== undefined) data.itemType = itemType
  if (labId !== undefined) data.labId = labId
  if (labOrderNo !== undefined) data.labOrderNo = labOrderNo
  if (dsaName !== undefined) data.dsaName = dsaName
  if (baseCost !== undefined) data.baseCost = baseCost != null ? Number(baseCost) : null
  // ★ C2：材料合計覆寫 body.baseCost（前端對植牙唔應該送 baseCost，兜底）
  if (resolvedMaterials) {
    data.baseCost = resolvedMaterials.totalBaseCost
    data.discountPct = null
  }
  // ★ Q2: discountPct now from table, not body
  // ★ cwm-costentry-20260827 #22：只喺 labId 有傳（工場有變）先同步 — 新工场跟新表折扣；
  //   PUT 唔傳 labId = discountPct 欄保持原值（唔郁）
  // ★ P2-3：植牙材料有改時上面 `data.discountPct = null` 已經寫咗 null，唔准俾呢行蓋返（坑①後蓋前；UI 觸發唔到，直接打 API 送 materials+labId 就中）
  if (!resolvedMaterials && labId !== undefined && discountPctNum !== (existing.discountPct ? Number(existing.discountPct) : null)) data.discountPct = discountPctNum
  if (finalCost !== existing.finalCost?.toNumber()) data.finalCost = finalCost != null ? finalCost : null
  if (receivedAt !== undefined) data.receivedAt = receivedAt ? new Date(receivedAt) : null
  if (appointmentAt !== undefined) data.appointmentAt = appointmentAt ? new Date(appointmentAt) : null
  if (status !== undefined) data.status = status
  if (providerId !== undefined) data.providerId = providerId
  if (clinicId !== undefined) data.clinicId = clinicId
  if (category !== undefined) data.category = category
  if (redoAt !== undefined) data.redoAt = redoAt ? new Date(redoAt) : null
  if (redoReason !== undefined) data.redoReason = redoReason || null
  // ★ 2026-09-02 cwm-costnote：備註（undefined = 唔改；null/空字串 → null）
  if (note !== undefined) data.note = note?.trim() || null

  // ★ P2-5 (cwm-payoutcost-fix-20260908 S7)：category 由 IMPLANT 轉走 → 舊材料行成孤兒
  //   （轉走時 materials 唔送 → 唔會刪）→ 轉返 IMPLANT 會由孤兒行預填。呢度一併清走。
  //   ⚠️ 呢個分支 materialsChanged 必然 = false（materials 唔送）→ 唔 trigger resolve，
  //      同 S2 短路 / P2-3 無交互（resolvedMaterials = null）。
  const isImplantToOther = category !== undefined
    && existing.category === 'IMPLANT' && category !== 'IMPLANT'
    && existing.materials.length > 0

  // ★ C2：材料要「刪晒再建」—— CostCaseMaterial 冇業務主鍵，diff 更新冇著數，
  //   而且 onDelete: Cascade 只綁 costCase，刪行要自己做 → 一齊成功一齊失敗
  // ★ P2-5：離 IMPLANT case 都入同一個 transaction（原子：唔會「category 改咗但材料行未清」）
  const updated = (resolvedMaterials || isImplantToOther)
    ? await prisma.$transaction(async tx => {
        // P2-5：離 IMPLANT 只刪唔建；材料有改：刪晒再建
        await tx.costCaseMaterial.deleteMany({ where: { costCaseId: id } })
        if (resolvedMaterials) {
          await tx.costCaseMaterial.createMany({
            data: resolvedMaterials!.materialData.map(m => ({ ...m, costCaseId: id })),
          })
        }
        return await tx.costCase.update({
          where: { id },
          data,
          include: { lab: { select: { id: true, name: true } }, materials: true },
        })
      })
    : await prisma.costCase.update({
        where: { id },
        data,
        include: {
          lab: { select: { id: true, name: true } },
        },
      })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_UPDATE',
      entity: 'CostCase',
      entityId: id,
      clinicId: existing.clinicId,
      beforeJson: JSON.stringify({
        baseCost: existing.baseCost ? Number(existing.baseCost) : null,
        finalCost: existing.finalCost ? Number(existing.finalCost) : null,
        status: existing.status,
        // ★ 2026-08-25：拆帳歸屬 / 成本分類欄入 audit（拍板③）
        providerId: existing.providerId,
        clinicId: existing.clinicId,
        category: existing.category,
        // ★ 2026-08-25：重做欄（拍板①）
        redoAt: existing.redoAt,
        redoReason: existing.redoReason,
        // ★ 2026-09-02 cwm-costnote：備註
        note: existing.note,
        // ★ C2：材料前後對比
        materials: existing.materials.map(m => ({
          materialItemId: m.materialItemId, qty: m.qty,
          unitPriceUsed: Number(m.unitPriceUsed), subtotal: Number(m.subtotal),
        })),
      }),
      afterJson: JSON.stringify({
        baseCost: updated.baseCost ? Number(updated.baseCost) : null,
        finalCost: updated.finalCost ? Number(updated.finalCost) : null,
        status: updated.status,
        providerId: updated.providerId,
        clinicId: updated.clinicId,
        category: updated.category,
        redoAt: updated.redoAt,
        redoReason: updated.redoReason,
        note: updated.note,
        // ★ C2：材料有改用新數，冇改用 existing（updated.materials 只喺 transaction 路徑先有）
        // ★ P2-5：離 IMPLANT case 入 tx → updated.materials = []（清完）；非 tx 路徑 undefined → 落回 existing
        materials: (resolvedMaterials
            ? resolvedMaterials.materialData
            : ((updated as { materials?: typeof existing.materials }).materials ?? existing.materials)
          ).map(m => ({
          materialItemId: m.materialItemId, qty: m.qty,
          unitPriceUsed: Number(m.unitPriceUsed), subtotal: Number(m.subtotal),
        })),
      }),
      notes: `更新成本記錄: ${existing.category} ${existing.patientCode}`
        + (resolvedMaterials
            ? `｜材料 ${existing.materials.length} → ${resolvedMaterials.materialData.length} 項，成本 $${existing.baseCost ?? 0} → $${resolvedMaterials.totalBaseCost}`
              + (resolvedMaterials.auditRecords.length > 0 ? ` [${resolvedMaterials.auditRecords.length} 項單價異常]` : '')
            : isImplantToOther
              ? `｜材料 ${existing.materials.length} → 0 項（category 轉出 IMPLANT，舊行一併清走）`
              : ''),
    },
  } as any)

  // ★ cwm-payoutcost-20260908 C2 §7：改咗成本，但該月已經有月結單（未鎖定）
  //   → 出警告。唔擋 —— 鎖咗嘅單上面 lockedByRunId 已經 409，未鎖嘅重新生成就得。
  const warnings: string[] = []
  if (resolvedMaterials && effectivePeriodMonth) {
    const run = await prisma.payoutRun.findFirst({
      where: {
        providerId: data.providerId ?? existing.providerId,
        clinicId: data.clinicId ?? existing.clinicId,
        periodMonth: effectivePeriodMonth,
      },
      select: { periodMonth: true, status: true },
    })
    if (run) {
      warnings.push(
        `${run.periodMonth} 已經有月結單（${run.status === 'LOCKED' ? '已鎖定' : '草稿'}）—— `
        + `成本改咗，要退回並重新生成月結單先對到數`,
      )
    }
  }

  const result = {
    ...updated,
    baseCost: updated.baseCost ? Number(updated.baseCost) : null,
    discountPct: updated.discountPct ? Number(updated.discountPct) : null,
    finalCost: updated.finalCost ? Number(updated.finalCost) : null,
  }

  return jsonNoStore({ case: result, warnings })
}

// ============================================================
// DELETE /api/cost-cases/:id — Soft void a cost case
// Roles: OWNER, MANAGER
// ★ soft: status='VOID', 唔會消失
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const { id } = await params
  const existing = await prisma.costCase.findUnique({ where: { id } })

  if (!existing) {
    return jsonNoStore({ error: '搵唔到記錄' }, { status: 404 })
  }

  // ★ 鎖定後唔准改
  if (existing.lockedByRunId != null) {
    return jsonNoStore({ error: '已出月結，請用下期調整' }, { status: 409 })
  }

  if (existing.status === 'VOID') {
    return jsonNoStore({ error: '已經係 VOID 狀態' }, { status: 409 })
  }

  const updated = await prisma.costCase.update({
    where: { id },
    data: { status: 'VOID' },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_VOID',
      entity: 'CostCase',
      entityId: id,
      clinicId: existing.clinicId,
      beforeJson: JSON.stringify({
        status: existing.status,
        baseCost: existing.baseCost ? Number(existing.baseCost) : null,
        finalCost: existing.finalCost ? Number(existing.finalCost) : null,
      }),
      afterJson: JSON.stringify({ status: 'VOID' }),
      notes: `作廢成本記錄: ${existing.category} ${existing.patientCode} (${existing.periodMonth})`,
    },
  } as any)

  return jsonNoStore({ case: updated })
}
