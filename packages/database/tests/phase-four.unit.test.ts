import { describe, expect, it } from 'vitest';
import { normalizeUpc } from '../src/purchasing.js';

describe('Phase 4 UPC normalization', () => {
  it.each(['12345670', '012345678905', '5901234123457', '10012345678902'])('accepts a %s GTIN', (value) => {
    expect(normalizeUpc(value)).toBe(value);
  });

  it('removes whitespace and separators without dropping leading zeroes', () => {
    expect(normalizeUpc(' 01-2345 678905 ')).toBe('012345678905');
  });

  it.each(['', '123', '1234567890', '123456789012345', '01234ABC8905'])('rejects malformed UPC %s', (value) => {
    expect(() => normalizeUpc(value)).toThrow('MASTER_UPC_INVALID');
  });
});
