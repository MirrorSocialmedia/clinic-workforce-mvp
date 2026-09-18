import { prisma } from './prisma'

/** ★ cwm-antitamper：操作者係咪改緊自己嘅數（用嚟標紅，唔係擋） */
export async function flagIfSelfEdit(args: {
  actorUserId: string; targetEmployeeId: string; what: string; detail: unknown; req: Request
}) {
  const me = await prisma.employee.findUnique({ where: { userId: args.actorUserId }, select: { id: true } })
  if (me?.id !== args.targetEmployeeId) return
  await prisma.auditLog.create({
    data: {
      actorId: args.actorUserId,
      action: 'SELF_BALANCE_EDIT',
      entity: 'Employee',
      entityId: args.targetEmployeeId,
      targetEmployeeId: args.targetEmployeeId,
      notes: `⚠️ 自己改自己：${args.what}`,
      afterJson: JSON.stringify(args.detail),
      ipAddress: args.req.headers.get('cf-connecting-ip') || args.req.headers.get('x-forwarded-for') || null,
      userAgent: args.req.headers.get('user-agent') || null,
    },
  })
}
