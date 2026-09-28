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
