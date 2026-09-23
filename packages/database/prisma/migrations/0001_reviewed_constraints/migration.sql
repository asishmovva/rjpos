-- Reviewed PostgreSQL constraints not expressible as Prisma schema attributes.
CREATE UNIQUE INDEX IF NOT EXISTS terminal_assignment_active_terminal
  ON "TerminalAssignment" ("organizationId", "terminalDeviceId")
  WHERE "unassignedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS terminal_assignment_active_register
  ON "TerminalAssignment" ("organizationId", "registerId")
  WHERE "unassignedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempt_provider_transaction
  ON "PaymentAttempt" ("organizationId", "merchantPaymentAccountId", "providerTransactionId")
  WHERE "providerTransactionId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS refund_attempt_provider_refund
  ON "RefundAttempt" ("organizationId", "merchantPaymentAccountId", "providerRefundId")
  WHERE "providerRefundId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_reservation_active_order
  ON "InventoryReservation" ("organizationId", "orderId")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS inventory_conversion_reference
  ON "InventoryMovement" ("organizationId", "referenceType", "referenceId", "variantId")
  WHERE "referenceType" = 'INVENTORY_RESERVATION_CONVERSION';

-- Effective price periods are prevented from overlapping per organization/store/variant.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "Price" ADD CONSTRAINT price_effective_period_valid
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
CREATE INDEX IF NOT EXISTS price_lookup_effective
  ON "Price" ("organizationId", "storeId", "variantId", "effectiveFrom", "effectiveTo");

ALTER TABLE "Price" ADD CONSTRAINT price_effective_period_nonoverlap_org
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "variantId" WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
  ) WHERE ("storeId" IS NULL);

ALTER TABLE "Price" ADD CONSTRAINT price_effective_period_nonoverlap_store
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "storeId" WITH =,
    "variantId" WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
  ) WHERE ("storeId" IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS price_org_effective_start
  ON "Price" ("organizationId", "variantId", "effectiveFrom")
  WHERE "storeId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS price_store_effective_start
  ON "Price" ("organizationId", "storeId", "variantId", "effectiveFrom")
  WHERE "storeId" IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_record_immutable ON "AuditRecord";
CREATE TRIGGER audit_record_immutable
  BEFORE UPDATE OR DELETE ON "AuditRecord"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
