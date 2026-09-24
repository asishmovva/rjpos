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
export { closeRegisterSession, openRegisterSession } from './register-sessions.js';
export {
  checkoutCash,
  checkoutTerminal,
  finalizeTerminalAttempt,
  type CheckoutContext,
  type CheckoutLine,
  type CheckoutResult,
} from './checkout.js';
export { PosError } from './pos-errors.js';
export { getReceipt, refundOrder, searchOrders, voidOrder } from './orders.js';
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
