ALTER TABLE "InventoryTransfer" ADD COLUMN "shipRequestFingerprint" TEXT;
ALTER TABLE "InventoryTransferReceipt" ADD COLUMN "requestFingerprint" TEXT;
UPDATE "InventoryTransferReceipt" SET "requestFingerprint" = 'legacy:' || id::text;
ALTER TABLE "InventoryTransferReceipt" ALTER COLUMN "requestFingerprint" SET NOT NULL;
