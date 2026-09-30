import type { HardwareResult, HardwareState } from './index.js';

export type LabelKind = 'BARCODE' | 'SHELF' | 'PRICE';
export type LabelItem = { name: string; barcode?: string; sku?: string; priceMinor?: string; currency?: string; copies?: number };
/** Provider-neutral label job. The app sends structured data; adapters decide how a given printer renders it. */
export type LabelDocument = { kind: LabelKind; widthMm: number; heightMm: number; items: LabelItem[] };
export interface LabelPrinter { status(): Promise<HardwareState>; print(document: LabelDocument): Promise<HardwareResult>; }

export const LABEL_LIMITS = { maxItems: 200, maxCopies: 99, maxTotalLabels: 500, minMm: 20, maxMm: 120 } as const;

const fail = (code: string): never => { throw new Error(code); };
/** Throws a coded Error when a job is malformed. Returns the document so calls can be chained. */
export function validateLabelDocument(document: LabelDocument): LabelDocument {
  if (!document || !['BARCODE', 'SHELF', 'PRICE'].includes(document.kind)) fail('LABEL_KIND_INVALID');
  for (const size of [document.widthMm, document.heightMm]) if (!Number.isFinite(size) || size < LABEL_LIMITS.minMm || size > LABEL_LIMITS.maxMm) fail('LABEL_SIZE_INVALID');
  if (!Array.isArray(document.items) || document.items.length === 0 || document.items.length > LABEL_LIMITS.maxItems) fail('LABEL_ITEMS_INVALID');
  let total = 0;
  for (const item of document.items) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) fail('LABEL_ITEM_INVALID');
    if (item.barcode !== undefined && !/^[\x20-\x7e]{1,48}$/.test(item.barcode)) fail('LABEL_BARCODE_INVALID');
    if (item.priceMinor !== undefined && !/^(0|[1-9]\d{0,11})$/.test(item.priceMinor)) fail('LABEL_PRICE_INVALID');
    const copies = item.copies ?? 1;
    if (!Number.isInteger(copies) || copies < 1 || copies > LABEL_LIMITS.maxCopies) fail('LABEL_COPIES_INVALID');
    if (document.kind !== 'PRICE' && !item.barcode) fail('LABEL_BARCODE_REQUIRED');
    if (document.kind !== 'BARCODE' && item.priceMinor === undefined) fail('LABEL_PRICE_REQUIRED');
    total += copies;
  }
  if (total > LABEL_LIMITS.maxTotalLabels) fail('LABEL_TOTAL_TOO_LARGE');
  return document;
}

// Code 128 (subset B): each symbol is bar/space widths summing to 11 modules; the stop symbol is 13.
const PATTERNS = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232'] as const;
const STOP = '2331112'; const START_B = 104;
export const CODE128_PATTERNS = PATTERNS; export const CODE128_STOP = STOP;

/** Module widths (alternating bar, space, ...) for a printable-ASCII value, including quiet-zone-free start, checksum, and stop. */
export function code128Widths(value: string): number[] {
  if (!/^[\x20-\x7e]{1,48}$/.test(value)) fail('LABEL_BARCODE_INVALID');
  const codes = [START_B, ...[...value].map((character) => character.charCodeAt(0) - 32)];
  const checksum = codes.reduce((sum, code, index) => sum + (index === 0 ? code : code * index), 0) % 103;
  return [...codes, checksum].flatMap((code) => [...PATTERNS[code]!].map(Number)).concat([...STOP].map(Number));
}

const escape = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
/** Inline SVG (no scripts, no external resources) for the barcode; 10-module quiet zones on both sides. */
export function code128Svg(value: string, heightPx = 40): string {
  const widths = code128Widths(value); const quiet = 10;
  let x = quiet; let bars = '';
  widths.forEach((width, index) => { if (index % 2 === 0) bars += `<rect x="${x}" y="0" width="${width}" height="${heightPx}"/>`; x += width; });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + quiet} ${heightPx}" preserveAspectRatio="none" shape-rendering="crispEdges" aria-label="${escape(value)}">${bars}</svg>`;
}

