ALTER TYPE "PaymentKind" ADD VALUE IF NOT EXISTS 'GIFT_CARD';
ALTER TYPE "PaymentKind" ADD VALUE IF NOT EXISTS 'LOYALTY';

CREATE TYPE "LedgerStatus" AS ENUM ('PENDING', 'POSTED', 'CANCELLED');
CREATE TYPE "LoyaltyTransactionType" AS ENUM ('EARN', 'REDEEM', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'REVERSAL');
CREATE TYPE "GiftCardStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "GiftCardTransactionType" AS ENUM ('ISSUE', 'RELOAD', 'REDEEM', 'REFUND', 'REVERSAL');

ALTER TABLE "Customer"
  ADD COLUMN "emailNormalized" TEXT,
  ADD COLUMN "phoneNormalized" TEXT,
  ADD COLUMN notes TEXT,
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Customer"
SET "emailNormalized" = CASE WHEN email IS NULL THEN NULL ELSE lower(trim(email)) END,
    "phoneNormalized" = CASE WHEN phone IS NULL THEN NULL ELSE regexp_replace(phone, '[^0-9+]', '', 'g') END;

CREATE UNIQUE INDEX "Customer_organizationId_emailNormalized_key"
  ON "Customer" ("organizationId", "emailNormalized") WHERE "emailNormalized" IS NOT NULL;
CREATE UNIQUE INDEX "Customer_organizationId_phoneNormalized_key"
  ON "Customer" ("organizationId", "phoneNormalized") WHERE "phoneNormalized" IS NOT NULL;
CREATE INDEX "Customer_organizationId_active_idx" ON "Customer" ("organizationId", active);

CREATE TABLE "EmployeeShift" (
  id UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id),
  "employeeId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "registerId" UUID,
  "clockedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clockedOutAt" TIMESTAMP(3),
  "correctedClockedInAt" TIMESTAMP(3),
  "correctedClockedOutAt" TIMESTAMP(3),
  "correctionReason" TEXT,
  "correctedByEmployeeId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeShift_employee_fkey" FOREIGN KEY ("organizationId", "employeeId") REFERENCES "Employee"("organizationId", id),
  CONSTRAINT "EmployeeShift_store_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", id),
  CONSTRAINT "EmployeeShift_register_fkey" FOREIGN KEY ("organizationId", "registerId") REFERENCES "Register"("organizationId", id),
  CONSTRAINT "EmployeeShift_correctedBy_fkey" FOREIGN KEY ("organizationId", "correctedByEmployeeId") REFERENCES "Employee"("organizationId", id),
  CONSTRAINT "EmployeeShift_clock_range_check" CHECK ("clockedOutAt" IS NULL OR "clockedOutAt" >= "clockedInAt")
);
CREATE UNIQUE INDEX "EmployeeShift_organizationId_id_key" ON "EmployeeShift" ("organizationId", id);
CREATE UNIQUE INDEX "EmployeeShift_one_active_employee_key" ON "EmployeeShift" ("organizationId", "employeeId") WHERE "clockedOutAt" IS NULL;
CREATE INDEX "EmployeeShift_employee_history_idx" ON "EmployeeShift" ("organizationId", "employeeId", "clockedInAt" DESC);
CREATE INDEX "EmployeeShift_store_history_idx" ON "EmployeeShift" ("organizationId", "storeId", "clockedInAt" DESC);

CREATE TABLE "LoyaltyProgram" (
  id UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL UNIQUE REFERENCES "Organization"(id),
  enabled BOOLEAN NOT NULL DEFAULT false,
  "pointsEarned" INTEGER NOT NULL DEFAULT 1,
  "spendMinor" BIGINT NOT NULL DEFAULT 100,
  "redeemMinorPerPoint" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyProgram_positive_rules_check" CHECK ("pointsEarned" > 0 AND "spendMinor" > 0 AND "redeemMinorPerPoint" > 0)
);

