import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PosError } from './pos-errors.js';

export type WorkforceActor = {
  organizationId: string;
  userId: string;
  storeId?: string;
  registerId?: string;
};

type Tx = Prisma.TransactionClient;
type PageInput = { page?: number; pageSize?: number };

const page = (input: PageInput) => {
  const pageNumber = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));
  return { pageNumber, pageSize, skip: (pageNumber - 1) * pageSize };
};

const requireText = (value: string, code: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new PosError(code);
  return normalized;
};

export const normalizeEmail = (value?: string | null): string | null => {
  if (!value?.trim()) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes(' ')) throw new PosError('CUSTOMER_EMAIL_INVALID');
  const at = normalized.indexOf('@');
  if (at <= 0 || at !== normalized.lastIndexOf('@')) throw new PosError('CUSTOMER_EMAIL_INVALID');
  const domain = normalized.slice(at + 1);
  if (!domain || domain.startsWith('.') || domain.endsWith('.') || !domain.includes('.')) throw new PosError('CUSTOMER_EMAIL_INVALID');
  return normalized;
};

export const normalizePhone = (value?: string | null): string | null => {
  if (!value?.trim()) return null;
  const normalized = value.trim().replaceAll(/[^\d+]/g, '');
  const startsWithPlus = normalized.startsWith('+');
  const digits = startsWithPlus ? normalized.slice(1) : normalized;
  if (!digits || digits.length < 7 || digits.length > 15 || digits.includes('+') || !/^\d+$/.test(digits)) throw new PosError('CUSTOMER_PHONE_INVALID');
  return normalized;
};

const customerConflict = (error: unknown): never => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new PosError('CUSTOMER_CONTACT_CONFLICT', 409);
  }
  throw error;
};

export async function clockIn(
  prisma: PrismaClient,
  actor: WorkforceActor,
  input: { employeeId?: string; storeId?: string; registerId?: string; clockedInAt?: Date },
) {
  const employeeId = input.employeeId ?? actor.userId;
  const storeId = input.storeId ?? actor.storeId;
  const registerId = input.registerId ?? actor.registerId;
  if (!storeId) throw new PosError('SHIFT_STORE_REQUIRED');
  try {
    return await prisma.$transaction(async (tx) => {
      const employeeStore = await tx.employeeStore.findUnique({
        where: { organizationId_employeeId_storeId: { organizationId: actor.organizationId, employeeId, storeId } },
        include: { employee: true },
      });
      if (!employeeStore) throw new PosError('EMPLOYEE_STORE_ACCESS_DENIED', 403);
      if (employeeStore.employee.status !== 'ACTIVE') throw new PosError('EMPLOYEE_INACTIVE', 409);
      if (registerId) {
        const register = await tx.register.findFirst({ where: { id: registerId, organizationId: actor.organizationId, storeId, status: 'ACTIVE' } });
        if (!register) throw new PosError('REGISTER_NOT_FOUND', 404);
      }
      const shift = await tx.employeeShift.create({ data: {
        organizationId: actor.organizationId, employeeId, storeId,
        ...(registerId ? { registerId } : {}), ...(input.clockedInAt ? { clockedInAt: input.clockedInAt } : {}),
      } });
      await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId, registerId: registerId ?? null,
        userId: actor.userId, action: 'EMPLOYEE_CLOCKED_IN', entityType: 'EmployeeShift', entityId: shift.id } });
      return shift;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new PosError('EMPLOYEE_ALREADY_CLOCKED_IN', 409);
    throw error;
  }
}

export async function clockOut(
  prisma: PrismaClient,
  actor: WorkforceActor,
  input: { employeeId?: string; clockedOutAt?: Date },
) {
  const employeeId = input.employeeId ?? actor.userId;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; clockedInAt: Date }>>`
      SELECT id, "clockedInAt" FROM "EmployeeShift"
      WHERE "organizationId" = ${actor.organizationId}::uuid AND "employeeId" = ${employeeId}::uuid AND "clockedOutAt" IS NULL
      FOR UPDATE
    `;
    const active = rows[0];
    if (!active) throw new PosError('EMPLOYEE_NOT_CLOCKED_IN', 409);
    const clockedOutAt = input.clockedOutAt ?? new Date();
    if (clockedOutAt < active.clockedInAt) throw new PosError('SHIFT_RANGE_INVALID');
    const shift = await tx.employeeShift.update({ where: { id: active.id }, data: { clockedOutAt } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: shift.storeId,
      registerId: shift.registerId, userId: actor.userId, action: 'EMPLOYEE_CLOCKED_OUT', entityType: 'EmployeeShift', entityId: shift.id } });
    return shift;
  });
}

