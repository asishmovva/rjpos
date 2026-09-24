import { Prisma, type PrismaClient } from '@prisma/client';
import { PosError } from './pos-errors.js';

export type AdminActor = {
  organizationId: string;
  userId: string;
  storeId?: string;
};

export type PageInput = { page?: number | undefined; pageSize?: number | undefined };

const clean = (value: string | undefined): string => value?.trim() ?? '';
const pageArgs = (input: PageInput) => {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize ?? 25)));
  return { page, pageSize, skip: (page - 1) * pageSize };
};

function required(value: string | undefined, code: string): string {
  const result = clean(value);
  if (!result) throw new PosError(code);
  return result;
}

function sku(value: string): string {
  const result = required(value, 'SKU_REQUIRED').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(result)) throw new PosError('SKU_INVALID');
  return result;
}

function barcode(value: string | undefined): string | undefined {
  const result = clean(value);
  if (!result) return undefined;
  if (!/^[A-Za-z0-9._-]{4,64}$/.test(result)) throw new PosError('UPC_INVALID');
  return result;
}

function nonnegativeMoney(value: string | undefined, code: string): bigint | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new PosError(code);
  return BigInt(value);
}

function timezone(value: string | undefined): string {
  const result = required(value, 'STORE_TIMEZONE_REQUIRED');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: result }).format(new Date());
  } catch {
    throw new PosError('STORE_TIMEZONE_INVALID');
  }
  return result;
}

function conflict(error: unknown, fallback: string): never {
  if (error instanceof PosError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      const target = String(error.meta?.target ?? '').toLowerCase();
      if (target.includes('barcode')) throw new PosError('UPC_ALREADY_ASSIGNED', 409);
      if (target.includes('sku')) throw new PosError('SKU_ALREADY_ASSIGNED', 409);
      if (target.includes('name')) throw new PosError('NAME_ALREADY_ASSIGNED', 409);
      if (target.includes('code')) throw new PosError('REGISTER_CODE_ALREADY_ASSIGNED', 409);
    }
    if (error.code === 'P2004' || error.code === 'P2010') {
      const message = `${error.message} ${String(error.meta?.message ?? '')}`;
      if (/price_effective_period|exclusion constraint/i.test(message)) {
        throw new PosError('PRICE_PERIOD_OVERLAP', 409);
      }
    }
  }
  throw new PosError(fallback, 409);
}

async function audit(tx: Prisma.TransactionClient, actor: AdminActor, data: {
  action: string;
  entityType: string;
  entityId: string;
  storeId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
}) {
  return tx.auditRecord.create({ data: {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: data.action,
    entityType: data.entityType,
    ...((data.storeId ?? actor.storeId) ? { storeId: data.storeId ?? actor.storeId } : {}),
    entityId: data.entityId,
    ...(data.before === undefined ? {} : { beforeJson: data.before }),
    ...(data.after === undefined ? {} : { afterJson: data.after }),
    ...(data.metadata === undefined ? {} : { metadataJson: data.metadata }),
  } });
}

