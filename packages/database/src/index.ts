export { PrismaClient } from '@prisma/client';
export {
  convertReservation,
  releaseReservation,
  reserveInventory,
} from './inventory-reservations.js';
export { recordAudit } from './audit.js';
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
