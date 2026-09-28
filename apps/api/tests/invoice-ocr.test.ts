import { describe, expect, it } from 'vitest';
import { LocalFixtureInvoiceOcrProvider, UnavailableInvoiceOcrProvider } from '../src/invoice-ocr.js';

describe('provider-neutral invoice OCR boundary', () => {
  it('normalizes deterministic development fixtures without pretending to OCR production documents', async () => {
    const provider = new LocalFixtureInvoiceOcrProvider();
    const result = await provider.extract({ filename: 'invoice.json', mimeType: 'application/json', content: Buffer.from(JSON.stringify({
      vendorName: 'Fixture Supply', invoiceNumber: 'F-100', totalMinor: '2500',
      lines: [{ description: 'Fixture item', upc: '012345678905', quantity: 2, unitCostMinor: '1000', lineTotalMinor: '2000' }],
    })) });
    expect(result).toMatchObject({ provider: 'LOCAL_FIXTURE', invoiceNumber: 'F-100', lines: [{ quantity: 2 }] });
    await expect(provider.extract({ filename: 'invoice.pdf', mimeType: 'application/pdf', content: Buffer.from('pdf') })).rejects.toThrow('No production OCR provider');
  });

  it('fails explicitly when production OCR is not configured', async () => {
    await expect(new UnavailableInvoiceOcrProvider().extract()).rejects.toThrow('unavailable');
  });
});
