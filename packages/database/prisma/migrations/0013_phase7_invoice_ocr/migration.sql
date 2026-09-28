CREATE TYPE "InvoiceOcrStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "InvoiceReviewStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'REJECTED');
CREATE TYPE "InvoiceLineMatchStatus" AS ENUM ('MATCHED', 'MASTER_CATALOG', 'NEEDS_REVIEW', 'NEW_PRODUCT', 'INVALID');

CREATE TABLE "InvoiceDocument" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "vendorId" UUID,
  "purchaseOrderId" UUID,
  "uploadedByEmployeeId" UUID NOT NULL,
  "confirmedByEmployeeId" UUID,
  "rejectedByEmployeeId" UUID,
  "originalFilename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "storageReference" TEXT NOT NULL,
  "documentHash" TEXT NOT NULL,
  "documentData" BYTEA NOT NULL,
  "ocrStatus" "InvoiceOcrStatus" NOT NULL DEFAULT 'PENDING',
  "ocrProvider" TEXT,
  "ocrError" TEXT,
  "ocrConfidence" DECIMAL(5,4),
  "rawProviderResult" JSONB,
  "reviewStatus" "InvoiceReviewStatus" NOT NULL DEFAULT 'DRAFT',
  "vendorNameExtracted" TEXT,
  "invoiceNumber" TEXT,
  "invoiceDate" TIMESTAMP(3),
  "subtotalMinor" BIGINT,
  "taxMinor" BIGINT,
  "totalMinor" BIGINT,
  "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvoiceDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceLine" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "invoiceDocumentId" UUID NOT NULL,
  "variantId" UUID,
  "masterProductId" UUID,
  "lineNumber" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "upc" TEXT,
  "vendorSku" TEXT,
  "quantity" INTEGER NOT NULL,
  "caseQuantity" INTEGER NOT NULL DEFAULT 1,
  "unitCostMinor" BIGINT NOT NULL,
  "lineTotalMinor" BIGINT NOT NULL,
  "confidence" DECIMAL(5,4),
  "matchStatus" "InvoiceLineMatchStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "newProductData" JSONB,
  "ignored" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvoiceDocument_organizationId_id_key" ON "InvoiceDocument"("organizationId", "id");
CREATE UNIQUE INDEX "InvoiceDocument_organizationId_documentHash_key" ON "InvoiceDocument"("organizationId", "documentHash");
CREATE INDEX "InvoiceDocument_organizationId_storeId_reviewStatus_uploadedAt_idx" ON "InvoiceDocument"("organizationId", "storeId", "reviewStatus", "uploadedAt" DESC);
CREATE INDEX "InvoiceDocument_organizationId_vendorId_invoiceNumber_invoiceDate_idx" ON "InvoiceDocument"("organizationId", "vendorId", "invoiceNumber", "invoiceDate");
CREATE UNIQUE INDEX "InvoiceLine_organizationId_id_key" ON "InvoiceLine"("organizationId", "id");
CREATE UNIQUE INDEX "InvoiceLine_organizationId_invoiceDocumentId_lineNumber_key" ON "InvoiceLine"("organizationId", "invoiceDocumentId", "lineNumber");
CREATE INDEX "InvoiceLine_organizationId_invoiceDocumentId_matchStatus_idx" ON "InvoiceLine"("organizationId", "invoiceDocumentId", "matchStatus");

ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_organizationId_storeId_fkey" FOREIGN KEY ("organizationId", "storeId") REFERENCES "Store"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_organizationId_purchaseOrderId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_uploadedBy_fkey" FOREIGN KEY ("organizationId", "uploadedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_confirmedBy_fkey" FOREIGN KEY ("organizationId", "confirmedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_rejectedBy_fkey" FOREIGN KEY ("organizationId", "rejectedByEmployeeId") REFERENCES "Employee"("organizationId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_document_fkey" FOREIGN KEY ("organizationId", "invoiceDocumentId") REFERENCES "InvoiceDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_variant_fkey" FOREIGN KEY ("organizationId", "variantId") REFERENCES "ProductVariant"("organizationId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_masterProductId_fkey" FOREIGN KEY ("masterProductId") REFERENCES "MasterProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
