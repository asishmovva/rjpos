import type { InvoiceOcrResult } from '@rjpos/database';

export type InvoiceDocumentInput = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

export interface InvoiceOcrProvider {
  readonly name: string;
  extract(document: InvoiceDocumentInput): Promise<InvoiceOcrResult>;
}

function isResult(value: unknown): value is Omit<InvoiceOcrResult, 'provider'> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { lines?: unknown };
  return Array.isArray(candidate.lines) && candidate.lines.every((line) => {
    if (!line || typeof line !== 'object') return false;
    const item = line as Record<string, unknown>;
    return typeof item.description === 'string' && Number.isSafeInteger(item.quantity)
      && typeof item.unitCostMinor === 'string' && typeof item.lineTotalMinor === 'string';
  });
}

export class LocalFixtureInvoiceOcrProvider implements InvoiceOcrProvider {
  readonly name = 'LOCAL_FIXTURE';

  async extract(document: InvoiceDocumentInput): Promise<InvoiceOcrResult> {
    if (document.mimeType !== 'application/json') {
      throw new Error('No production OCR provider is configured. Upload a JSON OCR fixture in development or configure a provider.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(document.content.toString('utf8')); }
    catch { throw new Error('The local OCR fixture is not valid JSON.'); }
    if (!isResult(parsed)) throw new Error('The local OCR fixture does not match the normalized invoice schema.');
    return { ...parsed, provider: this.name, rawReference: { fixture: document.filename } };
  }
}

export class UnavailableInvoiceOcrProvider implements InvoiceOcrProvider {
  readonly name = 'UNAVAILABLE';
  async extract(): Promise<InvoiceOcrResult> {
    throw new Error('Invoice OCR is unavailable until a production provider is configured.');
  }
}
