export class PosError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus = 400,
  ) {
    super(code);
    this.name = 'PosError';
  }
}

export function requirePositiveQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new PosError('QUANTITY_INVALID');
  }
}