const money = (minor: string, currency = 'USD'): string => {
  const value = BigInt(minor); const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
};
const expand = (document: LabelDocument): LabelItem[] => document.items.flatMap((item) => Array.from({ length: item.copies ?? 1 }, () => item));

/** Self-contained HTML for OS/driver printing: one page per label at the configured size. */
export function renderLabelHtml(document: LabelDocument): string {
  validateLabelDocument(document);
  const pages = expand(document).map((item) => {
    const price = item.priceMinor === undefined ? '' : `<div class="price">${escape(money(item.priceMinor, item.currency))}</div>`;
    const barcode = item.barcode ? `<div class="bar">${code128Svg(item.barcode)}</div><div class="code">${escape(item.barcode)}</div>` : '';
    return `<section class="label ${document.kind.toLowerCase()}"><div class="name">${escape(item.name)}</div>${price}${barcode}${item.sku ? `<div class="sku">${escape(item.sku)}</div>` : ''}</section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${document.widthMm}mm ${document.heightMm}mm;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;color:#000}`
    + `.label{width:${document.widthMm}mm;height:${document.heightMm}mm;padding:1.5mm 2mm;page-break-after:always;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between}`
    + `.name{font-size:9pt;font-weight:700;line-height:1.1;max-height:2.3em;overflow:hidden}.price{font-size:20pt;font-weight:800}.shelf .price,.price.price{text-align:right}`
    + `.bar{height:38%}.bar svg{width:100%;height:100%;fill:#000}.code{font-size:7pt;text-align:center;letter-spacing:.08em}.sku{font-size:7pt}</style></head><body>${pages}</body></html>`;
}

const zplText = (value: string): string => value.replace(/[\^~\\]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
/** ZPL II for Zebra-compatible printers, for raw/network adapters. 203 dpi (8 dots per mm). */
export function encodeZpl(document: LabelDocument): string {
  validateLabelDocument(document);
  const dots = (mm: number) => Math.round(mm * 8);
  return expand(document).map((item) => [
    '^XA', `^PW${dots(document.widthMm)}`, `^LL${dots(document.heightMm)}`, '^CI28',
    `^FO16,12^A0N,28,28^FB${dots(document.widthMm) - 32},2,0,L^FD${zplText(item.name)}^FS`,
    ...(item.priceMinor === undefined ? [] : [`^FO16,${dots(document.heightMm * 0.3)}^A0N,56,56^FD${zplText(money(item.priceMinor, item.currency))}^FS`]),
    ...(item.barcode ? [`^FO16,${dots(document.heightMm * 0.58)}^BY2,3,${dots(document.heightMm * 0.22)}^BCN,,Y,N,N^FD${zplText(item.barcode)}^FS`] : []),
    '^XZ',
  ].join('\n')).join('\n');
}

export class UnavailableLabelPrinter implements LabelPrinter {
  async status(): Promise<HardwareState> { return 'unavailable'; }
  async print(): Promise<HardwareResult> { return { ok: false, status: 'unavailable', code: 'LABEL_PRINTER_UNAVAILABLE', message: 'Label printer is not configured.', retryable: false }; }
}
/** Validates the job, then hands it to the supplied operation. Simulated mode validates and reports honestly that nothing was printed. */
export class CallbackLabelPrinter implements LabelPrinter {
  constructor(private readonly mode: HardwareState, private readonly operation: (document: LabelDocument) => Promise<void>) {}
  async status(): Promise<HardwareState> { return this.mode; }
  async print(document: LabelDocument): Promise<HardwareResult> {
    try { validateLabelDocument(document); } catch (error) { return { ok: false, status: 'error', code: error instanceof Error ? error.message : 'LABEL_INVALID', message: 'The label job is not valid.', retryable: false }; }
    try { await this.operation(document); return { ok: true, status: this.mode, message: this.mode === 'simulated' ? 'Label print was simulated; nothing was printed.' : 'Labels sent to printer.' }; }
    catch (error) { return { ok: false, status: 'error', code: 'LABEL_PRINT_FAILED', message: error instanceof Error ? error.message : 'Label printing failed.', retryable: true }; }
  }
}