export async function listCategories(prisma: PrismaClient, actor: AdminActor, input: PageInput & { search?: string | undefined; active?: boolean | undefined }) {
  const { page, pageSize, skip } = pageArgs(input);
  const where: Prisma.CategoryWhereInput = {
    organizationId: actor.organizationId,
    ...(input.active === undefined ? {} : { active: input.active }),
    ...(clean(input.search) ? { name: { contains: clean(input.search), mode: 'insensitive' } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.category.findMany({ where, include: { _count: { select: { products: true } } }, orderBy: { name: 'asc' }, skip, take: pageSize }),
    prisma.category.count({ where }),
  ]);
  return { items, page, pageSize, total };
}

export async function createCategory(prisma: PrismaClient, actor: AdminActor, input: { name: string }) {
  const name = required(input.name, 'CATEGORY_NAME_REQUIRED');
  try {
    return await prisma.$transaction(async (tx) => {
      const category = await tx.category.create({ data: { organizationId: actor.organizationId, name } });
      await audit(tx, actor, { action: 'CATEGORY_CREATED', entityType: 'Category', entityId: category.id, after: { name, active: true } });
      return category;
    });
  } catch (error) { return conflict(error, 'CATEGORY_CREATE_CONFLICT'); }
}

export async function updateCategory(prisma: PrismaClient, actor: AdminActor, categoryId: string, input: { name?: string; active?: boolean }) {
  const current = await prisma.category.findFirst({ where: { id: categoryId, organizationId: actor.organizationId } });
  if (!current) throw new PosError('CATEGORY_NOT_FOUND', 404);
  const data = {
    ...(input.name === undefined ? {} : { name: required(input.name, 'CATEGORY_NAME_REQUIRED') }),
    ...(input.active === undefined ? {} : { active: input.active }),
  };
  try {
    return await prisma.$transaction(async (tx) => {
      const category = await tx.category.update({ where: { id: categoryId }, data });
      await audit(tx, actor, { action: input.active === false ? 'CATEGORY_DEACTIVATED' : 'CATEGORY_UPDATED', entityType: 'Category', entityId: category.id,
        before: { name: current.name, active: current.active }, after: { name: category.name, active: category.active } });
      return category;
    });
  } catch (error) { return conflict(error, 'CATEGORY_UPDATE_CONFLICT'); }
}

export async function listProducts(prisma: PrismaClient, actor: AdminActor, input: PageInput & {
  search?: string | undefined; categoryId?: string | undefined; active?: boolean | undefined; sort?: 'name' | 'created' | undefined; direction?: 'asc' | 'desc' | undefined;
}) {
  const { page, pageSize, skip } = pageArgs(input);
  const query = clean(input.search);
  const where: Prisma.ProductWhereInput = {
    organizationId: actor.organizationId,
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(input.active === undefined ? {} : { active: input.active }),
    ...(query ? { OR: [
      { name: { contains: query, mode: 'insensitive' } },
      { brand: { contains: query, mode: 'insensitive' } },
      { variants: { some: { OR: [
        { sku: { contains: query, mode: 'insensitive' } },
        { barcodes: { some: { barcodeValue: { contains: query, mode: 'insensitive' } } } },
      ] } } },
    ] } : {}),
  };
  const orderBy: Prisma.ProductOrderByWithRelationInput = input.sort === 'created'
    ? { id: input.direction ?? 'desc' }
    : { name: input.direction ?? 'asc' };
  const [items, total] = await Promise.all([
    prisma.product.findMany({ where, include: { category: true, variants: { include: { barcodes: true, prices: { orderBy: { effectiveFrom: 'desc' }, take: 5 } } } }, orderBy, skip, take: pageSize }),
    prisma.product.count({ where }),
  ]);
  return { items, page, pageSize, total };
}

export async function getProduct(prisma: PrismaClient, actor: AdminActor, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, organizationId: actor.organizationId },
    include: { category: true, variants: { include: { barcodes: true, prices: { include: { store: { select: { id: true, name: true } } }, orderBy: { effectiveFrom: 'desc' } }, inventoryLevels: { include: { store: { select: { id: true, name: true } } } } } } } });
  if (!product) throw new PosError('PRODUCT_NOT_FOUND', 404);
  return product;
}

export async function createProduct(prisma: PrismaClient, actor: AdminActor, input: {
  categoryId: string; name: string; description?: string; brand?: string; taxCategory?: string; ageRestricted?: boolean; inventoryTracked?: boolean;
}) {
  const category = await prisma.category.findFirst({ where: { id: input.categoryId, organizationId: actor.organizationId, active: true } });
  if (!category) throw new PosError('CATEGORY_NOT_FOUND', 404);
  const name = required(input.name, 'PRODUCT_NAME_REQUIRED');
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({ data: { organizationId: actor.organizationId, categoryId: category.id, name,
      description: clean(input.description) || null, brand: clean(input.brand) || null,
      taxCategory: clean(input.taxCategory) || 'STANDARD', ageRestricted: input.ageRestricted ?? false,
      inventoryTracked: input.inventoryTracked ?? true } });
    await audit(tx, actor, { action: 'PRODUCT_CREATED', entityType: 'Product', entityId: product.id,
      after: { name: product.name, categoryId: product.categoryId, active: product.active } });
    return product;
  });
}

export async function updateProduct(prisma: PrismaClient, actor: AdminActor, productId: string, input: {
  categoryId?: string; name?: string; description?: string | null; brand?: string | null; taxCategory?: string;
  ageRestricted?: boolean; inventoryTracked?: boolean; active?: boolean;
}) {
  const current = await prisma.product.findFirst({ where: { id: productId, organizationId: actor.organizationId } });
  if (!current) throw new PosError('PRODUCT_NOT_FOUND', 404);
  if (input.categoryId) {
    const category = await prisma.category.findFirst({ where: { id: input.categoryId, organizationId: actor.organizationId, active: true } });
    if (!category) throw new PosError('CATEGORY_NOT_FOUND', 404);
  }
  const data = {
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(input.name === undefined ? {} : { name: required(input.name, 'PRODUCT_NAME_REQUIRED') }),
    ...(input.description === undefined ? {} : { description: clean(input.description ?? '') || null }),
    ...(input.brand === undefined ? {} : { brand: clean(input.brand ?? '') || null }),
    ...(input.taxCategory === undefined ? {} : { taxCategory: required(input.taxCategory, 'TAX_CATEGORY_REQUIRED') }),
    ...(input.ageRestricted === undefined ? {} : { ageRestricted: input.ageRestricted }),
    ...(input.inventoryTracked === undefined ? {} : { inventoryTracked: input.inventoryTracked }),
    ...(input.active === undefined ? {} : { active: input.active }),
  };
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.update({ where: { id: current.id }, data });
    await audit(tx, actor, { action: input.active === false ? 'PRODUCT_DEACTIVATED' : 'PRODUCT_UPDATED', entityType: 'Product', entityId: product.id,
      before: { name: current.name, categoryId: current.categoryId, active: current.active },
      after: { name: product.name, categoryId: product.categoryId, active: product.active } });
    return product;
  });
}