export async function getCurrentShift(prisma: PrismaClient, actor: WorkforceActor, employeeId = actor.userId) {
  return prisma.employeeShift.findFirst({ where: { organizationId: actor.organizationId, employeeId, clockedOutAt: null },
    include: { employee: true, store: true, register: true } });
}

export async function listShifts(prisma: PrismaClient, actor: WorkforceActor, input: PageInput & {
  employeeId?: string; storeId?: string; active?: boolean; from?: Date; to?: Date;
}) {
  const { pageNumber, pageSize, skip } = page(input);
  const where: Prisma.EmployeeShiftWhereInput = { organizationId: actor.organizationId,
    ...(input.employeeId ? { employeeId: input.employeeId } : {}), ...(input.storeId ? { storeId: input.storeId } : {}),
    ...(input.active === undefined ? {} : input.active ? { clockedOutAt: null } : { clockedOutAt: { not: null } }),
    ...(input.from || input.to ? { clockedInAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.employeeShift.findMany({ where, include: { employee: true, store: true, register: true, correctedBy: true }, orderBy: { clockedInAt: 'desc' }, skip, take: pageSize }),
    prisma.employeeShift.count({ where }),
  ]);
  const now = Date.now();
  return { items: items.map((shift) => ({ ...shift, workedSeconds: Math.max(0, Math.floor((((shift.correctedClockedOutAt ?? shift.clockedOutAt)?.getTime() ?? now) - (shift.correctedClockedInAt ?? shift.clockedInAt).getTime()) / 1000)) })), total, page: pageNumber, pageSize };
}

export async function correctShift(prisma: PrismaClient, actor: WorkforceActor, shiftId: string, input: {
  clockedInAt: Date; clockedOutAt: Date; reason: string;
}) {
  const reason = requireText(input.reason, 'SHIFT_CORRECTION_REASON_REQUIRED');
  if (input.clockedOutAt < input.clockedInAt) throw new PosError('SHIFT_RANGE_INVALID');
  return prisma.$transaction(async (tx) => {
    const before = await tx.employeeShift.findFirst({ where: { id: shiftId, organizationId: actor.organizationId } });
    if (!before) throw new PosError('SHIFT_NOT_FOUND', 404);
    if (!before.clockedOutAt) throw new PosError('ACTIVE_SHIFT_NOT_CORRECTABLE', 409);
    const after = await tx.employeeShift.update({ where: { id: shiftId }, data: { correctedClockedInAt: input.clockedInAt,
      correctedClockedOutAt: input.clockedOutAt, correctionReason: reason, correctedByEmployeeId: actor.userId } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: before.storeId, registerId: before.registerId,
      userId: actor.userId, action: 'SHIFT_CORRECTED', entityType: 'EmployeeShift', entityId: shiftId,
      beforeJson: { clockedInAt: before.correctedClockedInAt ?? before.clockedInAt, clockedOutAt: before.correctedClockedOutAt ?? before.clockedOutAt },
      afterJson: { clockedInAt: input.clockedInAt, clockedOutAt: input.clockedOutAt }, metadataJson: { reason } } });
    return after;
  });
}

export async function listCustomers(prisma: PrismaClient, actor: WorkforceActor, input: PageInput & { search?: string; active?: boolean }) {
  const { pageNumber, pageSize, skip } = page(input);
  const where: Prisma.CustomerWhereInput = { organizationId: actor.organizationId, ...(input.active === undefined ? {} : { active: input.active }),
    ...(input.search ? { OR: [{ name: { contains: input.search, mode: 'insensitive' } }, { email: { contains: input.search, mode: 'insensitive' } }, { phone: { contains: input.search } }] } : {}) };
  const [items, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip, take: pageSize }),
    prisma.customer.count({ where }),
  ]);
  return { items, total, page: pageNumber, pageSize };
}

export async function createCustomer(prisma: PrismaClient, actor: WorkforceActor, input: { name: string; email?: string; phone?: string; notes?: string; storeId?: string }) {
  const name = requireText(input.name, 'CUSTOMER_NAME_REQUIRED');
  const emailNormalized = normalizeEmail(input.email);
  const phoneNormalized = normalizePhone(input.phone);
  try {
    return await prisma.$transaction(async (tx) => {
      if (input.storeId) {
        const store = await tx.store.findFirst({ where: { id: input.storeId, organizationId: actor.organizationId } });
        if (!store) throw new PosError('STORE_NOT_FOUND', 404);
      }
      const customer = await tx.customer.create({ data: { organizationId: actor.organizationId, name,
        email: input.email?.trim() || null, phone: input.phone?.trim() || null, emailNormalized, phoneNormalized,
        notes: input.notes?.trim() || null, storeId: input.storeId ?? actor.storeId ?? null } });
      await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId ?? null,
        userId: actor.userId, action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: customer.id } });
      return customer;
    });
  } catch (error) { return customerConflict(error); }
}

