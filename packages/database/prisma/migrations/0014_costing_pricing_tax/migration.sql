-- CreateEnum
CREATE TYPE "TaxProfileKind" AS ENUM ('STANDARD', 'NON_TAXABLE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "VendorDealKind" AS ENUM ('DISCOUNT_PER_CASE', 'DEAL_CASE_PRICE', 'QUANTITY_BREAK', 'REBATE', 'ALLOWANCE');

-- CreateEnum
CREATE TYPE "CostHistorySource" AS ENUM ('PRODUCT_CREATED', 'PURCHASE_RECEIPT', 'INVOICE_CONFIRMED', 'MANUAL_UPDATE');

-- AlterTable
ALTER TABLE "InvoiceDocument" ADD COLUMN     "discountMinor" BIGINT,
ADD COLUMN     "feesMinor" BIGINT,
ADD COLUMN     "poReference" TEXT,
ADD COLUMN     "rawText" TEXT,
ADD COLUMN     "rebateMinor" BIGINT;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "caseCostMinor" BIGINT,
ADD COLUMN     "casesReceived" INTEGER,
ADD COLUMN     "discountPerCaseMinor" BIGINT,
ADD COLUMN     "rawText" TEXT,
ADD COLUMN     "size" TEXT,
ADD COLUMN     "updateVendorCost" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "priceBookNameSnapshot" TEXT,
ADD COLUMN     "taxProfileNameSnapshot" TEXT,
ADD COLUMN     "taxRateBasisPointsSnapshot" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "draft" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxProfileId" UUID;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "baseVariantId" UUID,
ADD COLUMN     "taxProfileId" UUID,
ADD COLUMN     "unitsPerPack" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "caseCostMinor" BIGINT,
ADD COLUMN     "discountPerCaseMinor" BIGINT,
ADD COLUMN     "rebatePerCaseMinor" BIGINT,
ADD COLUMN     "unitsPerCase" INTEGER;

-- AlterTable
ALTER TABLE "VendorProductMapping" ADD COLUMN     "caseCostMinor" BIGINT;

-- CreateTable
CREATE TABLE "TaxProfile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TaxProfileKind" NOT NULL DEFAULT 'CUSTOM',
    "rateBasisPoints" INTEGER,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBook" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialPrice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "priceBookId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorDeal" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "variantId" UUID,
    "name" TEXT NOT NULL,
    "kind" "VendorDealKind" NOT NULL,
    "amountMinor" BIGINT,
    "dealCaseCostMinor" BIGINT,
    "minimumCases" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCostHistory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "storeId" UUID,
    "variantId" UUID NOT NULL,
    "vendorId" UUID,
    "purchaseOrderId" UUID,
    "invoiceDocumentId" UUID,
    "source" "CostHistorySource" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "casesOrdered" INTEGER,
    "casesReceived" INTEGER,
    "unitsPerCase" INTEGER NOT NULL,
    "baseCaseCostMinor" BIGINT NOT NULL,
    "discountPerCaseMinor" BIGINT NOT NULL DEFAULT 0,
    "rebatePerCaseMinor" BIGINT NOT NULL DEFAULT 0,
    "effectiveCaseCostMinor" BIGINT NOT NULL,
    "effectiveUnitCostMinor" BIGINT NOT NULL,
    "unitsReceived" INTEGER,
    "unitsDamaged" INTEGER NOT NULL DEFAULT 0,
    "unitsRejected" INTEGER NOT NULL DEFAULT 0,
    "unitsShort" INTEGER NOT NULL DEFAULT 0,
    "createdByEmployeeId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCostHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxProfile_organizationId_id_key" ON "TaxProfile"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaxProfile_organizationId_name_key" ON "TaxProfile"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBook_organizationId_id_key" ON "PriceBook"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBook_organizationId_name_key" ON "PriceBook"("organizationId", "name");

-- CreateIndex
CREATE INDEX "SpecialPrice_organizationId_storeId_variantId_priceBookId_a_idx" ON "SpecialPrice"("organizationId", "storeId", "variantId", "priceBookId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialPrice_organizationId_id_key" ON "SpecialPrice"("organizationId", "id");

-- CreateIndex
CREATE INDEX "VendorDeal_organizationId_vendorId_variantId_active_idx" ON "VendorDeal"("organizationId", "vendorId", "variantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "VendorDeal_organizationId_id_key" ON "VendorDeal"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ProductCostHistory_organizationId_variantId_occurredAt_idx" ON "ProductCostHistory"("organizationId", "variantId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "ProductCostHistory_organizationId_vendorId_occurredAt_idx" ON "ProductCostHistory"("organizationId", "vendorId", "occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCostHistory_organizationId_id_key" ON "ProductCostHistory"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_taxProfileId_fkey" FOREIGN KEY ("organizationId", "taxProfileId") REFERENCES "TaxProfile"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_organizationId_baseVariantId_fkey" FOREIGN KEY ("organizationId", "baseVariantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_organizationId_taxProfileId_fkey" FOREIGN KEY ("organizationId", "taxProfileId") REFERENCES "TaxProfile"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxProfile" ADD CONSTRAINT "TaxProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialPrice" ADD CONSTRAINT "SpecialPrice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialPrice" ADD CONSTRAINT "SpecialPrice_organizationId_priceBookId_fkey" FOREIGN KEY ("organizationId", "priceBookId") REFERENCES "PriceBook"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialPrice" ADD CONSTRAINT "SpecialPrice_organizationId_storeId_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialPrice" ADD CONSTRAINT "SpecialPrice_organizationId_variantId_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDeal" ADD CONSTRAINT "VendorDeal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDeal" ADD CONSTRAINT "VendorDeal_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDeal" ADD CONSTRAINT "VendorDeal_organizationId_variantId_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCostHistory" ADD CONSTRAINT "ProductCostHistory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCostHistory" ADD CONSTRAINT "ProductCostHistory_organizationId_variantId_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants that Prisma cannot express.
ALTER TABLE "TaxProfile" ADD CONSTRAINT "TaxProfile_rate_matches_kind" CHECK (
  ("kind" = 'CUSTOM' AND "rateBasisPoints" IS NOT NULL AND "rateBasisPoints" BETWEEN 0 AND 10000)
  OR ("kind" = 'STANDARD' AND "rateBasisPoints" IS NULL)
  OR ("kind" = 'NON_TAXABLE' AND "rateBasisPoints" = 0)
);
CREATE UNIQUE INDEX "TaxProfile_one_default_per_organization" ON "TaxProfile"("organizationId") WHERE "isDefault";
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_pack_units_positive" CHECK ("unitsPerPack" >= 1);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_pack_not_self" CHECK ("baseVariantId" IS NULL OR "baseVariantId" <> "id");
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_base_has_unit_pack" CHECK ("baseVariantId" IS NOT NULL OR "unitsPerPack" = 1);
ALTER TABLE "SpecialPrice" ADD CONSTRAINT "SpecialPrice_amount_nonnegative" CHECK ("amountMinor" >= 0);
ALTER TABLE "SpecialPrice" ADD CONSTRAINT "SpecialPrice_window_ordered" CHECK ("effectiveFrom" IS NULL OR "effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "VendorDeal" ADD CONSTRAINT "VendorDeal_amounts_nonnegative" CHECK (COALESCE("amountMinor", 0) >= 0 AND COALESCE("dealCaseCostMinor", 0) >= 0 AND COALESCE("minimumCases", 1) >= 1);
ALTER TABLE "ProductCostHistory" ADD CONSTRAINT "ProductCostHistory_amounts_valid" CHECK ("unitsPerCase" >= 1 AND "baseCaseCostMinor" >= 0 AND "discountPerCaseMinor" >= 0 AND "rebatePerCaseMinor" >= 0 AND "effectiveCaseCostMinor" >= 0 AND "effectiveUnitCostMinor" >= 0);

-- Append-only cost history: rows are never updated or deleted.
CREATE OR REPLACE FUNCTION prevent_cost_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ProductCostHistory is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ProductCostHistory_append_only" BEFORE UPDATE OR DELETE ON "ProductCostHistory" FOR EACH ROW EXECUTE FUNCTION prevent_cost_history_mutation();

-- Backfill: standard and non-taxable tax profiles per organization; exempt products move to Non-Taxable.
INSERT INTO "TaxProfile" ("id", "organizationId", "name", "kind", "rateBasisPoints", "description", "isDefault", "updatedAt")
SELECT gen_random_uuid(), o."id", 'Standard State Tax', 'STANDARD', NULL, 'Uses each store''s standard tax rate.', true, CURRENT_TIMESTAMP FROM "Organization" o;
INSERT INTO "TaxProfile" ("id", "organizationId", "name", "kind", "rateBasisPoints", "description", "isDefault", "updatedAt")
SELECT gen_random_uuid(), o."id", 'Non-Taxable', 'NON_TAXABLE', 0, 'No sales tax.', false, CURRENT_TIMESTAMP FROM "Organization" o;
UPDATE "Product" p SET "taxProfileId" = t."id" FROM "TaxProfile" t
WHERE t."organizationId" = p."organizationId" AND t."kind" = 'NON_TAXABLE' AND p."taxCategory" = 'EXEMPT';

-- Named price books (editable data, not code): channel and special prices reference these.
INSERT INTO "PriceBook" ("id", "organizationId", "name", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", b."name", b."sortOrder", CURRENT_TIMESTAMP
FROM "Organization" o CROSS JOIN (VALUES ('Price A', 1), ('Price B', 2), ('DoorDash', 3), ('Uber Eats', 4)) AS b("name", "sortOrder");
