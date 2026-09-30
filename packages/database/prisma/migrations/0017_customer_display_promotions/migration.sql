-- CreateTable
CREATE TABLE "PromoAsset" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageData" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromoAsset_organizationId_active_sortOrder_idx" ON "PromoAsset"("organizationId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PromoAsset_organizationId_id_key" ON "PromoAsset"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "PromoAsset" ADD CONSTRAINT "PromoAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants Prisma cannot express.
ALTER TABLE "PromoAsset" ADD CONSTRAINT "PromoAsset_window_valid" CHECK ("endsAt" IS NULL OR "startsAt" IS NULL OR "endsAt" > "startsAt");
ALTER TABLE "PromoAsset" ADD CONSTRAINT "PromoAsset_image_size" CHECK ("imageData" IS NULL OR length("imageData") <= 900000);