export async function createVariant(prisma: PrismaClient, actor: AdminActor, productId: string, input: {
  name: string; sku: string; barcode?: string; size?: string | number; unit?: 'EACH' | 'ML' | 'LITER'; costMinor?: string; lowStockThreshold?: number;
}) {
  const product = await prisma.product.findFirst({ where: { id: productId, organizationId: actor.organizationId } });
  if (!product) throw new PosError('PRODUCT_NOT_FOUND', 404);
  const normalizedSku = sku(input.sku);
  const normalizedBarcode = barcode(input.barcode);
  const costMinor = nonnegativeMoney(input.costMinor, 'COST_INVALID');
  const threshold = input.lowStockThreshold ?? 0;
  if (!Number.isInteger(threshold) || threshold < 0) throw new PosError('LOW_STOCK_THRESHOLD_INVALID');
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.productVariant.create({ data: { organizationId: actor.organizationId, productId,
        name: required(input.name, 'VARIANT_NAME_REQUIRED'), sku: normalizedSku,
        ...(input.size === undefined || input.size === '' ? {} : { size: new Prisma.Decimal(input.size) }),
        unit: input.unit ?? 'EACH', ...(costMinor === undefined ? {} : { costMinor }), lowStockThreshold: threshold } });
      if (normalizedBarcode) await tx.barcode.create({ data: { organizationId: actor.organizationId, variantId: created.id, barcodeValue: normalizedBarcode } });
      const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: created.id }, include: { barcodes: true } });
      await audit(tx, actor, { action: 'VARIANT_CREATED', entityType: 'ProductVariant', entityId: variant.id,
        after: { productId, sku: variant.sku, barcode: normalizedBarcode ?? null } });
      return variant;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { return conflict(error, 'VARIANT_CREATE_CONFLICT'); }
}

