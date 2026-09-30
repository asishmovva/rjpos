'use client';
import { useEffect, useMemo, useState } from 'react';
import { adminApi, type Category, type Product, type Store, type Vendor } from '../admin-client';
import { costingApi, type TaxProfile } from '../costing-client';
import { errorText, phaseNineApi, type BulkOperation, type BulkPlan } from '../phase9-client';
import '../admin.css';
import '../costing.css';

type Kind = BulkOperation['type'];
const KINDS: Array<[Kind, string]> = [['PRICE', 'Change price'], ['TAX_PROFILE', 'Tax profile'], ['CATEGORY', 'Category'], ['VENDOR', 'Vendor'], ['ACTIVE', 'Activate / deactivate'], ['THRESHOLDS', 'Stock thresholds']];

/** Bulk tools: pick products, choose one operation, review exactly what changes, then apply. Stock on hand is never changed here. */
export default function BulkPage(): React.ReactNode {
  const [search, setSearch] = useState(''); const [products, setProducts] = useState<Product[]>([]); const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [stores, setStores] = useState<Store[]>([]); const [categories, setCategories] = useState<Category[]>([]); const [vendors, setVendors] = useState<Vendor[]>([]); const [profiles, setProfiles] = useState<TaxProfile[]>([]);
  const [kind, setKind] = useState<Kind>('PRICE'); const [storeId, setStoreId] = useState(''); const [mode, setMode] = useState<'PERCENT' | 'AMOUNT' | 'SET'>('PERCENT'); const [value, setValue] = useState('');
  const [taxProfileId, setTaxProfileId] = useState(''); const [categoryId, setCategoryId] = useState(''); const [vendorId, setVendorId] = useState(''); const [active, setActive] = useState(true); const [low, setLow] = useState(''); const [target, setTarget] = useState('');
  const [plan, setPlan] = useState<BulkPlan | null>(null); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([adminApi.stores(), adminApi.categories(), adminApi.vendors(), costingApi.taxProfiles()]).then(([storeList, categoryList, vendorList, tax]) => {
      setStores(storeList); setStoreId(storeList[0]?.id ?? ''); setCategories(categoryList.items); setVendors(vendorList.items); setProfiles(tax.profiles.filter((profile) => profile.active));
    }).catch((cause) => setError(errorText(cause)));
  }, []);
  useEffect(() => { const timer = setTimeout(() => void adminApi.products(search, 1, 25).then((result) => setProducts(result.items)).catch((cause) => setError(errorText(cause))), 250); return () => clearTimeout(timer); }, [search]);

  // Percent is entered as 10 or -2.5 and sent as basis points; amounts are dollars sent as minor units.
  const operation = useMemo((): BulkOperation | null => {
    const money = /^-?\d{1,7}(\.\d{1,2})?$/.exec(value.trim());
    if (kind === 'PRICE') {
      if (!storeId || !money) return null; const number = Number(value);
      return { type: 'PRICE', storeId, mode, value: mode === 'PERCENT' ? String(Math.round(number * 100)) : String(Math.round(number * 100)) };
    }
    if (kind === 'TAX_PROFILE') return taxProfileId ? { type: 'TAX_PROFILE', taxProfileId } : null;
    if (kind === 'CATEGORY') return categoryId ? { type: 'CATEGORY', categoryId } : null;
    if (kind === 'VENDOR') return vendorId ? { type: 'VENDOR', vendorId } : null;
    if (kind === 'ACTIVE') return { type: 'ACTIVE', active };
    const lowValue = low === '' ? undefined : Number(low); const targetValue = target === '' ? undefined : Number(target);
    if (!storeId || (lowValue === undefined && targetValue === undefined) || [lowValue, targetValue].some((number) => number !== undefined && (!Number.isInteger(number) || number < 0))) return null;
    return { type: 'THRESHOLDS', storeId, ...(lowValue === undefined ? {} : { lowStockThreshold: lowValue }), ...(targetValue === undefined ? {} : { reorderTarget: targetValue }) };
  }, [kind, storeId, mode, value, taxProfileId, categoryId, vendorId, active, low, target]);
  const ids = [...selected.keys()];
  useEffect(() => { setPlan(null); }, [operation, selected]);

  async function run(apply: boolean): Promise<void> {
    if (!operation) return; setBusy(true); setError(''); setMessage('');
    try {
      if (apply) { const result = await phaseNineApi.bulkApply(ids, operation); setMessage(`Applied to ${result.applicable} item${result.applicable === 1 ? '' : 's'}${result.skipped ? `, ${result.skipped} skipped` : ''}.`); setPlan(null); setSelected(new Map()); }
      else setPlan(await phaseNineApi.bulkPreview(ids, operation));
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Catalog</span><h1>Bulk changes</h1></div></header>
    <p className="hint">Changes apply to the products you select, only after you review them. Stock on hand is never changed here; use counts and adjustments for that.</p>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <section className="wizard-section" aria-label="Select products"><h2>1. Select products ({selected.size})</h2>
      <div className="inline-form"><label>Search<input aria-label="Search products" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, brand, SKU, or UPC" /></label>
        {selected.size > 0 && <button onClick={() => setSelected(new Map())}>Clear selection</button>}</div>
      <table className="line-table"><thead><tr><th /><th>Product</th><th>Category</th><th>Status</th></tr></thead><tbody>{products.map((product) => <tr key={product.id}>
        <td><input type="checkbox" aria-label={`Select ${product.name}`} checked={selected.has(product.id)} onChange={(event) => setSelected((current) => { const next = new Map(current); if (event.target.checked) next.set(product.id, product.name); else next.delete(product.id); return next; })} /></td>
        <td>{product.name}{product.brand ? <small className="stack">{product.brand}</small> : null}</td><td>{product.category.name}</td><td>{product.active ? 'Active' : 'Inactive'}</td></tr>)}</tbody></table>
      <div className="inline-form"><button onClick={() => setSelected((current) => { const next = new Map(current); products.forEach((product) => next.set(product.id, product.name)); return next; })} disabled={products.length === 0}>Select all shown</button></div></section>
    <section className="wizard-section" aria-label="Choose change"><h2>2. Choose a change</h2>
      <div className="tabs" role="tablist">{KINDS.map(([id, label]) => <button key={id} role="tab" aria-selected={kind === id} className={kind === id ? 'active' : ''} onClick={() => setKind(id)}>{label}</button>)}</div>
      <div className="inline-form">
        {(kind === 'PRICE' || kind === 'THRESHOLDS') && <label>Store<select aria-label="Store" value={storeId} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>}
        {kind === 'PRICE' && <><label>How<select aria-label="Price change type" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="PERCENT">Percent up/down</option><option value="AMOUNT">Dollars up/down</option><option value="SET">Set to exactly</option></select></label>
          <label>{mode === 'PERCENT' ? 'Percent (e.g. 10 or -5)' : mode === 'AMOUNT' ? 'Dollars (e.g. 0.50 or -1)' : 'New price (dollars)'}<input aria-label="Price value" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value.replace(/[^\d.-]/g, ''))} /></label></>}
        {kind === 'TAX_PROFILE' && <label>Tax profile<select aria-label="Tax profile" value={taxProfileId} onChange={(event) => setTaxProfileId(event.target.value)}><option value="">Choose…</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}
        {kind === 'CATEGORY' && <label>Category<select aria-label="Category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Choose…</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
        {kind === 'VENDOR' && <label>Vendor<select aria-label="Vendor" value={vendorId} onChange={(event) => setVendorId(event.target.value)}><option value="">Choose…</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>}
        {kind === 'ACTIVE' && <label>Set to<select aria-label="Active state" value={active ? 'yes' : 'no'} onChange={(event) => setActive(event.target.value === 'yes')}><option value="yes">Active</option><option value="no">Inactive</option></select></label>}
        {kind === 'THRESHOLDS' && <><label>Low-stock threshold<input aria-label="Low-stock threshold" inputMode="numeric" value={low} onChange={(event) => setLow(event.target.value.replace(/\D/g, ''))} /></label><label>Reorder target<input aria-label="Reorder target" inputMode="numeric" value={target} onChange={(event) => setTarget(event.target.value.replace(/\D/g, ''))} /></label></>}
        <button className="primary" disabled={busy || !operation || ids.length === 0} onClick={() => void run(false)}>Preview changes</button></div></section>
    {plan && <section className="wizard-section" aria-label="Preview"><h2>3. Review</h2>
      <p>{plan.applicable} will change, {plan.skipped} will be skipped.</p>
      <table className="line-table"><thead><tr><th>Item</th><th>Before</th><th>After</th><th /></tr></thead><tbody>{plan.changes.map((change) => <tr key={change.id} className={change.skip ? 'muted' : ''}><td>{change.label}</td><td>{change.before}</td><td>{change.skip ? '—' : change.after}</td><td>{change.skip ?? ''}</td></tr>)}</tbody></table>
      <div className="wizard-actions"><button onClick={() => setPlan(null)}>Cancel</button><button className="big" disabled={busy || plan.applicable === 0} onClick={() => void run(true)}>Apply to {plan.applicable} item{plan.applicable === 1 ? '' : 's'}</button></div></section>}
  </main>;
}
