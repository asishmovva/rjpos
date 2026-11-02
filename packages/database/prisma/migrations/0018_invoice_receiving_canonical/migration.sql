-- CreateEnum
CREATE TYPE "InvoiceDocType" AS ENUM ('INVOICE', 'CREDIT_MEMO', 'DELIVERY_RECEIPT', 'BACKORDER', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('PRODUCT', 'DELIVERY', 'FREIGHT', 'SERVICE', 'FEE', 'DEPOSIT', 'CREDIT', 'REBATE', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceLineFulfillment" AS ENUM ('RECEIVED', 'PARTIAL', 'BACKORDERED', 'OUT_OF_STOCK', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReceivingDisposition" AS ENUM ('SELLABLE', 'DAMAGED', 'REJECT_TO_VENDOR', 'VENDOR_CLAIM', 'PENDING_CREDIT');

-- CreateEnum
CREATE TYPE "InvoiceChargeKind" AS ENUM ('DELIVERY', 'FREIGHT', 'SERVICE', 'FUEL', 'FEE', 'DEPOSIT', 'TAX', 'CREDIT', 'OTHER');

-- AlterTable
ALTER TABLE "InvoiceDocument" ADD COLUMN     "amountDueMinor" BIGINT,
ADD COLUMN     "billTo" TEXT,
ADD COLUMN     "creditMinor" BIGINT,
ADD COLUMN     "customerAccountNumber" TEXT,
ADD COLUMN     "customerTerms" TEXT,
ADD COLUMN     "deliveryDate" TIMESTAMP(3),
ADD COLUMN     "depositMinor" BIGINT,
ADD COLUMN     "docType" "InvoiceDocType" NOT NULL DEFAULT 'INVOICE',
ADD COLUMN     "documentNumber" TEXT,
ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "fieldEvidence" JSONB,
ADD COLUMN     "grossMerchandiseMinor" BIGINT,
ADD COLUMN     "invoiceNetMinor" BIGINT,
ADD COLUMN     "licenseNumber" TEXT,
ADD COLUMN     "orderNumber" TEXT,
ADD COLUMN     "pageCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "paymentTerms" TEXT,
ADD COLUMN     "postOffTotalMinor" BIGINT,
ADD COLUMN     "remittanceMetadata" JSONB,
ADD COLUMN     "routeReference" TEXT,
ADD COLUMN     "salesperson" TEXT,
ADD COLUMN     "shipDate" TIMESTAMP(3),
ADD COLUMN     "shipTo" TEXT,
ADD COLUMN     "summaryMetadata" JSONB,
ADD COLUMN     "vendorAccountNumber" TEXT,
ADD COLUMN     "vendorAddress" TEXT,
ADD COLUMN     "vendorExtras" JSONB,
ADD COLUMN     "vendorPhone" TEXT,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "allowancePerCaseMinor" BIGINT,
ADD COLUMN     "alternateUpc" TEXT,
ADD COLUMN     "bonusUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "caseDiscountPerCaseMinor" BIGINT,
ADD COLUMN     "caseUpc" TEXT,
ADD COLUMN     "casesBackordered" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "casesDamaged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "casesOrdered" INTEGER,
ADD COLUMN     "casesRejected" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "categoryHint" TEXT,
ADD COLUMN     "correctedFields" JSONB,
ADD COLUMN     "damageDisposition" "ReceivingDisposition",
ADD COLUMN     "dealEndsAt" TIMESTAMP(3),
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "fulfillment" "InvoiceLineFulfillment" NOT NULL DEFAULT 'RECEIVED',
ADD COLUMN     "grossLineMinor" BIGINT,
ADD COLUMN     "lineDiscountMinor" BIGINT,
ADD COLUMN     "lineKind" "InvoiceLineKind" NOT NULL DEFAULT 'PRODUCT',
ADD COLUMN     "lineTaxMinor" BIGINT,
ADD COLUMN     "listCaseMinor" BIGINT,
ADD COLUMN     "looseUnitsReceived" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "looseUnitsShipped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "netCaseCostMinor" BIGINT,
ADD COLUMN     "netUnitCostMinor" BIGINT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "otherDiscountPerCaseMinor" BIGINT,
ADD COLUMN     "packLabel" TEXT,
ADD COLUMN     "postOffPerCaseMinor" BIGINT,
ADD COLUMN     "promoDiscountPerCaseMinor" BIGINT,
ADD COLUMN     "qtyDiscountPerCaseMinor" BIGINT,
ADD COLUMN     "rebatePerCaseMinor" BIGINT,
ADD COLUMN     "ripCode" TEXT,
ADD COLUMN     "ripValueMinor" BIGINT,
ADD COLUMN     "sourcePage" INTEGER,
ADD COLUMN     "standardCaseCostMinor" BIGINT,
ADD COLUMN     "temporaryDeal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unitListMinor" BIGINT,
ADD COLUMN     "unitsBroken" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unitsDamaged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unitsMissing" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unitsOrdered" INTEGER,
ADD COLUMN     "vendorItemNumber" TEXT,
ADD COLUMN     "vintage" TEXT,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ProductCostHistory" ADD COLUMN     "componentsJson" JSONB,
ADD COLUMN     "invoiceLineId" UUID,
ADD COLUMN     "listCaseCostMinor" BIGINT,
ADD COLUMN     "netCaseCostMinor" BIGINT,
ADD COLUMN     "purchaseReceiptId" UUID,
ADD COLUMN     "temporaryDeal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VendorClaimLine" ADD COLUMN     "invoiceLineId" UUID;

-- CreateTable
CREATE TABLE "InvoiceDocumentPage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceDocumentId" UUID NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "documentHash" TEXT NOT NULL,
    "documentData" BYTEA NOT NULL,
    "rawText" TEXT,
    "ocrConfidence" DECIMAL(5,4),
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceDocumentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCharge" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceDocumentId" UUID NOT NULL,
    "kind" "InvoiceChargeKind" NOT NULL,
    "label" TEXT NOT NULL,
    "originalLabel" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDocumentPage_organizationId_id_key" ON "InvoiceDocumentPage"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDocumentPage_organizationId_invoiceDocumentId_pageNu_key" ON "InvoiceDocumentPage"("organizationId", "invoiceDocumentId", "pageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDocumentPage_organizationId_documentHash_key" ON "InvoiceDocumentPage"("organizationId", "documentHash");

-- CreateIndex
CREATE INDEX "InvoiceCharge_organizationId_invoiceDocumentId_idx" ON "InvoiceCharge"("organizationId", "invoiceDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCharge_organizationId_id_key" ON "InvoiceCharge"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ProductCostHistory_organizationId_purchaseReceiptId_idx" ON "ProductCostHistory"("organizationId", "purchaseReceiptId");

-- AddForeignKey
ALTER TABLE "VendorClaimLine" ADD CONSTRAINT "VendorClaimLine_organizationId_invoiceLineId_fkey" FOREIGN KEY ("organizationId", "invoiceLineId") REFERENCES "InvoiceLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDocumentPage" ADD CONSTRAINT "InvoiceDocumentPage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDocumentPage" ADD CONSTRAINT "InvoiceDocumentPage_organizationId_invoiceDocumentId_fkey" FOREIGN KEY ("organizationId", "invoiceDocumentId") REFERENCES "InvoiceDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceCharge" ADD CONSTRAINT "InvoiceCharge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceCharge" ADD CONSTRAINT "InvoiceCharge_organizationId_invoiceDocumentId_fkey" FOREIGN KEY ("organizationId", "invoiceDocumentId") REFERENCES "InvoiceDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum (one value per statement)
ALTER TYPE "VendorClaimKind" ADD VALUE 'WRONG_PRODUCT';
ALTER TYPE "VendorClaimKind" ADD VALUE 'INCORRECT_COST';
ALTER TYPE "VendorClaimKind" ADD VALUE 'MISSING_DISCOUNT';
ALTER TYPE "VendorClaimKind" ADD VALUE 'OVERCHARGE';
ALTER TYPE "VendorClaimKind" ADD VALUE 'OTHER';

-- Invariants Prisma cannot express.
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_receiving_quantities_valid" CHECK ("casesBackordered" >= 0 AND "casesRejected" >= 0 AND "casesDamaged" >= 0 AND "looseUnitsShipped" >= 0 AND "looseUnitsReceived" >= 0 AND "unitsDamaged" >= 0 AND "unitsBroken" >= 0 AND "unitsMissing" >= 0 AND "bonusUnits" >= 0);
ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_page_count_valid" CHECK ("pageCount" >= 1);
ALTER TABLE "InvoiceDocumentPage" ADD CONSTRAINT "InvoiceDocumentPage_page_number_valid" CHECK ("pageNumber" >= 2);
