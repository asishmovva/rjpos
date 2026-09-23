import { z } from 'zod';

export const moneySchema = z.object({
  amountMinor: z.string().regex(/^(0|[1-9][0-9]*)$/),
  currency: z.literal('USD'),
});

export const requestIdSchema = z.string().min(1).max(128);
export type MoneyContract = z.infer<typeof moneySchema>;
