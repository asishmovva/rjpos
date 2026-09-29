import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { findWorkspaceRoot, loadEnvironment } from '@rjpos/config';
import { hashPin } from '../src/pin.js';
import { importMasterCatalogCsv } from '../src/purchasing.js';

const environment = loadEnvironment();
const prisma = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });

async function main(): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'RJ Demo Liquors',
    },
  });
  const store = await prisma.store.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: { taxRateBasisPoints: 662 },
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      organizationId: organization.id,
      name: 'Downtown',
      taxRateBasisPoints: 662,
    },
  });
  await prisma.register.upsert({
    where: { id: '00000000-0000-0000-0000-000000000003' },
    update: {},
    create: { id: '00000000-0000-0000-0000-000000000003', organizationId: organization.id, storeId: store.id, name: 'Register 01', code: 'REG-01' },
  });
  for (const employee of [
    ['00000000-0000-0000-0000-000000000004', 'Demo', 'Owner'],
    ['00000000-0000-0000-0000-000000000005', 'Demo', 'Manager'],
    ['00000000-0000-0000-0000-000000000006', 'Demo', 'Cashier'],
  ] as const) {
    await prisma.employee.upsert({
      where: { id: employee[0] },
      update: {},
      create: { id: employee[0], organizationId: organization.id, firstName: employee[1], lastName: employee[2] },
    });
    await prisma.employeeStore.upsert({
      where: { organizationId_employeeId_storeId: { organizationId: organization.id, employeeId: employee[0], storeId: store.id } },
      update: {},
      create: { organizationId: organization.id, employeeId: employee[0], storeId: store.id },
    });
  }
  // Development-only approval PINs so Manager/Owner elevation can be exercised at the register. Set real PINs per store.
  for (const [id, pin] of [['00000000-0000-0000-0000-000000000004', '1234'], ['00000000-0000-0000-0000-000000000005', '2468'], ['00000000-0000-0000-0000-000000000006', '1111']] as const) {
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id }, select: { pinHash: true } });
    if (!employee.pinHash) await prisma.employee.update({ where: { id }, data: { pinHash: hashPin(pin) } });
  }
  const permissionCodes = [
    'catalog:read', 'inventory:read', 'inventory:adjust', 'register:open',
    'register:close', 'sale:create', 'discount:apply', 'order:read',
    'order:void', 'order:refund', 'settings:write',
    'mastercatalog:manage', 'vendor:read', 'vendor:manage', 'purchase:read', 'purchase:manage',
  ];
  const permissions = new Map<string, string>();
  for (const code of permissionCodes) {
    const permission = await prisma.permission.upsert({
      where: { organizationId_code: { organizationId: organization.id, code } },
      update: {}, create: { organizationId: organization.id, code },
    });
    permissions.set(code, permission.id);
  }
  const roleRules: Record<string, string[]> = {
    Owner: permissionCodes,
    Manager: permissionCodes.filter((code) => code !== 'settings:write' && code !== 'vendor:manage' && code !== 'mastercatalog:manage'),
    Cashier: ['catalog:read', 'inventory:read', 'register:open', 'sale:create', 'order:read'],
  };
  const employeeByRole: Record<string, string> = {
    Owner: '00000000-0000-0000-0000-000000000004',
    Manager: '00000000-0000-0000-0000-000000000005',
    Cashier: '00000000-0000-0000-0000-000000000006',
  };
  for (const [name, codes] of Object.entries(roleRules)) {
    const role = await prisma.role.upsert({
      where: { organizationId_name: { organizationId: organization.id, name } },
      update: {}, create: { organizationId: organization.id, name },
    });
    await prisma.employeeRole.upsert({
      where: { organizationId_employeeId_roleId: { organizationId: organization.id, employeeId: employeeByRole[name]!, roleId: role.id } },
      update: {}, create: { organizationId: organization.id, employeeId: employeeByRole[name]!, roleId: role.id },
    });
    for (const code of codes) {
      await prisma.rolePermission.upsert({
        where: { organizationId_roleId_permissionId: { organizationId: organization.id, roleId: role.id, permissionId: permissions.get(code)! } },
        update: {}, create: { organizationId: organization.id, roleId: role.id, permissionId: permissions.get(code)! },
      });
    }
  }
  const category = await prisma.category.upsert({
    where: { organizationId_name: { organizationId: organization.id, name: 'Spirits' } },
    update: {}, create: { organizationId: organization.id, name: 'Spirits' },
  });
  const product = await prisma.product.upsert({
    where: { id: '10000000-0000-0000-0000-000000000001' },
    update: { active: true, ageRestricted: true, inventoryTracked: true, taxCategory: 'STANDARD' },
    create: { id: '10000000-0000-0000-0000-000000000001', organizationId: organization.id,
      categoryId: category.id, name: "Tito's Handmade Vodka", brand: "Tito's", active: true,
      ageRestricted: true, inventoryTracked: true, taxCategory: 'STANDARD' },
  });
  const variants = [
    ['10000000-0000-0000-0000-000000000375', '375 ml', 'TITO-375', '619947000013', '375', 1099n],
    ['10000000-0000-0000-0000-000000000750', '750 ml', 'TITO-750', '619947000020', '750', 1999n],
    ['10000000-0000-0000-0000-000000001000', '1 L', 'TITO-1L', '619947000037', '1000', 2499n],
    ['10000000-0000-0000-0000-000000001750', '1.75 L', 'TITO-1750', '619947000044', '1750', 3499n],
  ] as const;
  for (const [id, name, sku, barcodeValue, size, amountMinor] of variants) {
    const variant = await prisma.productVariant.upsert({
      where: { id }, update: { active: true, costMinor: amountMinor / 2n },
      create: { id, organizationId: organization.id, productId: product.id, name, sku,
        size, unit: 'ML', active: true, costMinor: amountMinor / 2n },
    });
    await prisma.barcode.upsert({
      where: { organizationId_barcodeValue: { organizationId: organization.id, barcodeValue } },
      update: { variantId: variant.id }, create: { organizationId: organization.id, variantId: variant.id, barcodeValue },
    });
    const price = await prisma.price.findFirst({ where: { organizationId: organization.id, storeId: store.id, variantId: variant.id, effectiveTo: null } });
    if (price) await prisma.price.update({ where: { id: price.id }, data: { amountMinor } });
    else await prisma.price.create({ data: { organizationId: organization.id, storeId: store.id,
      variantId: variant.id, amountMinor, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    await prisma.inventoryLevel.upsert({
      where: { organizationId_storeId_variantId: { organizationId: organization.id, storeId: store.id, variantId: variant.id } },
      update: {}, create: { organizationId: organization.id, storeId: store.id, variantId: variant.id, onHand: 24 },
    });
    const opening = await prisma.inventoryMovement.findFirst({ where: { organizationId: organization.id, storeId: store.id, variantId: variant.id, type: 'INITIAL' } });
    if (!opening) await prisma.inventoryMovement.create({ data: { organizationId: organization.id, storeId: store.id,
      variantId: variant.id, quantityDelta: 24, type: 'INITIAL', referenceType: 'SEED', referenceId: 'PHASE_1_DEMO' } });
  }
  const masterCatalogCsv = readFileSync(join(findWorkspaceRoot(), 'CategorizedItemList.csv'), 'utf8');
  const masterCatalogSummary = await importMasterCatalogCsv(prisma, {
    organizationId: organization.id,
    userId: '00000000-0000-0000-0000-000000000004',
    storeId: store.id,
  }, masterCatalogCsv);
  console.log(`Seeded fictional organization ${organization.name} and master catalog: ${masterCatalogSummary.added} added, ${masterCatalogSummary.updated} updated, ${masterCatalogSummary.skipped} skipped, ${masterCatalogSummary.invalid} invalid, ${masterCatalogSummary.duplicate} duplicate`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
