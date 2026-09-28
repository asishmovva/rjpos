CREATE TYPE "HeldTransactionStatus" AS ENUM ('HELD', 'RESUMED', 'CANCELLED');

CREATE TABLE "QuickKey" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "registerId" UUID,
  "variantId" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "groupName" TEXT NOT NULL DEFAULT 'Favorites',
  "position" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuickKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuickKey_position_nonnegative" CHECK ("position" >= 0)
);
CREATE UNIQUE INDEX "QuickKey_organizationId_id_key" ON "QuickKey"("organizationId", "id");
CREATE UNIQUE INDEX "QuickKey_organizationId_storeId_registerId_position_key" ON "QuickKey"("organizationId", "storeId", "registerId", "position");
CREATE INDEX "QuickKey_lookup_idx" ON "QuickKey"("organizationId", "storeId", "registerId", "enabled", "groupName", "position");
ALTER TABLE "QuickKey" ADD CONSTRAINT "QuickKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickKey" ADD CONSTRAINT "QuickKey_store_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickKey" ADD CONSTRAINT "QuickKey_register_fkey" FOREIGN KEY ("organizationId", "storeId", "registerId") REFERENCES "Register"("organizationId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuickKey" ADD CONSTRAINT "QuickKey_variant_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HeldTransaction" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "registerId" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "customerId" UUID,
  "resumedByEmployeeId" UUID,
  "label" TEXT NOT NULL,
  "cartJson" JSONB NOT NULL,
  "status" "HeldTransactionStatus" NOT NULL DEFAULT 'HELD',
  "idempotencyKey" TEXT NOT NULL,
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resumedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "HeldTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HeldTransaction_organizationId_id_key" ON "HeldTransaction"("organizationId", "id");
CREATE UNIQUE INDEX "HeldTransaction_organizationId_idempotencyKey_key" ON "HeldTransaction"("organizationId", "idempotencyKey");
CREATE INDEX "HeldTransaction_active_idx" ON "HeldTransaction"("organizationId", "storeId", "registerId", "status", "heldAt" DESC);
ALTER TABLE "HeldTransaction" ADD CONSTRAINT "HeldTransaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HeldTransaction" ADD CONSTRAINT "HeldTransaction_store_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HeldTransaction" ADD CONSTRAINT "HeldTransaction_register_fkey" FOREIGN KEY ("organizationId", "storeId", "registerId") REFERENCES "Register"("organizationId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HeldTransaction" ADD CONSTRAINT "HeldTransaction_employee_fkey" FOREIGN KEY ("organizationId", "employeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HeldTransaction" ADD CONSTRAINT "HeldTransaction_resumedBy_fkey" FOREIGN KEY ("organizationId", "resumedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HeldTransaction" ADD CONSTRAINT "HeldTransaction_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "Customer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
