CREATE TYPE "PurchaseOrderStatus" AS ENUM (
  'DRAFT',
  'SUBMITTED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED'
);

ALTER TYPE "InventoryMovementType" ADD VALUE 'PURCHASE_RECEIPT';

CREATE TABLE "MasterProduct" (
  "id" UUID NOT NULL,
  "upc" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "brand" TEXT,
  "size" DECIMAL(12,3),
  "unit" "ProductUnit" NOT NULL DEFAULT 'EACH',
  "sizeLabel" TEXT,
  "packName" TEXT,
  "category" TEXT,
  "referenceCostMinor" BIGINT,
  "referencePriceMinor" BIGINT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MasterProduct_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MasterProduct_upc_check" CHECK ("upc" ~ '^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$')
);
CREATE UNIQUE INDEX "MasterProduct_upc_key" ON "MasterProduct"("upc");
CREATE INDEX "MasterProduct_name_idx" ON "MasterProduct"("name");
CREATE INDEX "MasterProduct_brand_idx" ON "MasterProduct"("brand");

ALTER TABLE "ProductVariant" ADD COLUMN "masterProductId" UUID;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_masterProductId_fkey"
  FOREIGN KEY ("masterProductId") REFERENCES "MasterProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ProductVariant_masterProductId_idx" ON "ProductVariant"("masterProductId");

CREATE TABLE "Vendor" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "contactName" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "addressJson" JSONB,
  "accountReference" TEXT,
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Vendor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Vendor_organizationId_id_key" ON "Vendor"("organizationId", "id");
CREATE UNIQUE INDEX "Vendor_organizationId_name_key" ON "Vendor"("organizationId", "name");
CREATE INDEX "Vendor_organizationId_active_name_idx" ON "Vendor"("organizationId", "active", "name");

CREATE TABLE "VendorProductMapping" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "vendorId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "vendorSku" TEXT,
  "vendorCostMinor" BIGINT NOT NULL,
  "casePackQuantity" INTEGER NOT NULL DEFAULT 1,
  "minimumOrderQuantity" INTEGER NOT NULL DEFAULT 1,
  "preferred" BOOLEAN NOT NULL DEFAULT FALSE,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorProductMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VendorProductMapping_cost_check" CHECK ("vendorCostMinor" >= 0),
  CONSTRAINT "VendorProductMapping_pack_check" CHECK ("casePackQuantity" > 0 AND "minimumOrderQuantity" > 0),
  CONSTRAINT "VendorProductMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VendorProductMapping_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VendorProductMapping_organizationId_variantId_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VendorProductMapping_organizationId_id_key" ON "VendorProductMapping"("organizationId", "id");
CREATE UNIQUE INDEX "VendorProductMapping_organizationId_vendorId_variantId_key" ON "VendorProductMapping"("organizationId", "vendorId", "variantId");
CREATE INDEX "VendorProductMapping_organizationId_variantId_active_idx" ON "VendorProductMapping"("organizationId", "variantId", "active");
CREATE INDEX "VendorProductMapping_organizationId_vendorId_active_idx" ON "VendorProductMapping"("organizationId", "vendorId", "active");
CREATE UNIQUE INDEX "VendorProductMapping_one_preferred_per_variant"
  ON "VendorProductMapping"("organizationId", "variantId") WHERE "preferred" = TRUE AND "active" = TRUE;

