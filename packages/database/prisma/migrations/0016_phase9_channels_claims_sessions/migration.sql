-- AlterEnum
ALTER TYPE "HeldTransactionStatus" ADD VALUE 'EXPIRED';

-- CreateEnum
CREATE TYPE "BarcodeKind" AS ENUM ('PRIMARY', 'ALTERNATE');

-- CreateEnum
CREATE TYPE "VendorClaimKind" AS ENUM ('RETURN', 'SHORTAGE', 'DAMAGE', 'PRICE_DIFFERENCE');

-- CreateEnum
CREATE TYPE "VendorClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CREDITED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Barcode" ADD COLUMN     "kind" "BarcodeKind" NOT NULL DEFAULT 'PRIMARY';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "HeldTransaction" ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "channelNameSnapshot" TEXT NOT NULL DEFAULT 'Walk-In',
ADD COLUMN     "salesChannelId" UUID;

-- CreateTable
CREATE TABLE "SalesChannel" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "priceBookId" UUID,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorClaim" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "kind" "VendorClaimKind" NOT NULL,
    "status" "VendorClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "purchaseOrderId" UUID,
    "invoiceDocumentId" UUID,
    "reason" TEXT NOT NULL,
    "expectedCreditMinor" BIGINT NOT NULL DEFAULT 0,
    "creditedMinor" BIGINT,
    "creditReference" TEXT,
    "createdByEmployeeId" UUID NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorClaimLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostMinor" BIGINT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "VendorClaimLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesChannel_organizationId_id_key" ON "SalesChannel"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SalesChannel_organizationId_code_key" ON "SalesChannel"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SalesChannel_organizationId_name_key" ON "SalesChannel"("organizationId", "name");

-- CreateIndex
CREATE INDEX "VendorClaim_organizationId_storeId_status_createdAt_idx" ON "VendorClaim"("organizationId", "storeId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VendorClaim_organizationId_vendorId_status_idx" ON "VendorClaim"("organizationId", "vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VendorClaim_organizationId_id_key" ON "VendorClaim"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VendorClaimLine_organizationId_id_key" ON "VendorClaimLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VendorClaimLine_organizationId_claimId_variantId_key" ON "VendorClaimLine"("organizationId", "claimId", "variantId");

-- CreateIndex
CREATE INDEX "Order_organizationId_salesChannelId_createdAt_idx" ON "Order"("organizationId", "salesChannelId", "createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_salesChannelId_fkey" FOREIGN KEY ("organizationId", "salesChannelId") REFERENCES "SalesChannel"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesChannel" ADD CONSTRAINT "SalesChannel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesChannel" ADD CONSTRAINT "SalesChannel_organizationId_priceBookId_fkey" FOREIGN KEY ("organizationId", "priceBookId") REFERENCES "PriceBook"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClaim" ADD CONSTRAINT "VendorClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClaim" ADD CONSTRAINT "VendorClaim_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClaimLine" ADD CONSTRAINT "VendorClaimLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClaimLine" ADD CONSTRAINT "VendorClaimLine_organizationId_claimId_fkey" FOREIGN KEY ("organizationId", "claimId") REFERENCES "VendorClaim"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorClaimLine" ADD CONSTRAINT "VendorClaimLine_organizationId_variantId_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants Prisma cannot express.
ALTER TABLE "VendorClaim" ADD CONSTRAINT "VendorClaim_amounts_valid" CHECK ("expectedCreditMinor" >= 0 AND COALESCE("creditedMinor", 0) >= 0);
ALTER TABLE "VendorClaimLine" ADD CONSTRAINT "VendorClaimLine_quantity_positive" CHECK ("quantity" > 0 AND "unitCostMinor" >= 0);
CREATE UNIQUE INDEX "SalesChannel_one_default_per_organization" ON "SalesChannel"("organizationId") WHERE "isDefault";

-- Default channels per organization. DoorDash and Uber Eats use the price books of the same name when they exist.
INSERT INTO "SalesChannel" ("id", "organizationId", "name", "code", "priceBookId", "isDefault", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", c."name", c."code", (SELECT pb."id" FROM "PriceBook" pb WHERE pb."organizationId" = o."id" AND pb."name" = c."book"), c."isDefault", c."sortOrder", CURRENT_TIMESTAMP
FROM "Organization" o CROSS JOIN (VALUES
  ('Walk-In', 'WALK_IN', NULL, true, 0), ('DoorDash', 'DOORDASH', 'DoorDash', false, 1), ('Uber Eats', 'UBER_EATS', 'Uber Eats', false, 2),
  ('Web', 'WEB', NULL, false, 3), ('Phone', 'PHONE', NULL, false, 4), ('Custom', 'CUSTOM', NULL, false, 5)
) AS c("name", "code", "book", "isDefault", "sortOrder");
