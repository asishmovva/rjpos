import { PrismaClient } from '@prisma/client';
import { loadTestEnvironment, normalizeDatabaseIdentity } from '@rjpos/config';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testEnvironment = loadTestEnvironment();
// The loader rejects a non-test database name and a normalized identity match
// with DATABASE_URL before Prisma or any mutating client is started.
const testDatabaseIdentity = normalizeDatabaseIdentity(
  testEnvironment.TEST_DATABASE_URL,
);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const migration = spawnSync(
  pnpmCommand,
  ['exec', 'prisma', 'migrate', 'deploy'],
  {
    cwd: packageDirectory,
    env: {
      ...process.env,
      DATABASE_URL: testEnvironment.TEST_DATABASE_URL,
    },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  },
);
if (migration.status !== 0) {
  throw new Error(
    `Test database migration failed with exit code ${migration.status}`,
  );
}

const prisma = new PrismaClient({
  datasources: { db: { url: testEnvironment.TEST_DATABASE_URL } },
});

async function seedTestFixtures(): Promise<void> {
  const organizationId = testEnvironment.TEST_ORGANIZATION_ID;
  const storeId = testEnvironment.TEST_STORE_ID;
  const employeeId = '00000000-0000-0000-0000-000000000004';
  const registerId = '00000000-0000-0000-0000-000000000017';
  const categoryId = '00000000-0000-0000-0000-000000000007';
  const productId = '00000000-0000-0000-0000-000000000008';
  const sessionId = '00000000-0000-0000-0000-000000000018';

  await prisma.organization.upsert({
    where: { id: organizationId },
    update: {},
    create: { id: organizationId, name: 'RJ POS Test Organization' },
  });
  await prisma.store.upsert({
    where: { id: storeId },
    update: {},
    create: { id: storeId, organizationId, name: 'Test Store' },
  });
  await prisma.employee.upsert({
    where: { id: employeeId },
    update: {},
    create: {
      id: employeeId,
      organizationId,
      firstName: 'Test',
      lastName: 'Employee',
    },
  });
  await prisma.register.upsert({
    where: { id: registerId },
    update: {},
    create: {
      id: registerId,
      organizationId,
      storeId,
      name: 'Test Register',
      code: 'TEST-REGISTER',
    },
  });
  await prisma.category.upsert({
    where: { id: categoryId },
    update: {},
    create: { id: categoryId, organizationId, name: 'Test Category' },
  });
  await prisma.product.upsert({
    where: { id: productId },
    update: {},
    create: {
      id: productId,
      organizationId,
      categoryId,
      name: 'Test Product',
    },
  });
  await prisma.productVariant.upsert({
    where: { id: testEnvironment.TEST_VARIANT_ID },
    update: {},
    create: {
      id: testEnvironment.TEST_VARIANT_ID,
      organizationId,
      productId,
      name: 'Test Variant',
      sku: 'TEST-SKU',
    },
  });
  await prisma.inventoryLevel.upsert({
    where: {
      organizationId_storeId_variantId: {
        organizationId,
        storeId,
        variantId: testEnvironment.TEST_VARIANT_ID,
      },
    },
    update: {},
    create: {
      organizationId,
      storeId,
      variantId: testEnvironment.TEST_VARIANT_ID,
      onHand: 1,
    },
  });
  await prisma.registerSession.upsert({
    where: { id: sessionId },
    update: {},
    create: {
      id: sessionId,
      organizationId,
      storeId,
      registerId,
      employeeId,
      openingCashMinor: 0,
    },
  });
  for (const [id, orderNumber] of [
    [testEnvironment.TEST_ORDER_ID_ONE, 'TEST-ORDER-ONE'],
    [testEnvironment.TEST_ORDER_ID_TWO, 'TEST-ORDER-TWO'],
  ] as const) {
    await prisma.order.upsert({
      where: { id },
      update: {},
      create: {
        id,
        organizationId,
        storeId,
        registerId,
        registerSessionId: sessionId,
        orderNumber,
        subtotalMinor: 0,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
      },
    });
  }
}

try {
  await seedTestFixtures();
  console.log(
    `Prepared dedicated RJ POS test database fixtures at ${testDatabaseIdentity.host}:${testDatabaseIdentity.port}/${testDatabaseIdentity.database}`,
  );
} finally {
  await prisma.$disconnect();
}
