CREATE TYPE "InventoryTransferStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'REVIEWED', 'FINALIZED', 'CANCELLED');
CREATE TYPE "PromotionType" AS ENUM ('PERCENTAGE', 'FIXED', 'MULTIBUY');
CREATE TYPE "PromotionScope" AS ENUM ('VARIANT', 'PRODUCT', 'CATEGORY');

ALTER TABLE "InventoryLevel" ADD COLUMN "lowStockThreshold" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InventoryLevel" ADD COLUMN "reorderTarget" INTEGER NOT NULL DEFAULT 0;
UPDATE "InventoryLevel" level SET "lowStockThreshold" = variant."lowStockThreshold", "reorderTarget" = variant."lowStockThreshold"
FROM "ProductVariant" variant
WHERE level."organizationId" = variant."organizationId" AND level."variantId" = variant.id;
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_replenishment_nonnegative"
  CHECK ("lowStockThreshold" >= 0 AND "reorderTarget" >= "lowStockThreshold");

CREATE TABLE "InventoryTransfer" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "sourceStoreId" UUID NOT NULL,
  "destinationStoreId" UUID NOT NULL,
  "createdByEmployeeId" UUID NOT NULL,
  "submittedByEmployeeId" UUID,
  "shippedByEmployeeId" UUID,
  "transferNumber" TEXT NOT NULL,
  "status" "InventoryTransferStatus" NOT NULL DEFAULT 'DRAFT',
  "notes" TEXT,
  "shipIdempotencyKey" TEXT,
  "submittedAt" TIMESTAMP(3),
  "shippedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryTransfer_stores_different" CHECK ("sourceStoreId" <> "destinationStoreId")
);
CREATE UNIQUE INDEX "InventoryTransfer_organizationId_id_key" ON "InventoryTransfer"("organizationId", "id");
CREATE UNIQUE INDEX "InventoryTransfer_organizationId_transferNumber_key" ON "InventoryTransfer"("organizationId", "transferNumber");
CREATE UNIQUE INDEX "InventoryTransfer_organizationId_shipIdempotencyKey_key" ON "InventoryTransfer"("organizationId", "shipIdempotencyKey");
CREATE INDEX "InventoryTransfer_source_status_idx" ON "InventoryTransfer"("organizationId", "sourceStoreId", "status", "createdAt");
CREATE INDEX "InventoryTransfer_destination_status_idx" ON "InventoryTransfer"("organizationId", "destinationStoreId", "status", "createdAt");

CREATE TABLE "InventoryTransferLine" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "transferId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "requestedQuantity" INTEGER NOT NULL,
  "shippedQuantity" INTEGER NOT NULL DEFAULT 0,
  "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "InventoryTransferLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryTransferLine_quantities_valid" CHECK ("requestedQuantity" > 0 AND "shippedQuantity" >= 0 AND "receivedQuantity" >= 0 AND "shippedQuantity" <= "requestedQuantity" AND "receivedQuantity" <= "shippedQuantity")
);
CREATE UNIQUE INDEX "InventoryTransferLine_organizationId_id_key" ON "InventoryTransferLine"("organizationId", "id");
CREATE UNIQUE INDEX "InventoryTransferLine_transfer_variant_key" ON "InventoryTransferLine"("organizationId", "transferId", "variantId");

CREATE TABLE "InventoryTransferReceipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "transferId" UUID NOT NULL,
  "receivedByEmployeeId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "notes" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryTransferReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryTransferReceipt_organizationId_id_key" ON "InventoryTransferReceipt"("organizationId", "id");
CREATE UNIQUE INDEX "InventoryTransferReceipt_idempotency_key" ON "InventoryTransferReceipt"("organizationId", "idempotencyKey");
CREATE INDEX "InventoryTransferReceipt_transfer_received_idx" ON "InventoryTransferReceipt"("organizationId", "transferId", "receivedAt");

CREATE TABLE "InventoryTransferReceiptLine" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "receiptId" UUID NOT NULL,
  "transferLineId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  CONSTRAINT "InventoryTransferReceiptLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryTransferReceiptLine_quantity_positive" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "InventoryTransferReceiptLine_organizationId_id_key" ON "InventoryTransferReceiptLine"("organizationId", "id");
CREATE UNIQUE INDEX "InventoryTransferReceiptLine_receipt_line_key" ON "InventoryTransferReceiptLine"("organizationId", "receiptId", "transferLineId");

CREATE TABLE "StockCount" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "createdByEmployeeId" UUID NOT NULL,
  "reviewedByEmployeeId" UUID,
  "finalizedByEmployeeId" UUID,
  "countNumber" TEXT NOT NULL,
  "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
  "notes" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockCount_organizationId_id_key" ON "StockCount"("organizationId", "id");
CREATE UNIQUE INDEX "StockCount_organizationId_countNumber_key" ON "StockCount"("organizationId", "countNumber");
CREATE INDEX "StockCount_store_status_idx" ON "StockCount"("organizationId", "storeId", "status", "createdAt");

CREATE TABLE "StockCountLine" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "stockCountId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "expectedQuantity" INTEGER NOT NULL,
  "countedQuantity" INTEGER,
  "variance" INTEGER,
  CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockCountLine_quantities_nonnegative" CHECK ("expectedQuantity" >= 0 AND ("countedQuantity" IS NULL OR "countedQuantity" >= 0))
);
CREATE UNIQUE INDEX "StockCountLine_organizationId_id_key" ON "StockCountLine"("organizationId", "id");
CREATE UNIQUE INDEX "StockCountLine_count_variant_key" ON "StockCountLine"("organizationId", "stockCountId", "variantId");