export async function updateVariant(prisma: PrismaClient, actor: AdminActor, variantId: string, input: {
  name?: string; sku?: string; barcode?: string | null; size?: string | number | null; unit?: 'EACH' | 'ML' | 'LITER';
  costMinor?: string | null; lowStockThreshold?: number; active?: boolean;
}) {
  const current = await prisma.productVariant.findFirst({ where: { id: variantId, organizationId: actor.organizationId }, include: { barcodes: true } });
  if (!current) throw new PosError('VARIANT_NOT_FOUND', 404);
  const threshold = input.lowStockThreshold;
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0)) throw new PosError('LOW_STOCK_THRESHOLD_INVALID');
  const normalizedBarcode = input.barcode === undefined ? undefined : barcode(input.barcode ?? '');
  try {
    return await prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.update({ where: { id: variantId }, data: {
        ...(input.name === undefined ? {} : { name: required(input.name, 'VARIANT_NAME_REQUIRED') }),
        ...(input.sku === undefined ? {} : { sku: sku(input.sku) }),
        ...(input.size === undefined ? {} : { size: input.size === null || input.size === '' ? null : new Prisma.Decimal(input.size) }),
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        ...(input.costMinor === undefined ? {} : { costMinor: input.costMinor === null ? null : nonnegativeMoney(input.costMinor, 'COST_INVALID')! }),
        ...(threshold === undefined ? {} : { lowStockThreshold: threshold }),
        ...(input.active === undefined ? {} : { active: input.active }),
      } });
      if (input.barcode !== undefined) {
        await tx.barcode.deleteMany({ where: { organizationId: actor.organizationId, variantId } });
        if (normalizedBarcode) await tx.barcode.create({ data: { organizationId: actor.organizationId, variantId, barcodeValue: normalizedBarcode } });
      }
      await audit(tx, actor, { action: input.active === false ? 'VARIANT_DEACTIVATED' : 'VARIANT_UPDATED', entityType: 'ProductVariant', entityId: variant.id,
        before: { sku: current.sku, barcode: current.barcodes[0]?.barcodeValue ?? null, active: current.active },
        after: { sku: variant.sku, barcode: normalizedBarcode ?? current.barcodes[0]?.barcodeValue ?? null, active: variant.active } });
      return tx.productVariant.findUnique({ where: { id: variant.id }, include: { barcodes: true } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { return conflict(error, 'VARIANT_UPDATE_CONFLICT'); }
}

export async function schedulePrice(prisma: PrismaClient, actor: AdminActor, input: {
  variantId: string; storeId?: string | null | undefined; amountMinor: string; currency?: string | undefined; effectiveFrom: Date; effectiveTo?: Date | null | undefined;
}) {
  const amountMinor = nonnegativeMoney(input.amountMinor, 'PRICE_INVALID');
  if (amountMinor === undefined) throw new PosError('PRICE_REQUIRED');
  if (Number.isNaN(input.effectiveFrom.getTime())) throw new PosError('PRICE_EFFECTIVE_FROM_INVALID');
  if (input.effectiveTo && (Number.isNaN(input.effectiveTo.getTime()) || input.effectiveTo <= input.effectiveFrom)) throw new PosError('PRICE_EFFECTIVE_WINDOW_INVALID');
  const [variant, store] = await Promise.all([
    prisma.productVariant.findFirst({ where: { id: input.variantId, organizationId: actor.organizationId } }),
    input.storeId ? prisma.store.findFirst({ where: { id: input.storeId, organizationId: actor.organizationId } }) : Promise.resolve(true),
  ]);
  if (!variant) throw new PosError('VARIANT_NOT_FOUND', 404);
  if (!store) throw new PosError('STORE_NOT_FOUND', 404);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM "Price"
        WHERE "organizationId" = ${actor.organizationId}::uuid
          AND "variantId" = ${input.variantId}::uuid
          AND "storeId" IS NOT DISTINCT FROM ${input.storeId ?? null}::uuid
        FOR UPDATE
      `);
      const overlaps = await tx.price.findMany({ where: {
        organizationId: actor.organizationId,
        variantId: input.variantId,
        storeId: input.storeId || null,
        ...(input.effectiveTo ? { effectiveFrom: { lt: input.effectiveTo } } : {}),
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
      } });
      if (overlaps.length === 1 && overlaps[0]!.effectiveFrom < input.effectiveFrom) {
        await tx.price.update({ where: { id: overlaps[0]!.id }, data: { effectiveTo: input.effectiveFrom } });
      } else if (overlaps.length > 0) {
        throw new PosError('PRICE_PERIOD_OVERLAP', 409);
      }
      const price = await tx.price.create({ data: { organizationId: actor.organizationId, variantId: input.variantId,
        storeId: input.storeId || null, amountMinor, currency: (input.currency ?? 'USD').toUpperCase(),
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null } });
      await audit(tx, actor, { action: 'PRODUCT_PRICE_SCHEDULED', entityType: 'Price', entityId: price.id, ...(input.storeId ? { storeId: input.storeId } : {}),
        after: { variantId: input.variantId, amountMinor: amountMinor.toString(), effectiveFrom: input.effectiveFrom.toISOString(), effectiveTo: input.effectiveTo?.toISOString() ?? null } });
      return price;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { return conflict(error, 'PRICE_CREATE_CONFLICT'); }
}

export async function listPriceHistory(prisma: PrismaClient, actor: AdminActor, variantId: string, storeId?: string) {
  const variant = await prisma.productVariant.findFirst({ where: { id: variantId, organizationId: actor.organizationId } });
  if (!variant) throw new PosError('VARIANT_NOT_FOUND', 404);
  return prisma.price.findMany({ where: { organizationId: actor.organizationId, variantId, ...(storeId ? { storeId } : {}) },
    include: { store: { select: { id: true, name: true } } }, orderBy: { effectiveFrom: 'desc' } });
}

export async function listInventoryAdmin(prisma: PrismaClient, actor: AdminActor, input: PageInput & { storeId?: string | undefined; search?: string | undefined; lowStock?: boolean | undefined }) {
  const { page, pageSize, skip } = pageArgs(input);
  const query = clean(input.search);
  const where: Prisma.InventoryLevelWhereInput = { organizationId: actor.organizationId,
    ...(input.storeId ? { storeId: input.storeId } : {}),
    ...(query ? { variant: { OR: [
      { sku: { contains: query, mode: 'insensitive' } },
      { product: { name: { contains: query, mode: 'insensitive' } } },
      { barcodes: { some: { barcodeValue: { contains: query, mode: 'insensitive' } } } },
    ] } } : {}) };
  const rows = await prisma.inventoryLevel.findMany({ where, include: { store: { select: { id: true, name: true } },
    variant: { include: { product: true, barcodes: true } } }, orderBy: [{ store: { name: 'asc' } }, { variant: { sku: 'asc' } }] });
  const filtered = input.lowStock ? rows.filter((row) => row.onHand - row.reserved <= row.variant.lowStockThreshold) : rows;
  return { items: filtered.slice(skip, skip + pageSize).map((row) => ({ ...row, available: row.onHand - row.reserved,
    inventoryStatus: row.onHand - row.reserved <= row.variant.lowStockThreshold ? 'LOW_STOCK' : 'IN_STOCK' })), page, pageSize, total: filtered.length };
}

export async function listInventoryMovements(prisma: PrismaClient, actor: AdminActor, input: PageInput & {
  storeId?: string | undefined; variantId?: string | undefined; type?: Prisma.EnumInventoryMovementTypeFilter['equals']; employeeId?: string | undefined; from?: Date | undefined; to?: Date | undefined;
}) {
  const { page, pageSize, skip } = pageArgs(input);
  const where: Prisma.InventoryMovementWhereInput = { organizationId: actor.organizationId,
    ...(input.storeId ? { storeId: input.storeId } : {}), ...(input.variantId ? { variantId: input.variantId } : {}),
    ...(input.type ? { type: input.type } : {}), ...(input.employeeId ? { employeeId: input.employeeId } : {}),
    ...(input.from || input.to ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}) };
  const [items, total] = await Promise.all([
    prisma.inventoryMovement.findMany({ where, include: { store: { select: { id: true, name: true } }, employee: { select: { id: true, firstName: true, lastName: true } },
      variant: { include: { product: { select: { id: true, name: true } }, barcodes: true } } }, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    prisma.inventoryMovement.count({ where }),
  ]);
  return { items, page, pageSize, total };
}

export async function listEmployees(prisma: PrismaClient, actor: AdminActor, input: PageInput & { search?: string | undefined; status?: 'ACTIVE' | 'INACTIVE' | undefined }) {
  const { page, pageSize, skip } = pageArgs(input); const query = clean(input.search);
  const where: Prisma.EmployeeWhereInput = { organizationId: actor.organizationId,
    ...(input.status ? { status: input.status } : {}), ...(query ? { OR: [{ firstName: { contains: query, mode: 'insensitive' } }, { lastName: { contains: query, mode: 'insensitive' } }] } : {}) };
  const [items, total] = await Promise.all([
    prisma.employee.findMany({ where, include: { roles: { include: { role: true } }, stores: { include: { store: true } } }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], skip, take: pageSize }),
    prisma.employee.count({ where }),
  ]); return { items, page, pageSize, total };
}

async function validateAssignments(prisma: PrismaClient | Prisma.TransactionClient, actor: AdminActor, roleNames: string[], storeIds: string[]) {
  const allowedRoles = new Set(['OWNER', 'MANAGER', 'CASHIER']);
  if (roleNames.length === 0 || roleNames.some((role) => !allowedRoles.has(role))) throw new PosError('EMPLOYEE_ROLE_INVALID');
  if (storeIds.length === 0) throw new PosError('EMPLOYEE_STORE_REQUIRED');
  const [roles, storeCount] = await Promise.all([
    prisma.role.findMany({ where: { organizationId: actor.organizationId, name: { in: roleNames } } }),
    prisma.store.count({ where: { organizationId: actor.organizationId, id: { in: storeIds }, status: 'ACTIVE' } }),
  ]);
  if (roles.length !== new Set(roleNames).size) throw new PosError('EMPLOYEE_ROLE_INVALID');
  if (storeCount !== new Set(storeIds).size) throw new PosError('EMPLOYEE_STORE_INVALID');
  return roles;
}

export async function createEmployee(prisma: PrismaClient, actor: AdminActor, input: { firstName: string; lastName: string; roleNames: string[]; storeIds: string[] }) {
  const roles = await validateAssignments(prisma, actor, input.roleNames, input.storeIds);
  return prisma.$transaction(async (tx) => {
    const created = await tx.employee.create({ data: { organizationId: actor.organizationId, firstName: required(input.firstName, 'EMPLOYEE_FIRST_NAME_REQUIRED'),
      lastName: required(input.lastName, 'EMPLOYEE_LAST_NAME_REQUIRED') } });
    await tx.employeeRole.createMany({ data: roles.map((role) => ({ organizationId: actor.organizationId, employeeId: created.id, roleId: role.id })) });
    await tx.employeeStore.createMany({ data: [...new Set(input.storeIds)].map((storeId) => ({ organizationId: actor.organizationId, employeeId: created.id, storeId })) });
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: created.id }, include: { roles: { include: { role: true } }, stores: { include: { store: true } } } });
    await audit(tx, actor, { action: 'EMPLOYEE_CREATED', entityType: 'Employee', entityId: employee.id,
      after: { firstName: employee.firstName, lastName: employee.lastName, roles: input.roleNames, storeIds: input.storeIds } });
    return employee;
  });
}

export async function updateEmployee(prisma: PrismaClient, actor: AdminActor, employeeId: string, input: {
  firstName?: string; lastName?: string; status?: 'ACTIVE' | 'INACTIVE'; roleNames?: string[]; storeIds?: string[];
}) {
  const current = await prisma.employee.findFirst({ where: { id: employeeId, organizationId: actor.organizationId }, include: { roles: { include: { role: true } }, stores: true } });
  if (!current) throw new PosError('EMPLOYEE_NOT_FOUND', 404);
  if (input.status === 'INACTIVE' && employeeId === actor.userId) throw new PosError('CANNOT_DEACTIVATE_SELF', 409);
  const roleNames = input.roleNames ?? current.roles.map(({ role }) => role.name);
  const storeIds = input.storeIds ?? current.stores.map(({ storeId }) => storeId);
  const roles = await validateAssignments(prisma, actor, roleNames, storeIds);
  return prisma.$transaction(async (tx) => {
    await tx.employeeRole.deleteMany({ where: { organizationId: actor.organizationId, employeeId } });
    await tx.employeeStore.deleteMany({ where: { organizationId: actor.organizationId, employeeId } });
    await tx.employee.update({ where: { id: employeeId }, data: {
      ...(input.firstName === undefined ? {} : { firstName: required(input.firstName, 'EMPLOYEE_FIRST_NAME_REQUIRED') }),
      ...(input.lastName === undefined ? {} : { lastName: required(input.lastName, 'EMPLOYEE_LAST_NAME_REQUIRED') }),
      ...(input.status === undefined ? {} : { status: input.status }),
    } });
    await tx.employeeRole.createMany({ data: roles.map((role) => ({ organizationId: actor.organizationId, employeeId, roleId: role.id })) });
    await tx.employeeStore.createMany({ data: [...new Set(storeIds)].map((storeId) => ({ organizationId: actor.organizationId, employeeId, storeId })) });
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, include: { roles: { include: { role: true } }, stores: { include: { store: true } } } });
    await audit(tx, actor, { action: input.status === 'INACTIVE' ? 'EMPLOYEE_DEACTIVATED' : 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: employee.id,
      before: { status: current.status, roles: current.roles.map(({ role }) => role.name), storeIds: current.stores.map(({ storeId }) => storeId) },
      after: { status: employee.status, roles: roleNames, storeIds } });
    return employee;
  });
}

export async function listStores(prisma: PrismaClient, actor: AdminActor) {
  return prisma.store.findMany({ where: { organizationId: actor.organizationId }, include: { _count: { select: { registers: true, employees: true } } }, orderBy: { name: 'asc' } });
}

export async function createStore(prisma: PrismaClient, actor: AdminActor, input: { name: string; address?: unknown; timezone?: string; taxRateBasisPoints?: number; receiptFooter?: string; ageRestrictionLabel?: string }) {
  const rate = input.taxRateBasisPoints ?? 0;
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) throw new PosError('TAX_RATE_INVALID');
  return prisma.$transaction(async (tx) => {
    const store = await tx.store.create({ data: { organizationId: actor.organizationId, name: required(input.name, 'STORE_NAME_REQUIRED'),
      ...(input.address === undefined ? {} : { addressJson: input.address as Prisma.InputJsonValue }), timezone: timezone(input.timezone ?? 'America/New_York'), taxRateBasisPoints: rate,
      receiptFooter: clean(input.receiptFooter) || null, ageRestrictionLabel: clean(input.ageRestrictionLabel) || '21+' } });
    await audit(tx, actor, { action: 'STORE_CREATED', entityType: 'Store', entityId: store.id, storeId: store.id, after: { name: store.name, status: store.status } });
    return store;
  });
}

export async function updateStore(prisma: PrismaClient, actor: AdminActor, storeId: string, input: {
  name?: string; address?: unknown; timezone?: string; taxRateBasisPoints?: number; receiptFooter?: string | null; ageRestrictionLabel?: string; status?: 'ACTIVE' | 'INACTIVE';
}) {
  const current = await prisma.store.findFirst({ where: { id: storeId, organizationId: actor.organizationId } });
  if (!current) throw new PosError('STORE_NOT_FOUND', 404);
  if (input.taxRateBasisPoints !== undefined && (!Number.isInteger(input.taxRateBasisPoints) || input.taxRateBasisPoints < 0 || input.taxRateBasisPoints > 10_000)) throw new PosError('TAX_RATE_INVALID');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Store" WHERE id = ${storeId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
    if (input.status === 'INACTIVE') {
      const activeSessions = await tx.registerSession.count({ where: { organizationId: actor.organizationId, storeId, status: { in: ['OPEN', 'CLOSING'] } } });
      if (activeSessions) throw new PosError('STORE_HAS_ACTIVE_SESSIONS', 409);
    }
    const store = await tx.store.update({ where: { id: storeId }, data: {
      ...(input.name === undefined ? {} : { name: required(input.name, 'STORE_NAME_REQUIRED') }),
      ...(input.address === undefined ? {} : { addressJson: input.address as Prisma.InputJsonValue }),
      ...(input.timezone === undefined ? {} : { timezone: timezone(input.timezone) }),
      ...(input.taxRateBasisPoints === undefined ? {} : { taxRateBasisPoints: input.taxRateBasisPoints }),
      ...(input.receiptFooter === undefined ? {} : { receiptFooter: clean(input.receiptFooter ?? '') || null }),
      ...(input.ageRestrictionLabel === undefined ? {} : { ageRestrictionLabel: required(input.ageRestrictionLabel, 'AGE_LABEL_REQUIRED') }),
      ...(input.status === undefined ? {} : { status: input.status }),
    } });
    await audit(tx, actor, { action: input.status === 'INACTIVE' ? 'STORE_DEACTIVATED' : 'STORE_UPDATED', entityType: 'Store', entityId: store.id, storeId,
      before: { name: current.name, status: current.status, taxRateBasisPoints: current.taxRateBasisPoints },
      after: { name: store.name, status: store.status, taxRateBasisPoints: store.taxRateBasisPoints } });
    return store;
  });
}

export async function listRegisters(prisma: PrismaClient, actor: AdminActor, storeId?: string) {
  return prisma.register.findMany({ where: { organizationId: actor.organizationId, ...(storeId ? { storeId } : {}) }, include: { store: true,
    sessions: { where: { status: { in: ['OPEN', 'CLOSING'] } }, select: { id: true, status: true, openedAt: true } } }, orderBy: [{ store: { name: 'asc' } }, { name: 'asc' }] });
}

export async function createRegister(prisma: PrismaClient, actor: AdminActor, input: { storeId: string; name: string; code: string; deviceIdentifier?: string }) {
  const store = await prisma.store.findFirst({ where: { id: input.storeId, organizationId: actor.organizationId, status: 'ACTIVE' } });
  if (!store) throw new PosError('STORE_NOT_FOUND', 404);
  try {
    return await prisma.$transaction(async (tx) => {
      const register = await tx.register.create({ data: { organizationId: actor.organizationId, storeId: input.storeId,
        name: required(input.name, 'REGISTER_NAME_REQUIRED'), code: required(input.code, 'REGISTER_CODE_REQUIRED').toUpperCase(), deviceIdentifier: clean(input.deviceIdentifier) || null } });
      await audit(tx, actor, { action: 'REGISTER_CREATED', entityType: 'Register', entityId: register.id, storeId: register.storeId, after: { name: register.name, code: register.code } });
      return register;
    });
  } catch (error) { return conflict(error, 'REGISTER_CREATE_CONFLICT'); }
}

export async function updateRegister(prisma: PrismaClient, actor: AdminActor, registerId: string, input: {
  storeId?: string; name?: string; code?: string; deviceIdentifier?: string | null; status?: 'ACTIVE' | 'INACTIVE';
}) {
  const current = await prisma.register.findFirst({ where: { id: registerId, organizationId: actor.organizationId } });
  if (!current) throw new PosError('REGISTER_NOT_FOUND', 404);
  if (input.storeId) {
    const store = await prisma.store.findFirst({ where: { id: input.storeId, organizationId: actor.organizationId, status: 'ACTIVE' } });
    if (!store) throw new PosError('STORE_NOT_FOUND', 404);
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Store" WHERE id = ${current.storeId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Register" WHERE id = ${registerId}::uuid AND "organizationId" = ${actor.organizationId}::uuid FOR UPDATE`;
      if (input.status === 'INACTIVE' || (input.storeId && input.storeId !== current.storeId)) {
        const activeSession = await tx.registerSession.findFirst({ where: { organizationId: actor.organizationId, registerId, status: { in: ['OPEN', 'CLOSING'] } } });
        if (activeSession) throw new PosError('REGISTER_HAS_ACTIVE_SESSION', 409);
      }
      const register = await tx.register.update({ where: { id: registerId }, data: {
        ...(input.storeId === undefined ? {} : { storeId: input.storeId }), ...(input.name === undefined ? {} : { name: required(input.name, 'REGISTER_NAME_REQUIRED') }),
        ...(input.code === undefined ? {} : { code: required(input.code, 'REGISTER_CODE_REQUIRED').toUpperCase() }),
        ...(input.deviceIdentifier === undefined ? {} : { deviceIdentifier: clean(input.deviceIdentifier ?? '') || null }), ...(input.status === undefined ? {} : { status: input.status }),
      } });
      await audit(tx, actor, { action: input.status === 'INACTIVE' ? 'REGISTER_DEACTIVATED' : 'REGISTER_UPDATED', entityType: 'Register', entityId: register.id, storeId: register.storeId,
        before: { storeId: current.storeId, status: current.status, code: current.code }, after: { storeId: register.storeId, status: register.status, code: register.code } });
      return register;
    });
  } catch (error) { return conflict(error, 'REGISTER_UPDATE_CONFLICT'); }
}

