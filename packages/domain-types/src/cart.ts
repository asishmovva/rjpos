export type CartDiscount =
  | { kind: 'FIXED'; amountMinor: bigint }
  | { kind: 'PERCENTAGE'; basisPoints: number };

export type CartLineInput = {
  variantId: string;
  unitPriceMinor: bigint;
  quantity: number;
  taxable: boolean;
  discount?: CartDiscount;
};

export type CalculatedCartLine = {
  variantId: string;
  quantity: number;
  unitPriceMinor: bigint;
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
};

export type CartTotals = {
  lines: CalculatedCartLine[];
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
};

export function addScannedVariant<T extends { variantId: string }>(
  lines: readonly (T & { quantity: number })[],
  item: T,
): Array<T & { quantity: number }> {
  const existing = lines.find((line) => line.variantId === item.variantId);
  if (!existing) return [...lines, { ...item, quantity: 1 }];
  return lines.map((line) =>
    line.variantId === item.variantId
      ? { ...line, quantity: line.quantity + 1 }
      : line,
  );
}

function assertMinorUnits(value: bigint, field: string): void {
  if (value < 0n) throw new Error(`${field}_MUST_BE_NONNEGATIVE`);
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function calculateDiscount(base: bigint, discount?: CartDiscount): bigint {
  if (!discount) return 0n;
  if (discount.kind === 'FIXED') {
    assertMinorUnits(discount.amountMinor, 'DISCOUNT');
    return discount.amountMinor > base ? base : discount.amountMinor;
  }
  if (
    !Number.isInteger(discount.basisPoints) ||
    discount.basisPoints < 0 ||
    discount.basisPoints > 10_000
  ) {
    throw new Error('DISCOUNT_BASIS_POINTS_INVALID');
  }
  return roundRatio(base * BigInt(discount.basisPoints), 10_000n);
}

export function calculateCartTotals(input: {
  lines: CartLineInput[];
  taxRateBasisPoints: number;
  orderDiscount?: CartDiscount;
}): CartTotals {
  if (
    !Number.isInteger(input.taxRateBasisPoints) ||
    input.taxRateBasisPoints < 0 ||
    input.taxRateBasisPoints > 10_000
  ) {
    throw new Error('TAX_RATE_INVALID');
  }
  if (input.lines.length === 0) throw new Error('CART_EMPTY');

  const prepared = input.lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0)
      throw new Error('QUANTITY_INVALID');
    assertMinorUnits(line.unitPriceMinor, 'UNIT_PRICE');
    const subtotalMinor = line.unitPriceMinor * BigInt(line.quantity);
    const lineDiscountMinor = calculateDiscount(subtotalMinor, line.discount);
    return { ...line, subtotalMinor, lineDiscountMinor };
  });
  const subtotalMinor = prepared.reduce(
    (sum, line) => sum + line.subtotalMinor,
    0n,
  );
  const lineDiscountTotal = prepared.reduce(
    (sum, line) => sum + line.lineDiscountMinor,
    0n,
  );
  const afterLineDiscounts = subtotalMinor - lineDiscountTotal;
  const orderDiscountMinor = calculateDiscount(
    afterLineDiscounts,
    input.orderDiscount,
  );

  let allocatedOrderDiscount = 0n;
  const lines = prepared.map((line, index) => {
    const lineNet = line.subtotalMinor - line.lineDiscountMinor;
    const isLast = index === prepared.length - 1;
    const orderShare = isLast
      ? orderDiscountMinor - allocatedOrderDiscount
      : afterLineDiscounts === 0n
        ? 0n
        : (orderDiscountMinor * lineNet) / afterLineDiscounts;
    allocatedOrderDiscount += orderShare;
    const discountMinor = line.lineDiscountMinor + orderShare;
    const taxableMinor = line.taxable ? line.subtotalMinor - discountMinor : 0n;
    const taxMinor = roundRatio(
      taxableMinor * BigInt(input.taxRateBasisPoints),
      10_000n,
    );
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      subtotalMinor: line.subtotalMinor,
      discountMinor,
      taxMinor,
      totalMinor: line.subtotalMinor - discountMinor + taxMinor,
    };
  });
  const discountMinor = lineDiscountTotal + orderDiscountMinor;
  const taxMinor = lines.reduce((sum, line) => sum + line.taxMinor, 0n);
  return {
    lines,
    subtotalMinor,
    discountMinor,
    taxMinor,
    totalMinor: subtotalMinor - discountMinor + taxMinor,
  };
}

export function calculateChangeDue(
  amountDueMinor: bigint,
  tenderedMinor: bigint,
): bigint {
  assertMinorUnits(amountDueMinor, 'AMOUNT_DUE');
  assertMinorUnits(tenderedMinor, 'TENDERED');
  if (tenderedMinor < amountDueMinor) throw new Error('INSUFFICIENT_TENDER');
  return tenderedMinor - amountDueMinor;
}
