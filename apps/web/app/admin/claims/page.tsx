'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, money, type Product, type Store, type Vendor } from '../admin-client';
import { errorText, phaseNineApi, type VelocitySuggestion, type VendorClaim } from '../phase9-client';
import '../admin.css';
import '../costing.css';

const KINDS: Array<[VendorClaim['kind'], string]> = [['RETURN', 'Return to vendor'], ['SHORTAGE', 'Shortage'], ['DAMAGE', 'Damaged on arrival'], ['PRICE_DIFFERENCE', 'Price difference']];
const minor = (dollars: string): string => String(Math.round(Number(dollars) * 100));

/** Vendor returns and discrepancy claims, plus sales-velocity purchase suggestions. */
export default function ClaimsPage(): React.ReactNode {
  const [tab, setTab] = useState<'claims' | 'suggestions'>('claims');
  const [claims, setClaims] = useState<VendorClaim[]>([]); const [vendors, setVendors] = useState<Vendor[]>([]); const [stores, setStores] = useState<Store[]>([]);
  const [vendorId, setVendorId] = useState(''); const [kind, setKind] = useState<VendorClaim['kind']>('RETURN'); const [reason, setReason] = useState('');
  const [search, setSearch] = useState(''); const [results, setResults] = useState<Product[]>([]); const [lines, setLines] = useState<Array<{ variantId: string; label: string; quantity: string; unitCost: string }>>([]);
  const [credit, setCredit] = useState<Record<string, string>>({});
  const [storeId, setStoreId] = useState(''); const [suggestions, setSuggestions] = useState<VelocitySuggestion[]>([]);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = useCallback(async () => { setClaims(await phaseNineApi.claims()); }, []);
  useEffect(() => { void Promise.all([load(), adminApi.vendors(), adminApi.stores()]).then(([, vendorList, storeList]) => { setVendors(vendorList.items); setStores(storeList); setStoreId(storeList[0]?.id ?? ''); }).catch((cause) => setError(errorText(cause))); }, [load]);
  useEffect(() => { if (search.trim().length < 2) { setResults([]); return undefined; } const timer = setTimeout(() => void adminApi.products(search, 1, 8).then((result) => setResults(result.items)).catch(() => setResults([])), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { if (tab === 'suggestions' && storeId) void phaseNineApi.velocity({ storeId }).then(setSuggestions).catch((cause) => setError(errorText(cause))); }, [tab, storeId]);
  async function act(operation: () => Promise<unknown>, success: string): Promise<void> {
    setError(''); setMessage('');
    try { await operation(); setMessage(success); await load(); } catch (cause) { setError(errorText(cause)); }
  }
  const valid = vendorId && reason.trim() && lines.length > 0 && lines.every((line) => /^[1-9]\d{0,5}$/.test(line.quantity) && /^\d{0,7}(\.\d{1,2})?$/.test(line.unitCost));
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Purchasing</span><h1>Vendor claims &amp; suggestions</h1></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <div className="tabs" role="tablist"><button role="tab" aria-selected={tab === 'claims'} className={tab === 'claims' ? 'active' : ''} onClick={() => setTab('claims')}>Claims</button><button role="tab" aria-selected={tab === 'suggestions'} className={tab === 'suggestions' ? 'active' : ''} onClick={() => setTab('suggestions')}>Purchase suggestions</button></div>
    {tab === 'claims' && <>
      <section className="wizard-section" aria-label="New claim"><h2>New claim</h2>
        <p className="hint">Returns remove stock when submitted. Shortages, damage, and price differences record the credit you expect and never change stock.</p>
        <div className="inline-form"><label>Vendor<select aria-label="Vendor" value={vendorId} onChange={(event) => setVendorId(event.target.value)}><option value="">Choose…</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
          <label>Type<select aria-label="Claim type" value={kind} onChange={(event) => setKind(event.target.value as VendorClaim['kind'])}>{KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label>Reason<input aria-label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Corked, short by 2 cases" /></label></div>
        <div className="inline-form"><label>Add item<input aria-label="Search items" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product" /></label></div>
        {results.length > 0 && <div className="preset-row">{results.flatMap((product) => product.variants.filter((variant) => variant.active).map((variant) => <button key={variant.id} onClick={() => { setLines((current) => current.some((line) => line.variantId === variant.id) ? current : [...current, { variantId: variant.id, label: `${product.name} ${variant.name}`, quantity: '1', unitCost: '' }]); setSearch(''); }}>{product.name} · {variant.name}</button>))}</div>}
        {lines.length > 0 && <table className="line-table"><thead><tr><th>Item</th><th>Qty</th><th>Unit cost ($, blank = current)</th><th /></tr></thead><tbody>{lines.map((line, index) => <tr key={line.variantId}><td>{line.label}</td>
          <td><input aria-label={`Quantity ${line.label}`} inputMode="numeric" value={line.quantity} onChange={(event) => setLines((current) => current.map((item, at) => at === index ? { ...item, quantity: event.target.value.replace(/\D/g, '') } : item))} /></td>
          <td><input aria-label={`Unit cost ${line.label}`} inputMode="decimal" value={line.unitCost} onChange={(event) => setLines((current) => current.map((item, at) => at === index ? { ...item, unitCost: event.target.value.replace(/[^\d.]/g, '') } : item))} /></td>
          <td><button onClick={() => setLines((current) => current.filter((_, at) => at !== index))}>Remove</button></td></tr>)}</tbody></table>}
        <div className="wizard-actions"><span /><button className="big" disabled={!valid} onClick={() => void act(async () => { await phaseNineApi.createClaim({ vendorId, kind, reason, lines: lines.map((line) => ({ variantId: line.variantId, quantity: Number(line.quantity), ...(line.unitCost ? { unitCostMinor: minor(line.unitCost) } : {}) })) }); setLines([]); setReason(''); }, 'Claim saved as a draft.')}>Save draft claim</button></div></section>
      <section className="wizard-section" aria-label="Claims"><h2>Claims</h2>
        <table className="line-table"><thead><tr><th>Vendor</th><th>Type</th><th>Items</th><th className="num">Expected credit</th><th>Status</th><th /></tr></thead><tbody>{claims.map((claim) => <tr key={claim.id}>
          <td>{claim.vendor.name}<small className="stack">{new Date(claim.createdAt).toLocaleDateString()} · {claim.reason}</small></td><td>{KINDS.find(([id]) => id === claim.kind)?.[1]}</td>
          <td>{claim.lines.map((line) => `${line.quantity} × ${line.variant.product.name}`).join(', ')}</td><td className="num">{money(claim.expectedCreditMinor)}{claim.creditedMinor ? <small className="stack">credited {money(claim.creditedMinor)}</small> : null}</td><td>{claim.status.toLowerCase()}</td>
          <td>{claim.status === 'DRAFT' && <><button onClick={() => void act(() => phaseNineApi.submitClaim(claim.id), claim.kind === 'RETURN' ? 'Submitted. Stock was removed.' : 'Claim submitted.')}>Submit</button><button onClick={() => void act(() => phaseNineApi.cancelClaim(claim.id), 'Claim cancelled.')}>Cancel</button></>}
            {claim.status === 'SUBMITTED' && <><input aria-label={`Credit received ${claim.vendor.name}`} inputMode="decimal" placeholder="$ received" value={credit[claim.id] ?? ''} onChange={(event) => setCredit((current) => ({ ...current, [claim.id]: event.target.value.replace(/[^\d.]/g, '') }))} />
              <button disabled={!/^\d+(\.\d{1,2})?$/.test(credit[claim.id] ?? '')} onClick={() => void act(() => phaseNineApi.creditClaim(claim.id, minor(credit[claim.id]!)), 'Credit recorded.')}>Record credit</button>
              <button onClick={() => { const why = window.prompt('Why was it rejected?'); if (why?.trim()) void act(() => phaseNineApi.rejectClaim(claim.id, why), 'Claim marked rejected.'); }}>Rejected</button></>}</td></tr>)}
          {claims.length === 0 && <tr><td colSpan={6}>No claims yet.</td></tr>}</tbody></table></section></>}
    {tab === 'suggestions' && <section className="wizard-section" aria-label="Purchase suggestions"><h2>What to order</h2>
      <p className="hint">Based on the last 28 days of sales, 3 days lead time, and 14 days of cover, less stock on hand and on open orders, rounded up to the vendor&apos;s case size. Nothing is ordered automatically.</p>
      <div className="inline-form"><label>Store<select aria-label="Store" value={storeId} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label></div>
      <table className="line-table"><thead><tr><th>Item</th><th className="num">On hand</th><th className="num">On order</th><th className="num">Sold (28d)</th><th className="num">Days left</th><th className="num">Suggest</th><th>Vendor</th></tr></thead><tbody>{suggestions.map((row) => <tr key={row.variantId}>
        <td>{row.productName} {row.variantName}<small className="stack">{row.sku}</small></td><td className="num">{row.available}</td><td className="num">{row.onOrder}</td><td className="num">{row.soldUnits}</td><td className="num">{row.daysOfSupply ?? '—'}</td>
        <td className="num"><strong>{row.suggestedUnits}</strong><small className="stack">{row.casePackQuantity > 1 ? `${row.suggestedCases} case${row.suggestedCases === 1 ? '' : 's'}` : ''}{row.estimatedCostMinor ? ` · ${money(row.estimatedCostMinor)}` : ''}</small></td><td>{row.vendorName ?? '—'}</td></tr>)}
        {suggestions.length === 0 && <tr><td colSpan={7}>Nothing needs ordering right now.</td></tr>}</tbody></table></section>}
  </main>;
}
