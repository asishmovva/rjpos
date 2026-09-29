import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { findWorkspaceRoot, loadEnvironment } from '@rjpos/config';
import { seedDemoStoreCatalog } from '../src/demo-store-catalog.js';

// DEVELOPMENT/DEMO ONLY: never seeds production stores unless explicitly overridden.
if (process.env.NODE_ENV === 'production' && process.env.RJPOS_ALLOW_DEMO_SEED !== '1') {
  throw new Error('Demo store seeding is disabled in production. Set RJPOS_ALLOW_DEMO_SEED=1 to override deliberately.');
}
const environment = loadEnvironment();
const prisma = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
const organizationId = process.env.RJPOS_DEMO_ORGANIZATION_ID ?? '00000000-0000-0000-0000-000000000001';
const storeId = process.env.RJPOS_DEMO_STORE_ID ?? '00000000-0000-0000-0000-000000000002';
const employeeId = process.env.RJPOS_DEMO_EMPLOYEE_ID ?? '00000000-0000-0000-0000-000000000004';

try {
  const csv = readFileSync(join(findWorkspaceRoot(), 'CategorizedItemList.csv'), 'utf8');
  console.log(JSON.stringify(await seedDemoStoreCatalog(prisma, { organizationId, storeId, employeeId }, csv), null, 2));
} finally {
  await prisma.$disconnect();
}