export async function listOrdersAdmin(prisma: PrismaClient, actor: AdminActor, input: PageInput & {
  search?: string | undefined; storeId?: string | undefined; registerId?: string | undefined; employeeId?: string | undefined; status?: Prisma.EnumOrderStatusFilter['equals'];
  paymentStatus?: Prisma.EnumPaymentStatusFilter['equals']; paymentKind?: Prisma.EnumPaymentKindFilter['equals']; from?: Date | undefined; to?: Date | undefined;
}) {
  const { page, pageSize, skip } = pageArgs(input); const query = clean(input.search);
  const where: Prisma.OrderWhereInput = { organizationId: actor.organizationId, ...(input.storeId ? { storeId: input.storeId } : {}),
    ...(input.registerId ? { registerId: input.registerId } : {}), ...(input.employeeId ? { session: { employeeId: input.employeeId } } : {}),
    ...(input.status ? { status: input.status } : {}), ...(input.paymentStatus || input.paymentKind ? { payments: { some: {
      ...(input.paymentStatus ? { status: input.paymentStatus } : {}), ...(input.paymentKind ? { kind: input.paymentKind } : {}) } } } : {}),
    ...(input.from || input.to ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}),
    ...(query ? { OR: [{ orderNumber: { contains: query, mode: 'insensitive' } }, { items: { some: { OR: [
      { productNameSnapshot: { contains: query, mode: 'insensitive' } }, { skuSnapshot: { contains: query, mode: 'insensitive' } }, { barcodeSnapshot: { contains: query, mode: 'insensitive' } },
    ] } } }] } : {}) };
  const [items, total] = await Promise.all([
    prisma.order.findMany({ where, include: { store: true, register: true, session: { include: { employee: true } }, payments: true, refunds: true }, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    prisma.order.count({ where }),
  ]); return { items, page, pageSize, total };
}

export async function getOrderAdmin(prisma: PrismaClient, actor: AdminActor, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, organizationId: actor.organizationId }, include: { store: true, register: true,
    session: { include: { employee: true } }, items: { include: { refundItems: true } }, payments: { include: { attempts: true } }, refunds: { include: { items: true, employee: true, attempts: true } },
    reservations: { include: { lines: true } } } });
  if (!order) throw new PosError('ORDER_NOT_FOUND', 404);
  const inventoryMovements = await prisma.inventoryMovement.findMany({ where: { organizationId: actor.organizationId,
    OR: [{ referenceType: 'ORDER', referenceId: order.id }, { referenceType: 'INVENTORY_RESERVATION_CONVERSION', referenceId: { in: order.reservations.map(({ id }) => id) } }] }, orderBy: { createdAt: 'asc' } });
  return { ...order, inventoryMovements };
}

