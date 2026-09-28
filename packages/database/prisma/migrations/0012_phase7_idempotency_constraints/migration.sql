ALTER TABLE "HeldTransaction" ADD COLUMN "requestFingerprint" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HeldTransaction" ALTER COLUMN "requestFingerprint" DROP DEFAULT;
CREATE UNIQUE INDEX "QuickKey_store_position_key" ON "QuickKey"("organizationId", "storeId", "position") WHERE "registerId" IS NULL;
