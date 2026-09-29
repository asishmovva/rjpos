export { PrismaClient } from '@prisma/client';
export {
  convertReservation,
  releaseReservation,
  reserveInventory,
} from './inventory-reservations.js';
export { recordAudit } from './audit.js';
export {
  lookupCatalog,
  type CatalogLookupInput,
  type CatalogLookupResult,
} from './catalog.js';
export {
  adjustInventory,
  getInventorySnapshot,
  searchInventory,
  postOpeningBalance,
} from './inventory.js';
export {
  closeRegisterSession,
  getActiveRegisterSession,
  openRegisterSession,
} from './register-sessions.js';
export {
  checkoutCash,
  checkoutMixed,
  checkoutTerminal,
  finalizeTerminalAttempt,
  quoteCheckout,
  type CheckoutContext,
  type CheckoutLine,
  type CheckoutResult,
  type MixedTender,
} from './checkout.js';
export { PosError } from './pos-errors.js';
export { getReceipt, refundOrder, searchOrders, voidOrder } from './orders.js';
export {
  applyInvoiceOcrResult,
  confirmInvoiceDocument,
  createInvoiceDocument,
  getInvoiceDocument,
  getInvoiceReview,
  getInvoiceDocumentInput,
  listInvoiceDocuments,
  markInvoiceOcrFailed,
  markInvoiceOcrProcessing,
  rejectInvoiceDocument,
  updateInvoiceDocument,
  updateInvoiceLine,
  type InvoiceOcrLine,
  type InvoiceOcrResult,
} from './invoices.js';
export {
  createCategory,
  createEmployee,
  createProduct,
  createRegister,
  createStore,
  createVariant,
  getDashboard,
  getOrderAdmin,
  getProduct,
  listAuditRecords,
  listCategories,
  listEmployees,
  listInventoryAdmin,
  listInventoryMovements,
  listOrdersAdmin,
  listPriceHistory,
  listProducts,
  listRefunds,
  listRegisters,
  listStores,
  schedulePrice,
  updateCategory,
  updateEmployee,
  setEmployeePin,
  updateProduct,
  updateRegister,
  updateStore,
  updateVariant,
  type AdminActor,
} from './back-office.js';
export {
  adjustLoyalty,
  clockIn,
  clockOut,
  configureLoyalty,
  correctShift,
  createCustomer,
  disableGiftCard,
  getCurrentShift,
  getCustomerDetail,
  getLoyaltyProgram,
  issueGiftCard,
  listCustomers,
  listShifts,
  lookupGiftCard,
  reloadGiftCard,
  updateCustomer,
  type WorkforceActor,
} from './phase-three.js';
export {
  addMasterProductToStore,
  createPurchaseOrder,
  createVendor,
  getPurchaseOrder,
  importMasterCatalogCsv,
  listPurchaseOrders,
  listReceivingHistory,
  listVendorMappings,
  listVendors,
  lookupMasterProduct,
  normalizeUpc,
  receivePurchaseOrder,
  saveVendorMapping,
  searchMasterProducts,
  transitionPurchaseOrder,
  updateDraftPurchaseOrder,
  updateVendor,
} from './purchasing.js';
export {
  cancelTransfer,
  createPromotion,
  createStockCount,
  createTransfer,
  finalizeStockCount,
  listPromotions,
  listStockCounts,
  listTransfers,
  receiveTransfer,
  replenishmentSuggestions,
  reviewStockCount,
  shipTransfer,
  submitTransfer,
  updateInventoryPolicy,
  updatePromotion,
  type PromotionInput,
} from './phase-five.js';
export {
  cancelHeldTransaction,
  holdTransaction,
  listHeldTransactions,
  listQuickKeys,
  listQuickKeysAdmin,
  resumeHeldTransaction,
  saveQuickKey,
  reorderQuickKeys,
  type RegisterActor,
} from './phase-seven.js';
export {
  REPORT_KINDS,
  accountingExport,
  getReport,
  normalizeReportFilters,
  reportCsv,
  type ReportFilters,
  type ReportKind,
} from './reporting.js';
export {
  findProductForOrganization,
  requireRegisterContext,
  updateProductForOrganization,
} from './tenant-repository.js';

export function toMoneyApi(
  amountMinor: bigint,
  currency: string,
): { amountMinor: string; currency: string } {
  return { amountMinor: amountMinor.toString(), currency };
}

export function parseMoneyApi(amountMinor: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(amountMinor))
    throw new Error('Invalid monetary minor unit');
  return BigInt(amountMinor);
}
export { seedDemoStoreCatalog, type DemoStoreSeedSummary } from './demo-store-catalog.js';
export { hashPin, verifyPin } from './pin.js';
export { getShiftReport, type ShiftReport } from './shift-report.js';
export { assignTaxProfile, createTaxProfile, deleteTaxProfile, ensureSystemTaxProfiles, listTaxProfiles, updateTaxProfile } from './tax-profiles.js';
export { createPriceBook, listPriceBooks, listSpecialPrices, saveSpecialPrice, updatePriceBook } from './price-books.js';
export { activeVendorDeals, createVendorDeal, listVendorDeals, updateVendorDeal } from './vendor-deals.js';
export { createPurchasedProduct, getProductDetail, lookupUpcForCreation, type PurchasedProductInput, type SellingUnitInput } from './product-costing.js';
export { recordCostHistory } from './cost-history.js';
export { loadDefaultTaxProfile, loadSpecialPrices, resolveLineTax } from './sale-pricing.js';
