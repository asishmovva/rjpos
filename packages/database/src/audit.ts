import type { Prisma, PrismaClient } from '@prisma/client';

export async function recordAudit(prisma: PrismaClient, input: { organizationId: string; action: string; entityType: string; entityId: string; afterJson?: unknown }): Promise<void> {
  const data: Prisma.AuditRecordUncheckedCreateInput = { organizationId: input.organizationId, action: input.action, entityType: input.entityType, entityId: input.entityId, ...(input.afterJson === undefined ? {} : { afterJson: input.afterJson as Prisma.InputJsonValue }) };
  await prisma.auditRecord.create({ data });
}
