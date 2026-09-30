'use client';
import { useEffect, useState } from 'react';
import { adminApi, type Store } from '../admin-client';
import { downloadText, errorText, phaseNineApi, type CsvKind, type ImportPreview } from '../phase9-client';
import '../admin.css';
import '../costing.css';

const KINDS: Array<[CsvKind, string, string]> = [
  ['products', 'Products', 'upc, sku, product_name, variant_name, brand, category, tax_profile, active. New items are created as inactive drafts.'],
  ['pricing', 'Pricing', 'upc or sku, price, optional store and price_book. Closes the old price and starts the new one.'],
  ['vendors', 'Vendors', 'name, contact_name, email, phone, account_reference, notes, active.'],
  ['inventory', 'Inventory', 'upc or sku, quantity (opening balance, once), low_stock_threshold, reorder_target. Existing stock is never overwritten.'],
  ['customers', 'Customers', 'name, email, phone, notes. Matched by email, then phone, then name.'],
];
const MAX_BYTES = 2_000_000;
const TEMPLATES: Record<CsvKind, string> = {
  products: 'upc,sku,product_name,variant_name,brand,category,tax_profile,active\n012345678905,,Example Lager 12oz,Each,Example Brewing,Beer,,\n',
  pricing: 'upc,sku,price,store,price_book\n012345678905,,12.99,,\n',
  vendors: 'name,contact_name,email,phone,account_reference,notes,active\nExample Distributing,Pat Smith,pat@example.com,555-0100,ACCT-1,,true\n',
  inventory: 'upc,sku,quantity,low_stock_threshold,reorder_target\n012345678905,,24,6,24\n',
  customers: 'name,email,phone,notes\nAlex Example,alex@example.com,555-0101,\n',
};

/** CSV export, and import as validate → preview → commit. Nothing is saved until the preview is confirmed. */
export default function ImportExportPage(): React.ReactNode {
  const [kind, setKind] = useState<CsvKind>('products'); const [stores, setStores] = useState<Store[]>([]); const [storeId, setStoreId] = useState('');
  const [csv, setCsv] = useState(''); const [fileName, setFileName] = useState(''); const [createCategories, setCreateCategories] = useState(false); const [skipInvalid, setSkipInvalid] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void adminApi.stores().then((list) => { setStores(list); setStoreId(list[0]?.id ?? ''); }).catch((cause) => setError(errorText(cause))); }, []);
  const options = { ...(storeId ? { storeId } : {}), createCategories };
  const reset = () => { setPreview(null); setMessage(''); };

  async function exportFile(): Promise<void> {
    setBusy(true); setError('');
    try { downloadText(`rjpos-${kind}.csv`, await phaseNineApi.exportCsv(kind, storeId || undefined)); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function pick(file: File | undefined): Promise<void> {
    reset(); setError('');
    if (!file) return;
    if (file.size > MAX_BYTES) { setError('That file is too large (2 MB maximum).'); return; }
    setCsv(await file.text()); setFileName(file.name);
  }
  async function check(): Promise<void> {
    setBusy(true); setError(''); setMessage('');
    try { setPreview(await phaseNineApi.previewCsv(kind, csv, options)); } catch (cause) { setPreview(null); setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function commit(): Promise<void> {
    setBusy(true); setError('');
    try { const result = await phaseNineApi.commitCsv(kind, csv, { ...options, skipInvalidRows: skipInvalid }); setMessage(`Imported: ${result.create} added, ${result.update} updated, ${result.skip} unchanged${result.errors ? `, ${result.errors} rejected` : ''}.`); setPreview(null); setCsv(''); setFileName(''); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  const hint = KINDS.find(([id]) => id === kind)![2];
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Data</span><h1>Import &amp; export</h1></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <ol className="steps" aria-label="Import progress">{['Upload', 'Validate', 'Preview', 'Confirm import'].map((label, at) => { const current = message ? 4 : preview ? 3 : csv ? 2 : 1; return <li key={label} className={at + 1 === current ? 'on' : at + 1 < current ? 'done' : ''}>{at + 1}. {label}</li>; })}</ol>
    <div className="tabs" role="tablist">{KINDS.map(([id, label]) => <button key={id} role="tab" aria-selected={kind === id} className={kind === id ? 'active' : ''} onClick={() => { setKind(id); setCsv(''); setFileName(''); reset(); }}>{label}</button>)}</div>
    <section className="wizard-section" aria-label="Export"><h2>Export</h2>
      <div className="inline-form">{(kind === 'pricing' || kind === 'inventory' || kind === 'products') && <label>Store<select aria-label="Store" value={storeId} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>}
        <button disabled={busy} onClick={() => void exportFile()}>Download {kind}.csv</button></div>
      <p className="hint">Exports open safely in spreadsheets: cells that start with =, +, - or @ are neutralized.</p></section>
    <section className="wizard-section" aria-label="Import"><h2>Import</h2>
      <p className="hint">Columns: {hint} Files are limited to 5,000 rows.</p>
      <div className="inline-form"><label>CSV file<input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(event) => void pick(event.target.files?.[0])} /></label>
        {kind === 'products' && <label className="check"><input type="checkbox" checked={createCategories} onChange={(event) => { setCreateCategories(event.target.checked); reset(); }} /> Create missing categories</label>}
        <button className="primary" disabled={busy || !csv} onClick={() => void check()}>Check file</button><button type="button" onClick={() => downloadText(`rjpos-${kind}-template.csv`, TEMPLATES[kind])}>Download template</button></div>
      {fileName && <p className="hint">{fileName} loaded. Nothing has been saved yet.</p>}
      {preview && <><dl className="calc"><div><dt>Rows</dt><dd>{preview.total}</dd></div><div><dt>Create</dt><dd>{preview.create}</dd></div><div><dt>Update</dt><dd>{preview.update}</dd></div><div><dt>Skip</dt><dd>{preview.skip}</dd></div><div className={preview.errors ? 'strong' : ''}><dt>Errors</dt><dd>{preview.errors}</dd></div></dl>
        <table className="line-table"><thead><tr><th>Line</th><th>Item</th><th>Result</th><th>Details</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={`${row.line}-${row.key}`} className={row.action === 'ERROR' ? 'bad' : ''}><td>{row.line || '—'}</td><td>{row.key}</td><td>{row.action}</td><td>{row.message ?? ''}</td></tr>)}</tbody></table>
        {preview.truncated && <p className="hint">Showing the first rows only. Errors are listed first.</p>}
        <div className="wizard-actions">{preview.errors > 0 ? <label className="check"><input type="checkbox" checked={skipInvalid} onChange={(event) => setSkipInvalid(event.target.checked)} /> Import the valid rows and skip the {preview.errors} with errors</label> : <span />}
          <button className="big" disabled={busy || (preview.errors > 0 && !skipInvalid) || preview.create + preview.update === 0} onClick={() => void commit()}>Import {preview.create + preview.update} row{preview.create + preview.update === 1 ? '' : 's'}</button></div></>}
    </section>
  </main>;
}