CREATE TABLE "PurchaseOrder" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "vendorId" UUID NOT NULL,
  "createdByEmployeeId" UUID NOT NULL,
  "poNumber" TEXT NOT NULL,
  "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "notes" TEXT,
  "submittedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseOrder_organizationId_storeId_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseOrder_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseOrder_organizationId_createdByEmployeeId_fkey" FOREIGN KEY ("organizationId", "createdByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_id_key" ON "PurchaseOrder"("organizationId", "id");
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_poNumber_key" ON "PurchaseOrder"("organizationId", "poNumber");
CREATE INDEX "PurchaseOrder_organizationId_storeId_status_createdAt_idx" ON "PurchaseOrder"("organizationId", "storeId", "status", "createdAt");
CREATE INDEX "PurchaseOrder_organizationId_vendorId_createdAt_idx" ON "PurchaseOrder"("organizationId", "vendorId", "createdAt");

CREATE TABLE "PurchaseOrderLine" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "purchaseOrderId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "productNameSnapshot" TEXT NOT NULL,
  "variantNameSnapshot" TEXT NOT NULL,
  "skuSnapshot" TEXT NOT NULL,
  "vendorSkuSnapshot" TEXT,
  "orderedQuantity" INTEGER NOT NULL,
  "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
  "unitCostMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseOrderLine_quantities_check" CHECK ("orderedQuantity" > 0 AND "receivedQuantity" >= 0 AND "receivedQuantity" <= "orderedQuantity"),
  CONSTRAINT "PurchaseOrderLine_cost_check" CHECK ("unitCostMinor" >= 0),
  CONSTRAINT "PurchaseOrderLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseOrderLine_organizationId_purchaseOrderId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PurchaseOrderLine_organizationId_variantId_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PurchaseOrderLine_organizationId_id_key" ON "PurchaseOrderLine"("organizationId", "id");
CREATE UNIQUE INDEX "PurchaseOrderLine_organizationId_purchaseOrderId_variantId_key" ON "PurchaseOrderLine"("organizationId", "purchaseOrderId", "variantId");
CREATE INDEX "PurchaseOrderLine_organizationId_variantId_idx" ON "PurchaseOrderLine"("organizationId", "variantId");

CREATE TABLE "PurchaseReceipt" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "purchaseOrderId" UUID NOT NULL,
  "receivedByEmployeeId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "vendorReferenceNumber" TEXT,
  "notes" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceipt_organizationId_purchaseOrderId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceipt_organizationId_receivedByEmployeeId_fkey" FOREIGN KEY ("organizationId", "receivedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PurchaseReceipt_organizationId_id_key" ON "PurchaseReceipt"("organizationId", "id");
CREATE UNIQUE INDEX "PurchaseReceipt_organizationId_idempotencyKey_key" ON "PurchaseReceipt"("organizationId", "idempotencyKey");
CREATE INDEX "PurchaseReceipt_organizationId_purchaseOrderId_receivedAt_idx" ON "PurchaseReceipt"("organizationId", "purchaseOrderId", "receivedAt");

CREATE TABLE "PurchaseReceiptLine" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "receiptId" UUID NOT NULL,
  "purchaseOrderLineId" UUID NOT NULL,
  "deliveredQuantity" INTEGER NOT NULL,
  "damagedQuantity" INTEGER NOT NULL DEFAULT 0,
  "rejectedQuantity" INTEGER NOT NULL DEFAULT 0,
  "unitCostMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseReceiptLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseReceiptLine_quantities_check" CHECK ("deliveredQuantity" > 0 AND "damagedQuantity" >= 0 AND "rejectedQuantity" >= 0 AND "damagedQuantity" + "rejectedQuantity" <= "deliveredQuantity"),
  CONSTRAINT "PurchaseReceiptLine_cost_check" CHECK ("unitCostMinor" >= 0),
  CONSTRAINT "PurchaseReceiptLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceiptLine_organizationId_receiptId_fkey" FOREIGN KEY ("organizationId", "receiptId") REFERENCES "PurchaseReceipt"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PurchaseReceiptLine_organizationId_purchaseOrderLineId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PurchaseReceiptLine_organizationId_id_key" ON "PurchaseReceiptLine"("organizationId", "id");
CREATE UNIQUE INDEX "PurchaseReceiptLine_organizationId_receiptId_purchaseOrderL_key" ON "PurchaseReceiptLine"("organizationId", "receiptId", "purchaseOrderLineId");
CREATE INDEX "PurchaseReceiptLine_organizationId_purchaseOrderLineId_idx" ON "PurchaseReceiptLine"("organizationId", "purchaseOrderLineId");

CREATE TABLE "StoreProductCost" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreProductCost_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreProductCost_amount_check" CHECK ("amountMinor" >= 0),
  CONSTRAINT "StoreProductCost_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StoreProductCost_organizationId_storeId_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StoreProductCost_organizationId_variantId_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoreProductCost_organizationId_id_key" ON "StoreProductCost"("organizationId", "id");
CREATE UNIQUE INDEX "StoreProductCost_organizationId_storeId_variantId_key" ON "StoreProductCost"("organizationId", "storeId", "variantId");
CREATE INDEX "StoreProductCost_organizationId_storeId_idx" ON "StoreProductCost"("organizationId", "storeId");
