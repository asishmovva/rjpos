import { PrismaClient } from '@prisma/client';
import { loadEnvironment } from '@rjpos/config';

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
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      organizationId: organization.id,
      name: 'Downtown',
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
  console.log(`Seeded fictional organization ${organization.name}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