CREATE TABLE "LoyaltyTransaction" (
  id UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id),
  "customerId" UUID NOT NULL,
  "orderId" UUID,
  "refundId" UUID,
  "employeeId" UUID,
  type "LoyaltyTransactionType" NOT NULL,
  status "LedgerStatus" NOT NULL DEFAULT 'POSTED',
  points INTEGER NOT NULL,
  reason TEXT,
  "referenceKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoyaltyTransaction_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "Customer"("organizationId", id),
  CONSTRAINT "LoyaltyTransaction_order_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "Order"("organizationId", id),
  CONSTRAINT "LoyaltyTransaction_refund_fkey" FOREIGN KEY ("organizationId", "refundId") REFERENCES "Refund"("organizationId", id),
  CONSTRAINT "LoyaltyTransaction_employee_fkey" FOREIGN KEY ("organizationId", "employeeId") REFERENCES "Employee"("organizationId", id),
  CONSTRAINT "LoyaltyTransaction_nonzero_check" CHECK (points <> 0)
);
CREATE UNIQUE INDEX "LoyaltyTransaction_organizationId_id_key" ON "LoyaltyTransaction" ("organizationId", id);
CREATE UNIQUE INDEX "LoyaltyTransaction_reference_key" ON "LoyaltyTransaction" ("organizationId", "referenceKey") WHERE "referenceKey" IS NOT NULL;
CREATE INDEX "LoyaltyTransaction_customer_history_idx" ON "LoyaltyTransaction" ("organizationId", "customerId", "createdAt" DESC);
CREATE INDEX "LoyaltyTransaction_order_idx" ON "LoyaltyTransaction" ("organizationId", "orderId");

CREATE TABLE "GiftCard" (
  id UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id),
  "codeHash" TEXT NOT NULL,
  "lastFour" TEXT NOT NULL,
  status "GiftCardStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "GiftCard_organizationId_id_key" ON "GiftCard" ("organizationId", id);
CREATE UNIQUE INDEX "GiftCard_organizationId_codeHash_key" ON "GiftCard" ("organizationId", "codeHash");
CREATE INDEX "GiftCard_lastFour_idx" ON "GiftCard" ("organizationId", "lastFour");

CREATE TABLE "GiftCardTransaction" (
  id UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id),
  "giftCardId" UUID NOT NULL,
  "orderId" UUID,
  "refundId" UUID,
  "employeeId" UUID,
  type "GiftCardTransactionType" NOT NULL,
  status "LedgerStatus" NOT NULL DEFAULT 'POSTED',
  "amountMinor" BIGINT NOT NULL,
  reason TEXT,
  "referenceKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GiftCardTransaction_card_fkey" FOREIGN KEY ("organizationId", "giftCardId") REFERENCES "GiftCard"("organizationId", id),
  CONSTRAINT "GiftCardTransaction_order_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "Order"("organizationId", id),
  CONSTRAINT "GiftCardTransaction_refund_fkey" FOREIGN KEY ("organizationId", "refundId") REFERENCES "Refund"("organizationId", id),
  CONSTRAINT "GiftCardTransaction_employee_fkey" FOREIGN KEY ("organizationId", "employeeId") REFERENCES "Employee"("organizationId", id),
  CONSTRAINT "GiftCardTransaction_nonzero_check" CHECK ("amountMinor" <> 0)
);
CREATE UNIQUE INDEX "GiftCardTransaction_organizationId_id_key" ON "GiftCardTransaction" ("organizationId", id);
CREATE UNIQUE INDEX "GiftCardTransaction_reference_key" ON "GiftCardTransaction" ("organizationId", "referenceKey") WHERE "referenceKey" IS NOT NULL;
CREATE INDEX "GiftCardTransaction_history_idx" ON "GiftCardTransaction" ("organizationId", "giftCardId", "createdAt" DESC);
CREATE INDEX "GiftCardTransaction_order_idx" ON "GiftCardTransaction" ("organizationId", "orderId");

CREATE OR REPLACE FUNCTION protect_phase3_ledger_fields() RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" <> NEW."organizationId"
     OR OLD.type <> NEW.type
     OR OLD."createdAt" <> NEW."createdAt"
     OR (TG_TABLE_NAME = 'LoyaltyTransaction' AND (OLD."customerId" <> NEW."customerId" OR OLD.points <> NEW.points))
     OR (TG_TABLE_NAME = 'GiftCardTransaction' AND (OLD."giftCardId" <> NEW."giftCardId" OR OLD."amountMinor" <> NEW."amountMinor")) THEN
    RAISE EXCEPTION 'ledger economic fields are immutable';
  END IF;
  IF OLD.status <> NEW.status AND NOT (OLD.status = 'PENDING' AND NEW.status IN ('POSTED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'invalid ledger status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LoyaltyTransaction_protect_fields"
  BEFORE UPDATE ON "LoyaltyTransaction" FOR EACH ROW EXECUTE FUNCTION protect_phase3_ledger_fields();
CREATE TRIGGER "GiftCardTransaction_protect_fields"
  BEFORE UPDATE ON "GiftCardTransaction" FOR EACH ROW EXECUTE FUNCTION protect_phase3_ledger_fields();
