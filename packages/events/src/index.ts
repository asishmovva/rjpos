export const eventTypes = [
  'SALE_COMPLETED',
  'SALE_VOIDED',
  'REFUND_COMPLETED',
  'REGISTER_OPENED',
  'REGISTER_CLOSED',
  'PRODUCT_CREATED',
  'INVENTORY_CHANGED',
] as const;
export type EventType = (typeof eventTypes)[number];