export async function updateCustomer(prisma: PrismaClient, actor: WorkforceActor, customerId: string, input: {
  name?: string; email?: string | null; phone?: string | null; notes?: string | null; active?: boolean;
}) {
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await tx.customer.findFirst({ where: { id: customerId, organizationId: actor.organizationId } });
      if (!before) throw new PosError('CUSTOMER_NOT_FOUND', 404);
      const customer = await tx.customer.update({ where: { id: customerId }, data: {
        ...(input.name === undefined ? {} : { name: requireText(input.name, 'CUSTOMER_NAME_REQUIRED') }),
        ...(input.email === undefined ? {} : { email: input.email?.trim() || null, emailNormalized: normalizeEmail(input.email) }),
        ...(input.phone === undefined ? {} : { phone: input.phone?.trim() || null, phoneNormalized: normalizePhone(input.phone) }),
        ...(input.notes === undefined ? {} : { notes: input.notes?.trim() || null }),
        ...(input.active === undefined ? {} : { active: input.active }),
      } });
      await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId ?? null,
        userId: actor.userId, action: 'CUSTOMER_UPDATED', entityType: 'Customer', entityId: customer.id,
        beforeJson: { name: before.name, email: before.email, phone: before.phone, active: before.active },
        afterJson: { name: customer.name, email: customer.email, phone: customer.phone, active: customer.active } } });
      return customer;
    });
  } catch (error) { return customerConflict(error); }
}

export async function getCustomerDetail(prisma: PrismaClient, actor: WorkforceActor, customerId: string) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, organizationId: actor.organizationId }, include: {
    orders: { orderBy: { createdAt: 'desc' }, include: { store: true, items: true, payments: true, refunds: true } },
    loyaltyTransactions: { orderBy: { createdAt: 'desc' } },
  } });
  if (!customer) throw new PosError('CUSTOMER_NOT_FOUND', 404);
  const pointsBalance = customer.loyaltyTransactions.filter((entry) => entry.status === 'POSTED').reduce((sum, entry) => sum + entry.points, 0);
  return { ...customer, pointsBalance };
}

export async function getLoyaltyProgram(prisma: PrismaClient, organizationId: string) {
  return prisma.loyaltyProgram.findUnique({ where: { organizationId } });
}

export async function configureLoyalty(prisma: PrismaClient, actor: WorkforceActor, input: { enabled: boolean; pointsEarned: number; spendMinor: bigint; redeemMinorPerPoint: bigint }) {
  if (!Number.isInteger(input.pointsEarned) || input.pointsEarned <= 0 || input.spendMinor <= 0n || input.redeemMinorPerPoint <= 0n) throw new PosError('LOYALTY_RULE_INVALID');
  const program = await prisma.loyaltyProgram.upsert({ where: { organizationId: actor.organizationId }, create: { organizationId: actor.organizationId, ...input }, update: input });
  await prisma.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId ?? null, userId: actor.userId,
    action: 'LOYALTY_CONFIGURED', entityType: 'LoyaltyProgram', entityId: program.id } });
  return program;
}

export async function loyaltyBalance(tx: Tx, organizationId: string, customerId: string, includePending = false): Promise<number> {
  const total = await tx.loyaltyTransaction.aggregate({ where: { organizationId, customerId,
    status: includePending ? { in: ['POSTED', 'PENDING'] } : 'POSTED' }, _sum: { points: true } });
  return total._sum.points ?? 0;
}

export async function adjustLoyalty(prisma: PrismaClient, actor: WorkforceActor, customerId: string, input: { points: number; reason: string }) {
  const reason = requireText(input.reason, 'LOYALTY_ADJUSTMENT_REASON_REQUIRED');
  if (!Number.isInteger(input.points) || input.points === 0) throw new PosError('LOYALTY_POINTS_INVALID');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
    const customer = await tx.customer.findFirst({ where: { id: customerId, organizationId: actor.organizationId } });
    if (!customer) throw new PosError('CUSTOMER_NOT_FOUND', 404);
    if (input.points < 0 && await loyaltyBalance(tx, actor.organizationId, customerId, true) + input.points < 0) throw new PosError('LOYALTY_POINTS_INSUFFICIENT', 409);
    const entry = await tx.loyaltyTransaction.create({ data: { organizationId: actor.organizationId, customerId, employeeId: actor.userId,
      type: input.points > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT', points: input.points, reason } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId ?? null, userId: actor.userId,
      action: 'LOYALTY_ADJUSTED', entityType: 'Customer', entityId: customerId, metadataJson: { points: input.points, reason } } });
    return entry;
  });
}

export const hashGiftCardCode = (code: string): string => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

