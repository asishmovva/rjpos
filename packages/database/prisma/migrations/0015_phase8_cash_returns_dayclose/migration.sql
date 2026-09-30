-- AlterEnum
ALTER TYPE "InventoryMovementType" ADD VALUE 'RETURN_NON_RESELLABLE';
ALTER TYPE "InventoryMovementType" ADD VALUE 'VENDOR_RETURN';

-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('RETURN_TO_STOCK', 'DAMAGED', 'NON_RESELLABLE', 'VENDOR_RETURN');

-- CreateEnum
CREATE TYPE "CashMovementKind" AS ENUM ('PAID_IN', 'PAID_OUT', 'SAFE_DROP', 'NO_SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

-- AlterTable
ALTER TABLE "RefundItem" ADD COLUMN     "disposition" "ReturnDisposition" NOT NULL DEFAULT 'RETURN_TO_STOCK';

-- AlterTable
ALTER TABLE "VendorProductMapping" ADD COLUMN     "caseUpc" TEXT;

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "registerSessionId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "approvedByEmployeeId" UUID,
    "kind" "CashMovementKind" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DayClose" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "closedByEmployeeId" UUID NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openRegisterCount" INTEGER NOT NULL DEFAULT 0,
    "openRegistersAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "totalsJson" JSONB NOT NULL,

    CONSTRAINT "DayClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashMovement_organizationId_registerSessionId_kind_idx" ON "CashMovement"("organizationId", "registerSessionId", "kind");

-- CreateIndex
CREATE INDEX "CashMovement_organizationId_storeId_createdAt_idx" ON "CashMovement"("organizationId", "storeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashMovement_organizationId_id_key" ON "CashMovement"("organizationId", "id");

-- CreateIndex
CREATE INDEX "DayClose_organizationId_storeId_businessDate_idx" ON "DayClose"("organizationId", "storeId", "businessDate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DayClose_organizationId_id_key" ON "DayClose"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DayClose_organizationId_storeId_businessDate_key" ON "DayClose"("organizationId", "storeId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "VendorProductMapping_organizationId_caseUpc_key" ON "VendorProductMapping"("organizationId", "caseUpc");

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_organizationId_registerSessionId_fkey" FOREIGN KEY ("organizationId", "registerSessionId") REFERENCES "RegisterSession"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_organizationId_storeId_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants Prisma cannot express.
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_amount_valid" CHECK (
  ("kind" = 'NO_SALE' AND "amountMinor" = 0) OR ("kind" <> 'NO_SALE' AND "amountMinor" > 0)
);
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_reason_required" CHECK (
  "kind" IN ('PAID_IN', 'SAFE_DROP') OR length(btrim(COALESCE("reason", ''))) > 0
);
CREATE OR REPLACE FUNCTION prevent_phase8_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CashMovement_append_only" BEFORE UPDATE OR DELETE ON "CashMovement" FOR EACH ROW EXECUTE FUNCTION prevent_phase8_immutable_mutation();
CREATE TRIGGER "DayClose_immutable" BEFORE UPDATE OR DELETE ON "DayClose" FOR EACH ROW EXECUTE FUNCTION prevent_phase8_immutable_mutation();

-- Earlier refunds that did not return stock were not resellable.
UPDATE "RefundItem" SET "disposition" = 'NON_RESELLABLE' WHERE "returnToStock" = false;
