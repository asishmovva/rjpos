DROP TRIGGER IF EXISTS "LoyaltyTransaction_protect_fields" ON "LoyaltyTransaction";
DROP TRIGGER IF EXISTS "GiftCardTransaction_protect_fields" ON "GiftCardTransaction";
DROP FUNCTION IF EXISTS protect_phase3_ledger_fields();

CREATE FUNCTION protect_loyalty_transaction_fields() RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR OLD."customerId" IS DISTINCT FROM NEW."customerId"
     OR OLD."type" IS DISTINCT FROM NEW."type"
     OR OLD.points IS DISTINCT FROM NEW.points
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'loyalty ledger economic fields are immutable';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status
     AND NOT (OLD.status = 'PENDING' AND NEW.status IN ('POSTED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'invalid loyalty ledger status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protect_gift_card_transaction_fields() RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR OLD."giftCardId" IS DISTINCT FROM NEW."giftCardId"
     OR OLD."type" IS DISTINCT FROM NEW."type"
     OR OLD."amountMinor" IS DISTINCT FROM NEW."amountMinor"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'gift-card ledger economic fields are immutable';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status
     AND NOT (OLD.status = 'PENDING' AND NEW.status IN ('POSTED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'invalid gift-card ledger status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LoyaltyTransaction_protect_fields"
  BEFORE UPDATE ON "LoyaltyTransaction" FOR EACH ROW EXECUTE FUNCTION protect_loyalty_transaction_fields();
CREATE TRIGGER "GiftCardTransaction_protect_fields"
  BEFORE UPDATE ON "GiftCardTransaction" FOR EACH ROW EXECUTE FUNCTION protect_gift_card_transaction_fields();