export async function listRefunds(prisma: PrismaClient, actor: AdminActor, input: PageInput & { storeId?: string | undefined; status?: Prisma.EnumRefundStatusFilter['equals']; search?: string | undefined; from?: Date | undefined; to?: Date | undefined }) {
  const { page, pageSize, skip } = pageArgs(input); const query = clean(input.search);
  const queryIsUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query);
  const where: Prisma.RefundWhereInput = { organizationId: actor.organizationId,
    ...(input.storeId ? { order: { storeId: input.storeId } } : {}), ...(input.status ? { status: input.status } : {}),
    ...(input.from || input.to ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}),
    ...(query ? { OR: [...(queryIsUuid ? [{ id: { equals: query } }] : []), { order: { orderNumber: { contains: query, mode: 'insensitive' } } }, { reason: { contains: query, mode: 'insensitive' } }] } : {}) };
  const [items, total] = await Promise.all([
    prisma.refund.findMany({ where, include: { order: { include: { store: true } }, employee: true, payment: true, items: true, attempts: true }, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    prisma.refund.count({ where }),
  ]); return { items, page, pageSize, total };
}

export async function listAuditRecords(prisma: PrismaClient, actor: AdminActor, input: PageInput & { action?: string | undefined; employeeId?: string | undefined; entityType?: string | undefined; storeId?: string | undefined; from?: Date | undefined; to?: Date | undefined }) {
  const { page, pageSize, skip } = pageArgs(input);
  const where: Prisma.AuditRecordWhereInput = { organizationId: actor.organizationId, ...(input.action ? { action: { contains: input.action, mode: 'insensitive' } } : {}),
    ...(input.employeeId ? { userId: input.employeeId } : {}), ...(input.entityType ? { entityType: input.entityType } : {}), ...(input.storeId ? { storeId: input.storeId } : {}),
    ...(input.from || input.to ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}) };
  const [items, total] = await Promise.all([
    prisma.auditRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }), prisma.auditRecord.count({ where }),
  ]); return { items, page, pageSize, total };
}