export async function giftCardBalance(tx: Tx, organizationId: string, giftCardId: string, includePending = false): Promise<bigint> {
  const total = await tx.giftCardTransaction.aggregate({ where: { organizationId, giftCardId,
    status: includePending ? { in: ['POSTED', 'PENDING'] } : 'POSTED' }, _sum: { amountMinor: true } });
  return total._sum.amountMinor ?? 0n;
}

export async function issueGiftCard(prisma: PrismaClient, actor: WorkforceActor, input: { amountMinor: bigint; reason?: string }) {
  if (input.amountMinor <= 0n) throw new PosError('GIFT_CARD_AMOUNT_INVALID');
  const code = `RJ-${randomBytes(16).toString('hex').toUpperCase()}`;
  const codeHash = hashGiftCardCode(code);
  const card = await prisma.$transaction(async (tx) => {
    const created = await tx.giftCard.create({ data: { organizationId: actor.organizationId, codeHash, lastFour: code.slice(-4) } });
    await tx.giftCardTransaction.create({ data: { organizationId: actor.organizationId, giftCardId: created.id,
      employeeId: actor.userId, type: 'ISSUE', amountMinor: input.amountMinor, reason: input.reason?.trim() || 'Initial issue' } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId ?? null, userId: actor.userId,
      action: 'GIFT_CARD_ISSUED', entityType: 'GiftCard', entityId: created.id, metadataJson: { amountMinor: input.amountMinor.toString(), lastFour: created.lastFour } } });
    return created;
  });
  return { id: card.id, code, lastFour: card.lastFour, status: card.status, balanceMinor: input.amountMinor.toString() };
}

export async function findGiftCardByCode(tx: Tx, organizationId: string, code: string) {
  const card = await tx.giftCard.findFirst({ where: { organizationId, codeHash: hashGiftCardCode(requireText(code, 'GIFT_CARD_CODE_REQUIRED')) } });
  if (!card) throw new PosError('GIFT_CARD_NOT_FOUND', 404);
  return card;
}

export async function lookupGiftCard(prisma: PrismaClient, organizationId: string, code: string) {
  return prisma.$transaction(async (tx) => {
    const card = await findGiftCardByCode(tx, organizationId, code);
    const [balance, available, history] = await Promise.all([
      giftCardBalance(tx, organizationId, card.id), giftCardBalance(tx, organizationId, card.id, true),
      tx.giftCardTransaction.findMany({ where: { organizationId, giftCardId: card.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { id: card.id, lastFour: card.lastFour, status: card.status, balanceMinor: balance.toString(), availableMinor: available.toString(), history };
  });
}

export async function reloadGiftCard(prisma: PrismaClient, actor: WorkforceActor, code: string, input: { amountMinor: bigint; reason: string }) {
  if (input.amountMinor <= 0n) throw new PosError('GIFT_CARD_AMOUNT_INVALID');
  const reason = requireText(input.reason, 'GIFT_CARD_REASON_REQUIRED');
  return prisma.$transaction(async (tx) => {
    const located = await findGiftCardByCode(tx, actor.organizationId, code);
    await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${located.id}::uuid FOR UPDATE`;
    const card = await tx.giftCard.findFirst({ where: { id: located.id, organizationId: actor.organizationId } });
    if (!card) throw new PosError('GIFT_CARD_NOT_FOUND', 404);
    if (card.status !== 'ACTIVE') throw new PosError('GIFT_CARD_DISABLED', 409);
    const entry = await tx.giftCardTransaction.create({ data: { organizationId: actor.organizationId, giftCardId: card.id,
      employeeId: actor.userId, type: 'RELOAD', amountMinor: input.amountMinor, reason } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId ?? null, userId: actor.userId,
      action: 'GIFT_CARD_RELOADED', entityType: 'GiftCard', entityId: card.id, metadataJson: { amountMinor: input.amountMinor.toString(), reason } } });
    return entry;
  });
}

export async function disableGiftCard(prisma: PrismaClient, actor: WorkforceActor, cardId: string, reason: string) {
  const normalizedReason = requireText(reason, 'GIFT_CARD_REASON_REQUIRED');
  return prisma.$transaction(async (tx) => {
    const card = await tx.giftCard.findFirst({ where: { id: cardId, organizationId: actor.organizationId } });
    if (!card) throw new PosError('GIFT_CARD_NOT_FOUND', 404);
    const updated = await tx.giftCard.update({ where: { id: cardId }, data: { status: 'DISABLED' } });
    await tx.auditRecord.create({ data: { organizationId: actor.organizationId, storeId: actor.storeId ?? null, userId: actor.userId,
      action: 'GIFT_CARD_DISABLED', entityType: 'GiftCard', entityId: cardId, metadataJson: { reason: normalizedReason } } });
    return updated;
  });
}
