'use client';

import { useEffect, useMemo, useState } from 'react';
import { adminApi, money, type Category, type InvoiceDocument, type InvoiceLine, type InventoryRow, type Store, type Vendor } from '../admin-client';
import { ConfirmPanel, HeaderForm, ReceivingTable, type HeaderDoc } from './receiving-flow';
import { dollarsToMinor, receivingApi, receivingError, type FullReview, type ReceivingLine } from './receiving-client';
import '../admin.css';
import '../costing.css';
import './receiving.css';

type NewProductDraft = { categoryId: string; productName: string; variantName: string; sku: string; barcode: string; priceMinor: string };
const emptyDraft: NewProductDraft = { categoryId: '', productName: '', variantName: 'Each', sku: '', barcode: '', priceMinor: '' };

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the invoice file.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export default function InvoicesPage(): React.ReactNode {
  const [invoices, setInvoices] = useState<Array<{ id: string; originalFilename: string; uploadedAt: string; ocrStatus: string; reviewStatus: string; invoiceNumber: string | null; totalMinor: string | null; possibleDuplicate: boolean; vendor: { name: string } | null }>>([]);
  const [document, setDocument] = useState<InvoiceDocument>();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [file, setFile] = useState<File>();
  const [vendorId, setVendorId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [matches, setMatches] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, NewProductDraft>>({});
  const [review, setReview] = useState<FullReview | null>(null);
  const [step, setStep] = useState<'header' | 'match' | 'costs' | 'confirm'>('header');
  const [newLine, setNewLine] = useState({ kind: 'PRODUCT', description: '', vendorItem: '', upc: '', units: '12', cases: '1', caseCost: '', amount: '' });
  const refreshReview = async (id: string) => { try { setReview(await receivingApi.review(id)); } catch { setReview(null); } };
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function load(): Promise<void> {
    const [invoiceRows, vendorRows, storeRows, categoryRows, inventoryRows] = await Promise.all([
      adminApi.invoices(), adminApi.vendors('', true), adminApi.stores(), adminApi.categories(), adminApi.inventory(),
    ]);
    setInvoices(invoiceRows); setVendors(vendorRows.items); setStores(storeRows); setCategories(categoryRows.items); setInventory(inventoryRows.items);
    setStoreId((current) => current || storeRows[0]?.id || '');
  }
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load invoices.')); }, []);
  async function run(operation: () => Promise<InvoiceDocument>, success: string): Promise<void> {
    setBusy(true); setError(''); setMessage('');
    try { const result = await operation(); setDocument(result); setMessage(success); await load(); if (result.reviewStatus === 'DRAFT') await refreshReview(result.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Invoice operation failed.'); }
    finally { setBusy(false); }
  }
  async function upload(): Promise<void> {
    if (!file || !storeId) { setError('Choose a store and invoice file.'); return; }
    await run(async () => adminApi.uploadInvoice({ originalFilename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: await fileBase64(file), storeId, ...(vendorId ? { vendorId } : {}) }), 'Invoice uploaded. Review every line before confirmation.');
  }
  async function open(id: string): Promise<void> {
    setBusy(true); setError('');
    try {
      const result = await adminApi.invoice(id); setDocument(result); setVendorId(result.vendor?.id ?? ''); setStoreId(result.store.id); await refreshReview(id);
      setDrafts(Object.fromEntries(result.lines.map((line) => [line.id, { categoryId: categories[0]?.id ?? '', productName: line.masterProduct?.name ?? line.description,
        variantName: line.masterProduct?.sizeLabel ?? 'Each', sku: `INV-${line.upc || line.lineNumber}`, barcode: line.upc ?? '', priceMinor: '' }])));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open invoice.'); }
    finally { setBusy(false); }
  }
  async function updateLine(line: InvoiceLine, body: Record<string, unknown>, success = 'Invoice line updated.'): Promise<void> {
    if (!document) return;
    await run(() => adminApi.updateInvoiceLine(document.id, line.id, body), success);
  }
  async function saveHeader(body: Record<string, unknown>): Promise<void> {
    if (!document) return;
    await run(async () => { await receivingApi.updateHeader(document.id, body); return adminApi.invoice(document.id); }, 'Saved.');
  }
  async function saveLine(lineId: string, body: Record<string, unknown>): Promise<void> {
    if (!document) return;
    await run(async () => { await receivingApi.updateLine(document.id, lineId, body); return adminApi.invoice(document.id); }, '');
  }
  async function addManualLine(): Promise<void> {
    if (!document) return;
    const product = newLine.kind === 'PRODUCT';
    const cost = dollarsToMinor(product ? newLine.caseCost : newLine.amount);
    if (cost === null || cost === undefined || !newLine.description.trim()) { setError('Enter a description and an amount like 12.50.'); return; }
    const body = product
      ? { description: newLine.description.trim(), caseQuantity: Number(newLine.units) || 1, casesShipped: Number(newLine.cases) || 1, caseCostMinor: cost, ...(newLine.vendorItem.trim() ? { vendorItemNumber: newLine.vendorItem.trim() } : {}), ...(newLine.upc.trim() ? { upc: newLine.upc.trim() } : {}) }
      : { lineKind: newLine.kind, description: newLine.description.trim(), lineTotalMinor: cost };
    await run(async () => { await receivingApi.addLine(document.id, body); return adminApi.invoice(document.id); }, 'Line added.');
    setNewLine({ ...newLine, description: '', vendorItem: '', upc: '', caseCost: '', amount: '' });
  }
  async function createManual(): Promise<void> {
    if (!storeId) { setError('Choose a store first.'); return; }
    setBusy(true); setError('');
    try { const created = await receivingApi.createManual({ storeId, ...(vendorId ? { vendorId } : {}) }); await load(); await open(created.id); setStep('header'); setMessage('Manual invoice started. Enter the header, then the lines.'); }
    catch (cause) { setError(receivingError(cause)); } finally { setBusy(false); }
  }
  async function addPageFile(file: File | undefined): Promise<void> {
    if (!file || !document) return;
    setBusy(true); setError('');
    try { await receivingApi.addPage(document.id, await receivingApi.pageFile(file)); await open(document.id); setMessage('Page added to this invoice. Check the lines it contributed.'); }
    catch (cause) { setError(receivingError(cause)); } finally { setBusy(false); }
  }
  const extractedLinesTotal = useMemo(() => document?.lines.filter((line) => !line.ignored).reduce((sum, line) => sum + BigInt(line.lineTotalMinor), 0n) ?? 0n, [document]);
  const unresolved = document?.lines.some((line) => !line.ignored && line.matchStatus !== 'MATCHED' && line.matchStatus !== 'NEW_PRODUCT') ?? true;

  return <main className="admin-main invoice-page">
    <header className="admin-heading"><div><a href="/admin">← Back Office</a><span className="eyebrow">Purchasing</span><h1>Invoice receiving</h1></div></header>
    <p className="hint">OCR creates a draft only. Products and inventory are changed only after an owner or manager reviews and confirms the invoice.</p>
    {error && <p className="admin-alert error">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <section className="admin-form wide" aria-label="Upload invoice">
      <label>Store<select value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="">Select store</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      <label>Vendor (optional)<select value={vendorId} onChange={(event) => setVendorId(event.target.value)}><option value="">Match during review</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
      <label className="grow">Invoice image, PDF, or development JSON fixture<input aria-label="Invoice file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf,application/json,.json" onChange={(event) => setFile(event.target.files?.[0])} /></label>
      <button className="primary" disabled={busy || !file || !storeId} onClick={() => void upload()}>Upload and extract</button>
      <button disabled={busy || !storeId} onClick={() => void createManual()}>Enter manually (no OCR)</button>
    </section>
    <div className="admin-table-wrap"><table><thead><tr><th>Document</th><th>Vendor / number</th><th>OCR</th><th>Review</th><th>Total</th><th /></tr></thead><tbody>
      {invoices.map((invoice) => <tr key={invoice.id}><td>{invoice.originalFilename}<small>{new Date(invoice.uploadedAt).toLocaleString()}</small></td><td>{invoice.vendor?.name ?? 'Unmatched'}<small>{invoice.invoiceNumber ?? 'No invoice number'}</small></td><td><span className={`pill ${invoice.ocrStatus === 'FAILED' ? 'warn' : ''}`}>{invoice.ocrStatus}</span></td><td><span className={`pill ${invoice.reviewStatus === 'DRAFT' ? 'warn' : ''}`}>{invoice.reviewStatus}</span>{invoice.possibleDuplicate && <small>Possible duplicate</small>}</td><td>{invoice.totalMinor ? money(invoice.totalMinor) : '—'}</td><td><button onClick={() => void open(invoice.id)}>Review</button></td></tr>)}
    </tbody></table></div>
    {document && <section className="order-detail invoice-review">
      <header><div><span className="eyebrow">{document.ocrProvider ?? 'OCR pending'}</span><h2>{document.originalFilename}</h2></div><button onClick={() => setDocument(undefined)}>Close review</button></header>
      {document.ocrError && <p className="admin-alert error">{document.ocrError}</p>}
      <div className="invoice-summary">
        <label>Vendor<select disabled={document.reviewStatus !== 'DRAFT'} value={document.vendor?.id ?? vendorId} onChange={(event) => { setVendorId(event.target.value); void run(() => adminApi.updateInvoice(document.id, { vendorId: event.target.value || null }), 'Vendor updated.'); }}><option value="">Select vendor</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
        <span>Invoice <strong>{document.invoiceNumber ?? 'Not detected'}</strong></span><span>Extracted lines <strong>{money(extractedLinesTotal)}</strong></span><span>Invoice total <strong>{document.totalMinor ? money(document.totalMinor) : 'Not detected'}</strong></span>
      </div>
      <ol className="steps" aria-label="Receiving steps">{([['header', '1. Header'], ['match', '2. Match products'], ['costs', '3. Costs & receiving'], ['confirm', '4. Reconcile & confirm']] as const).map(([id, label]) => <li key={id} className={step === id ? 'on' : ''}><button className="text" onClick={() => setStep(id)} aria-current={step === id ? 'step' : undefined}>{label}</button></li>)}</ol>
      {review && review.receiving.blockers.length > 0 && step !== 'confirm' && <p className="discrepancy error" role="status">⛔ {review.receiving.blockers[0]!.message} <button className="text" onClick={() => setStep('confirm')}>See all</button></p>}
      {step === 'header' && <HeaderForm doc={document as unknown as HeaderDoc} vendors={vendors} disabled={busy || document.reviewStatus !== 'DRAFT'} onSave={(body) => void saveHeader(body)} />}
      {step === 'match' && <div className="admin-table-wrap"><table><thead><tr><th>Status</th><th>Extracted item</th><th>Qty / pack</th><th>Cost</th><th>Product decision</th><th /></tr></thead><tbody>
        {document.lines.map((line) => {
          const draft = drafts[line.id] ?? { ...emptyDraft, categoryId: categories[0]?.id ?? '', productName: line.description, sku: `INV-${line.lineNumber}`, barcode: line.upc ?? '' };
          return <tr key={line.id} className={line.ignored ? 'ignored' : ''}><td><span className={`pill ${line.matchStatus !== 'MATCHED' ? 'warn' : ''}`}>{line.ignored ? 'IGNORED' : line.matchStatus.replace('_', ' ')}</span><small>{line.confidence ? `${Math.round(Number(line.confidence) * 100)}% confidence` : ''}</small></td>
            <td><strong>{line.description}</strong><small>{line.upc ? `UPC ${line.upc}` : 'No UPC'}{line.vendorSku ? ` · Vendor SKU ${line.vendorSku}` : ''}</small></td>
            <td><input aria-label={`Quantity line ${line.lineNumber}`} type="number" min="1" defaultValue={line.quantity} onBlur={(event) => { const value = Number(event.target.value); if (value !== line.quantity) void updateLine(line, { quantity: value }); }} /> × <input aria-label={`Case quantity line ${line.lineNumber}`} type="number" min="1" defaultValue={line.caseQuantity} onBlur={(event) => { const value = Number(event.target.value); if (value !== line.caseQuantity) void updateLine(line, { caseQuantity: value }); }} /></td>
            <td><input aria-label={`Unit cost line ${line.lineNumber}`} inputMode="numeric" defaultValue={line.unitCostMinor} onBlur={(event) => { if (event.target.value !== line.unitCostMinor) void updateLine(line, { unitCostMinor: event.target.value }); }} /><small>{money(line.lineTotalMinor)} line total</small></td>
            <td>{line.variant ? <strong>{line.variant.product.name} · {line.variant.name}</strong> : <>
              <select aria-label={`Existing product line ${line.lineNumber}`} value={matches[line.id] ?? ''} onChange={(event) => setMatches((current) => ({ ...current, [line.id]: event.target.value }))}><option value="">Link existing product…</option>{inventory.map((row) => <option key={row.variantId} value={row.variantId}>{row.variant.product.name} · {row.variant.name} · {row.variant.sku}</option>)}</select>
              <button disabled={!matches[line.id]} onClick={() => void updateLine(line, { variantId: matches[line.id] }, 'Existing product linked.')}>Link</button>
              <details><summary>{line.masterProduct ? 'Review “Add to Store”' : 'Review new product'}</summary>
                <div className="invoice-product-draft">
                  <label>Category<select value={draft.categoryId} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...draft, categoryId: event.target.value } }))}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
                  <label>Name<input value={draft.productName} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...draft, productName: event.target.value } }))} /></label>
                  <label>Variant<input value={draft.variantName} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...draft, variantName: event.target.value } }))} /></label>
                  <label>SKU<input value={draft.sku} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...draft, sku: event.target.value } }))} /></label>
                  <label>Sale price cents<input value={draft.priceMinor} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...draft, priceMinor: event.target.value.replace(/\D/g, '') } }))} /></label>
                  <button disabled={!draft.categoryId || !draft.productName || !draft.sku || !draft.priceMinor} onClick={() => void updateLine(line, { newProduct: draft }, 'Product creation staged for confirmation.')}>Stage product</button>
                </div>
              </details>
            </>}</td><td><button onClick={() => void updateLine(line, { ignored: !line.ignored }, line.ignored ? 'Line restored.' : 'Line ignored.')}>{line.ignored ? 'Restore' : 'Ignore'}</button></td></tr>;
        })}
      </tbody></table></div>}
      {step === 'costs' && review && <>
        <ReceivingTable lines={document.lines as unknown as ReceivingLine[]} review={review.receiving} disabled={busy || document.reviewStatus !== 'DRAFT'} onSave={saveLine}
          onRemove={(lineId) => void run(async () => { await receivingApi.removeLine(document.id, lineId); return adminApi.invoice(document.id); }, 'Line removed.')}
          onClaim={(line, claim) => void run(async () => { await receivingApi.claimLine(document.id, line.id, claim); return adminApi.invoice(document.id); }, 'Draft vendor claim created. Find it under Vendor claims.')} />
        {document.reviewStatus === 'DRAFT' && <section className="detail-card" aria-label="Add line"><h3>Add a line by hand</h3>
          <div className="inline-form"><label>Type<select value={newLine.kind} onChange={(event) => setNewLine({ ...newLine, kind: event.target.value })}><option value="PRODUCT">Product</option>{['DELIVERY', 'FREIGHT', 'SERVICE', 'FEE', 'DEPOSIT', 'CREDIT', 'REBATE', 'OTHER'].map((kind) => <option key={kind} value={kind}>{kind.charAt(0) + kind.slice(1).toLowerCase()} (no stock)</option>)}</select></label>
            <label>Description<input aria-label="New line description" value={newLine.description} onChange={(event) => setNewLine({ ...newLine, description: event.target.value })} /></label>
            {newLine.kind === 'PRODUCT' ? <><label>Vendor item #<input value={newLine.vendorItem} onChange={(event) => setNewLine({ ...newLine, vendorItem: event.target.value })} /></label><label>UPC<input value={newLine.upc} onChange={(event) => setNewLine({ ...newLine, upc: event.target.value })} /></label>
              <label>Units / case<input inputMode="numeric" value={newLine.units} onChange={(event) => setNewLine({ ...newLine, units: event.target.value.replace(/\D/g, '') })} /></label><label>Cases<input inputMode="numeric" value={newLine.cases} onChange={(event) => setNewLine({ ...newLine, cases: event.target.value.replace(/\D/g, '') })} /></label>
              <label>Case cost ($)<input aria-label="New line case cost" inputMode="decimal" value={newLine.caseCost} onChange={(event) => setNewLine({ ...newLine, caseCost: event.target.value.replace(/[^\d.]/g, '') })} /></label></>
              : <label>Amount ($)<input aria-label="New line amount" inputMode="decimal" value={newLine.amount} onChange={(event) => setNewLine({ ...newLine, amount: event.target.value.replace(/[^\d.]/g, '') })} /></label>}
            <button className="primary" disabled={busy || !newLine.description.trim()} onClick={() => void addManualLine()}>Add line</button></div></section>}
      </>}
      {step === 'confirm' && review && <ConfirmPanel docId={document.id} status={document.reviewStatus} review={review} busy={busy} setError={setError} onChanged={() => void run(() => adminApi.invoice(document.id), '')}
        onConfirmed={(text) => { setMessage(text); void run(() => adminApi.invoice(document.id), text); }} />}
      <div className="invoice-actions"><button disabled={busy || document.reviewStatus !== 'DRAFT'} onClick={() => void run(() => adminApi.retryInvoiceOcr(document.id), 'OCR rerun completed; review matches again.')}>Retry OCR</button>
        <label className="file-button">Add another page / photo<input aria-label="Add page" type="file" hidden disabled={busy || document.reviewStatus !== 'DRAFT'} accept="image/jpeg,image/png,image/webp,application/pdf,application/json,.json" onChange={(event) => { void addPageFile(event.target.files?.[0]); event.target.value = ''; }} /></label>
        <button disabled={busy || document.reviewStatus !== 'DRAFT'} onClick={() => { if (window.confirm('Reject this invoice? No inventory will change.')) void run(() => adminApi.rejectInvoice(document.id), 'Invoice rejected; no inventory was changed.'); }}>Reject</button>
        {document.vendor && <a className="hdr-link" href={`/admin/vendor/?id=${document.vendor.id}`}>Open vendor →</a>}</div>
    </section>}
  </main>;
}
