'use client';
import { useEffect, useState } from 'react';
import { renderLabelHtml, type LabelDocument, type LabelKind } from '@rjpos/hardware-contracts';
import { adminApi, type Product, type Store } from '../admin-client';
import { errorText } from '../phase9-client';
import '../admin.css';
import '../costing.css';

type Row = { variantId: string; name: string; barcode: string; sku: string; priceMinor: string; copies: string };
const KINDS: Array<[LabelKind, string]> = [['SHELF', 'Shelf tag (name, price, barcode)'], ['PRICE', 'Price only'], ['BARCODE', 'Barcode only']];
const SIZES: Array<[string, string, number, number]> = [['50x30', '50 × 30 mm', 50, 30], ['60x40', '60 × 40 mm', 60, 40], ['40x25', '40 × 25 mm', 40, 25]];
const centsOf = (dollars: string) => String(Math.round(Number(dollars) * 100));

/** Barcode, shelf, and price labels. Prints through the register's label printer, or the browser print dialog as a fallback. */
export default function LabelsPage(): React.ReactNode {
  const [stores, setStores] = useState<Store[]>([]); const [storeId, setStoreId] = useState(''); const [search, setSearch] = useState(''); const [results, setResults] = useState<Product[]>([]);
  const [rows, setRows] = useState<Row[]>([]); const [kind, setKind] = useState<LabelKind>('SHELF'); const [size, setSize] = useState('50x30');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void adminApi.stores().then((list) => { setStores(list); setStoreId(list[0]?.id ?? ''); }).catch((cause) => setError(errorText(cause))); }, []);
  useEffect(() => { if (search.trim().length < 2) { setResults([]); return undefined; } const timer = setTimeout(() => void adminApi.products(search, 1, 8).then((result) => setResults(result.items)).catch(() => setResults([])), 250); return () => clearTimeout(timer); }, [search]);

  async function add(product: Product, variant: Product['variants'][number]): Promise<void> {
    if (rows.some((row) => row.variantId === variant.id)) return;
    setError('');
    try {
      const now = Date.now();
      const history = await adminApi.priceHistory(variant.id, storeId).catch(() => []);
      const price = history.filter((entry) => new Date(entry.effectiveFrom).getTime() <= now && (!entry.effectiveTo || new Date(entry.effectiveTo).getTime() > now)).sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0]?.amountMinor ?? null;
      setRows((current) => [...current, { variantId: variant.id, name: `${product.name} ${variant.name === 'Each' ? '' : variant.name}`.trim(), barcode: variant.barcodes[0]?.barcodeValue ?? variant.sku, sku: variant.sku, priceMinor: price ?? '', copies: '1' }]);
      setSearch('');
    } catch (cause) { setError(errorText(cause)); }
  }
  const [, , widthMm, heightMm] = SIZES.find(([id]) => id === size)!;
  const document_ = (): LabelDocument => ({ kind, widthMm, heightMm, items: rows.map((row) => ({ name: row.name, ...(kind !== 'PRICE' ? { barcode: row.barcode } : {}), sku: row.sku, ...(kind !== 'BARCODE' ? { priceMinor: row.priceMinor } : {}), copies: Number(row.copies) })) });
  const ready = rows.length > 0 && rows.every((row) => /^[1-9]\d?$/.test(row.copies) && (kind === 'BARCODE' || /^\d+$/.test(row.priceMinor)));

  async function print(): Promise<void> {
    setBusy(true); setError(''); setMessage('');
    try {
      const job = document_();
      if (window.rjpos?.printLabels) {
        const result = await window.rjpos.printLabels(job);
        if (!result.ok) throw new Error(result.code ?? 'LABEL_PRINT_FAILED');
        setMessage(result.message);
      } else {
        const frame = window.document.createElement('iframe'); frame.style.cssText = 'position:fixed;width:0;height:0;border:0'; frame.srcdoc = renderLabelHtml(job); window.document.body.append(frame);
        await new Promise<void>((resolve) => { frame.onload = () => resolve(); });
        frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 60_000); setMessage('Sent to the browser print dialog.');
      }
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Catalog</span><h1>Labels</h1></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <section className="wizard-section" aria-label="Label setup"><h2>Setup</h2>
      <div className="inline-form"><label>Type<select aria-label="Label type" value={kind} onChange={(event) => setKind(event.target.value as LabelKind)}>{KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>Size<select aria-label="Label size" value={size} onChange={(event) => setSize(event.target.value)}>{SIZES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>Store prices<select aria-label="Store" value={storeId} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label></div></section>
    <section className="wizard-section" aria-label="Labels to print"><h2>Items</h2>
      <div className="inline-form"><label>Add item<input aria-label="Search items" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, SKU, or UPC" /></label></div>
      {results.length > 0 && <div className="preset-row">{results.flatMap((product) => product.variants.filter((variant) => variant.active).map((variant) => <button key={variant.id} onClick={() => void add(product, variant)}>{product.name} · {variant.name}</button>))}</div>}
      {rows.length > 0 && <table className="line-table"><thead><tr><th>Item</th><th>Barcode</th>{kind !== 'BARCODE' && <th>Price ($)</th>}<th>Copies</th><th /></tr></thead><tbody>{rows.map((row, index) => <tr key={row.variantId}><td>{row.name}</td><td>{row.barcode}</td>
        {kind !== 'BARCODE' && <td><input aria-label={`Price ${row.name}`} inputMode="decimal" value={row.priceMinor === '' ? '' : (Number(row.priceMinor) / 100).toFixed(2)} onChange={(event) => { const text = event.target.value.replace(/[^\d.]/g, ''); setRows((current) => current.map((item, at) => at === index ? { ...item, priceMinor: text === '' ? '' : centsOf(text) } : item)); }} /></td>}
        <td><input aria-label={`Copies ${row.name}`} inputMode="numeric" maxLength={2} value={row.copies} onChange={(event) => setRows((current) => current.map((item, at) => at === index ? { ...item, copies: event.target.value.replace(/\D/g, '') } : item))} /></td>
        <td><button onClick={() => setRows((current) => current.filter((_, at) => at !== index))}>Remove</button></td></tr>)}</tbody></table>}
      <div className="wizard-actions"><span className="hint">Labels print on the register&apos;s label printer when this page is open in the register app; otherwise your browser&apos;s print dialog opens.</span>
        <button className="big" disabled={busy || !ready} onClick={() => void print()}>Print {rows.reduce((sum, row) => sum + (Number(row.copies) || 0), 0)} label(s)</button></div></section>
  </main>;
}
