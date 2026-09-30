import { describe, expect, it } from 'vitest';
import { CODE128_PATTERNS, CODE128_STOP, CallbackLabelPrinter, code128Svg, code128Widths, encodeZpl, renderLabelHtml, validateLabelDocument, type LabelDocument } from '../src/index.js';

const job = (overrides: Partial<LabelDocument> = {}): LabelDocument => ({ kind: 'SHELF', widthMm: 50, heightMm: 30, items: [{ name: 'Cola <12pk>', barcode: '012345678905', priceMinor: '1299', copies: 2 }], ...overrides });

describe('Code 128 encoding', () => {
  it('has a complete table whose symbols are 11 modules wide and the stop is 13', () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    for (const pattern of CODE128_PATTERNS) expect([...pattern].reduce((sum, digit) => sum + Number(digit), 0)).toBe(11);
    expect([...CODE128_STOP].reduce((sum, digit) => sum + Number(digit), 0)).toBe(13);
    expect(new Set(CODE128_PATTERNS).size).toBe(106);
  });
  it('encodes start B, data, checksum and stop (PJJ123C checksum is 55)', () => {
    const widths = code128Widths('PJJ123C');
    expect(widths.slice(0, 6)).toEqual([2, 1, 1, 2, 1, 4]); // start B
    expect(widths.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]);
    expect(widths.slice(-13, -7).join('')).toBe(CODE128_PATTERNS[55]);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(11 * 9 + 13);
  });
  it('renders script-free SVG and rejects unsupported characters', () => {
    expect(code128Svg('12345')).toMatch(/^<svg[^>]*><rect/);
    expect(() => code128Widths('héllo')).toThrow('LABEL_BARCODE_INVALID');
  });
});

describe('Label jobs', () => {
  it('validates sizes, counts, barcodes, prices, and required fields by label kind', () => {
    expect(validateLabelDocument(job())).toBeTruthy();
    expect(() => validateLabelDocument(job({ widthMm: 5 }))).toThrow('LABEL_SIZE_INVALID');
    expect(() => validateLabelDocument(job({ items: [] }))).toThrow('LABEL_ITEMS_INVALID');
    expect(() => validateLabelDocument(job({ items: [{ name: 'X', priceMinor: '100' }] }))).toThrow('LABEL_BARCODE_REQUIRED');
    expect(() => validateLabelDocument(job({ kind: 'PRICE', items: [{ name: 'X' }] }))).toThrow('LABEL_PRICE_REQUIRED');
    expect(() => validateLabelDocument(job({ items: [{ name: 'X', barcode: '1234', priceMinor: '-5' }] }))).toThrow('LABEL_PRICE_INVALID');
    expect(() => validateLabelDocument(job({ items: [{ name: 'X', barcode: '1234', priceMinor: '5', copies: 100 }] }))).toThrow('LABEL_COPIES_INVALID');
    expect(() => validateLabelDocument(job({ items: Array.from({ length: 6 }, () => ({ name: 'X', barcode: '1234', priceMinor: '5', copies: 99 })) }))).toThrow('LABEL_TOTAL_TOO_LARGE');
  });
  it('escapes names in HTML, repeats copies, and formats prices from minor units', () => {
    const html = renderLabelHtml(job());
    expect(html).toContain('Cola &lt;12pk&gt;'); expect(html).not.toContain('<12pk>');
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html).toContain('$12.99'); expect(html).not.toContain('<script');
  });
  it('encodes ZPL without control characters from product names', () => {
    const zpl = encodeZpl(job({ items: [{ name: 'A^XZ~DG name', barcode: '1234', priceMinor: '5' }] }));
    expect(zpl.match(/\^XA/g)).toHaveLength(1);
    expect(zpl.match(/\^XZ/g)).toHaveLength(1);
    expect(zpl).toContain('$0.05');
  });
  it('reports simulated prints honestly and rejects invalid jobs without printing', async () => {
    let printed = 0;
    const printer = new CallbackLabelPrinter('simulated', async () => { printed += 1; });
    expect(await printer.print(job())).toMatchObject({ ok: true, status: 'simulated', message: expect.stringContaining('nothing was printed') });
    expect(await printer.print(job({ items: [] }))).toMatchObject({ ok: false, code: 'LABEL_ITEMS_INVALID' });
    expect(printed).toBe(1);
  });
});