export async function getDashboard(prisma: PrismaClient, actor: AdminActor, storeId?: string) {
  const now = new Date(); const from = new Date(now); from.setHours(0, 0, 0, 0);
  const orderWhere: Prisma.OrderWhereInput = { organizationId: actor.organizationId, ...(storeId ? { storeId } : {}), createdAt: { gte: from }, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } };
  const refundWhere: Prisma.RefundWhereInput = { organizationId: actor.organizationId, status: 'SUCCEEDED', createdAt: { gte: from }, ...(storeId ? { order: { storeId } } : {}) };
  const [orders, refunds, openRegisters, inventory] = await Promise.all([
    prisma.order.aggregate({ where: orderWhere, _sum: { totalMinor: true }, _count: true }),
    prisma.refund.aggregate({ where: refundWhere, _sum: { amountMinor: true } }),
    prisma.registerSession.count({ where: { organizationId: actor.organizationId, ...(storeId ? { storeId } : {}), status: { in: ['OPEN', 'CLOSING'] } } }),
    prisma.inventoryLevel.findMany({ where: { organizationId: actor.organizationId, ...(storeId ? { storeId } : {}) }, select: { onHand: true, reserved: true, variant: { select: { lowStockThreshold: true } } } }),
  ]);
  return { salesMinor: (orders._sum.totalMinor ?? 0n).toString(), transactions: orders._count,
    refundMinor: (refunds._sum.amountMinor ?? 0n).toString(), openRegisters,
    lowStockProducts: inventory.filter((level) => level.onHand - level.reserved <= level.variant.lowStockThreshold).length,
    asOf: now.toISOString() };
}
