-- Phase 2 back-office lifecycle and operational metadata.
CREATE TYPE "StoreStatus" AS ENUM ('ACTIVE', 'INACTIVE');

ALTER TABLE "Store"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN "status" "StoreStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "receiptFooter" TEXT,
  ADD COLUMN "ageRestrictionLabel" TEXT NOT NULL DEFAULT '21+';

ALTER TABLE "Category" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "ProductVariant"
  ADD COLUMN "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "ProductVariant_low_stock_threshold_nonnegative"
    CHECK ("lowStockThreshold" >= 0);

ALTER TABLE "InventoryMovement"
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "resultingOnHand" INTEGER;

-- Preserve legacy Phase 1 reason values while giving Phase 2 a dedicated field.
UPDATE "InventoryMovement"
SET "reason" = "referenceId"
WHERE "referenceType" IN ('OPENING_BALANCE', 'MANUAL_ADJUSTMENT')
  AND "reason" IS NULL;

CREATE INDEX "Category_organizationId_active_name_idx"
  ON "Category" ("organizationId", "active", "name");
CREATE INDEX "Store_organizationId_status_name_idx"
  ON "Store" ("organizationId", "status", "name");
CREATE INDEX "InventoryMovement_admin_history_idx"
  ON "InventoryMovement" ("organizationId", "storeId", "createdAt" DESC);