CREATE TABLE "Promotion" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "storeId" UUID,
  "categoryId" UUID,
  "productId" UUID,
  "variantId" UUID,
  "createdByEmployeeId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "type" "PromotionType" NOT NULL,
  "scope" "PromotionScope" NOT NULL,
  "percentageBasisPoints" INTEGER,
  "fixedAmountMinor" BIGINT,
  "bundleQuantity" INTEGER,
  "bundlePriceMinor" BIGINT,
  "minimumQuantity" INTEGER NOT NULL DEFAULT 1,
  "minimumSpendMinor" BIGINT NOT NULL DEFAULT 0,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Promotion_dates_valid" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "Promotion_minimums_valid" CHECK ("minimumQuantity" > 0 AND "minimumSpendMinor" >= 0),
  CONSTRAINT "Promotion_percentage_valid" CHECK ("percentageBasisPoints" IS NULL OR ("percentageBasisPoints" > 0 AND "percentageBasisPoints" <= 10000)),
  CONSTRAINT "Promotion_amounts_valid" CHECK (("fixedAmountMinor" IS NULL OR "fixedAmountMinor" > 0) AND ("bundleQuantity" IS NULL OR "bundleQuantity" > 0) AND ("bundlePriceMinor" IS NULL OR "bundlePriceMinor" >= 0)),
  CONSTRAINT "Promotion_scope_target" CHECK (("scope" = 'VARIANT' AND "variantId" IS NOT NULL AND "productId" IS NULL AND "categoryId" IS NULL) OR ("scope" = 'PRODUCT' AND "productId" IS NOT NULL AND "variantId" IS NULL AND "categoryId" IS NULL) OR ("scope" = 'CATEGORY' AND "categoryId" IS NOT NULL AND "variantId" IS NULL AND "productId" IS NULL)),
  CONSTRAINT "Promotion_type_values" CHECK (("type" = 'PERCENTAGE' AND "percentageBasisPoints" IS NOT NULL AND "fixedAmountMinor" IS NULL AND "bundleQuantity" IS NULL AND "bundlePriceMinor" IS NULL) OR ("type" = 'FIXED' AND "fixedAmountMinor" IS NOT NULL AND "percentageBasisPoints" IS NULL AND "bundleQuantity" IS NULL AND "bundlePriceMinor" IS NULL) OR ("type" = 'MULTIBUY' AND "bundleQuantity" IS NOT NULL AND "bundlePriceMinor" IS NOT NULL AND "percentageBasisPoints" IS NULL AND "fixedAmountMinor" IS NULL))
);
CREATE UNIQUE INDEX "Promotion_organizationId_id_key" ON "Promotion"("organizationId", "id");
CREATE INDEX "Promotion_active_window_idx" ON "Promotion"("organizationId", "storeId", "active", "startsAt", "endsAt");
CREATE INDEX "Promotion_category_idx" ON "Promotion"("organizationId", "categoryId");
CREATE INDEX "Promotion_product_idx" ON "Promotion"("organizationId", "productId");
CREATE INDEX "Promotion_variant_idx" ON "Promotion"("organizationId", "variantId");

ALTER TABLE "OrderItem" ADD COLUMN "promotionId" UUID;
ALTER TABLE "OrderItem" ADD COLUMN "promotionNameSnapshot" TEXT;

ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_sourceStore_fkey" FOREIGN KEY ("organizationId", "sourceStoreId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_destinationStore_fkey" FOREIGN KEY ("organizationId", "destinationStoreId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_createdBy_fkey" FOREIGN KEY ("organizationId", "createdByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_submittedBy_fkey" FOREIGN KEY ("organizationId", "submittedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_shippedBy_fkey" FOREIGN KEY ("organizationId", "shippedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_transfer_fkey" FOREIGN KEY ("organizationId", "transferId") REFERENCES "InventoryTransfer"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_variant_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferReceipt" ADD CONSTRAINT "InventoryTransferReceipt_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferReceipt" ADD CONSTRAINT "InventoryTransferReceipt_transfer_fkey" FOREIGN KEY ("organizationId", "transferId") REFERENCES "InventoryTransfer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferReceipt" ADD CONSTRAINT "InventoryTransferReceipt_receivedBy_fkey" FOREIGN KEY ("organizationId", "receivedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferReceiptLine" ADD CONSTRAINT "InventoryTransferReceiptLine_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferReceiptLine" ADD CONSTRAINT "InventoryTransferReceiptLine_receipt_fkey" FOREIGN KEY ("organizationId", "receiptId") REFERENCES "InventoryTransferReceipt"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferReceiptLine" ADD CONSTRAINT "InventoryTransferReceiptLine_transferLine_fkey" FOREIGN KEY ("organizationId", "transferLineId") REFERENCES "InventoryTransferLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_store_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_createdBy_fkey" FOREIGN KEY ("organizationId", "createdByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_reviewedBy_fkey" FOREIGN KEY ("organizationId", "reviewedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_finalizedBy_fkey" FOREIGN KEY ("organizationId", "finalizedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_count_fkey" FOREIGN KEY ("organizationId", "stockCountId") REFERENCES "StockCount"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_variant_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_store_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_category_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "Category"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_product_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_variant_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdBy_fkey" FOREIGN KEY ("organizationId", "createdByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_promotion_fkey" FOREIGN KEY ("organizationId", "promotionId") REFERENCES "Promotion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
