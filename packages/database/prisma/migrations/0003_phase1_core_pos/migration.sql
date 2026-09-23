-- Phase 1 Core POS additions. Existing Phase 0 migrations remain immutable.
ALTER TABLE "Store" ADD COLUMN "taxRateBasisPoints" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Store" ADD CONSTRAINT "Store_tax_rate_valid"
  CHECK ("taxRateBasisPoints" >= 0 AND "taxRateBasisPoints" <= 10000);

ALTER TABLE "Product" ADD COLUMN "inventoryTracked" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Product" ADD COLUMN "taxCategory" TEXT NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "ProductVariant" ADD COLUMN "costMinor" BIGINT;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_cost_nonnegative"
  CHECK ("costMinor" IS NULL OR "costMinor" >= 0);

ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_nonnegative"
  CHECK ("onHand" >= 0 AND "reserved" >= 0 AND "reserved" <= "onHand");

ALTER TABLE "RegisterSession" ADD COLUMN "closedByEmployeeId" UUID;
ALTER TABLE "RegisterSession" ADD CONSTRAINT "RegisterSession_closedByEmployee_fkey"
  FOREIGN KEY ("organizationId", "closedByEmployeeId")
  REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "register_session_active_register"
  ON "RegisterSession" ("organizationId", "registerId")
  WHERE "status" IN ('OPEN', 'CLOSING');

ALTER TABLE "Order" ADD COLUMN "ageVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "ageVerifiedByEmployeeId" UUID;
ALTER TABLE "Order" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD CONSTRAINT "Order_ageVerifiedByEmployee_fkey"
  FOREIGN KEY ("organizationId", "ageVerifiedByEmployeeId")
  REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD COLUMN "taxCategorySnapshot" TEXT NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "Payment" ADD COLUMN "tenderedMinor" BIGINT;
ALTER TABLE "Payment" ADD COLUMN "changeDueMinor" BIGINT;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_cash_amounts_nonnegative"
  CHECK (
    ("tenderedMinor" IS NULL OR "tenderedMinor" >= 0)
    AND ("changeDueMinor" IS NULL OR "changeDueMinor" >= 0)
  );

ALTER TABLE "Refund" ADD COLUMN "reason" TEXT NOT NULL;
ALTER TABLE "Refund" ADD COLUMN "employeeId" UUID NOT NULL;
ALTER TABLE "Refund" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_employee_fkey"
  FOREIGN KEY ("organizationId", "employeeId")
  REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RefundItem" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "refundId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "returnToStock" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "RefundItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RefundItem_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "RefundItem_amount_nonnegative" CHECK ("amountMinor" >= 0)
);
CREATE UNIQUE INDEX "RefundItem_organizationId_id_key"
  ON "RefundItem" ("organizationId", "id");
CREATE UNIQUE INDEX "RefundItem_refund_order_item_key"
  ON "RefundItem" ("organizationId", "refundId", "orderItemId");
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_organization_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_refund_fkey"
  FOREIGN KEY ("organizationId", "refundId") REFERENCES "Refund"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_orderItem_fkey"
  FOREIGN KEY ("organizationId", "orderItemId") REFERENCES "OrderItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_variant_fkey"
  FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "inventory_opening_balance_once"
  ON "InventoryMovement" ("organizationId", "storeId", "variantId")
  WHERE "type" = 'INITIAL';
