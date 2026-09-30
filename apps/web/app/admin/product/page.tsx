'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { priceMetrics } from '@rjpos/domain-types';
import { parseDollarsToMinor } from '../../register-api';
import { adminApi, money, type Store } from '../admin-client';
import { costingApi, type PriceBook, type ProductDetail, type TaxProfile, type VendorDealKind } from '../costing-client';
import '../admin.css';
import '../costing.css';

const TABS = ['Overview', 'Vendors & Costs', 'Selling Variants', 'Pricing', 'Special Pricing', 'Inventory', 'Purchase History', 'Receiving History', 'Invoices', 'Cost History', 'Vendor Deals/Rebates', 'Audit'] as const;
type Tab = (typeof TABS)[number];
const pct = (bp: number | null) => (bp === null ? '—' : `${(bp / 100).toFixed(2)}%`);
const when = (value: string | null) => (value ? new Date(value).toLocaleDateString() : '—');
const DEAL_LABELS: Record<VendorDealKind, string> = { DISCOUNT_PER_CASE: '$ off per case', DEAL_CASE_PRICE: 'Deal case price', QUANTITY_BREAK: 'Quantity break ($ off per case)', REBATE: 'Rebate ($ per case)', ALLOWANCE: 'Allowance ($ per case)' };

export default function ProductDetailPage(): React.ReactNode {
  const [id] = useState(() => (typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('id') ?? ''));
  const [detail, setDetail] = useState<ProductDetail | null>(null); const [tab, setTab] = useState<Tab>('Overview'); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [priceBooks, setPriceBooks] = useState<PriceBook[]>([]); const [stores, setStores] = useState<Store[]>([]); const [taxProfiles, setTaxProfiles] = useState<TaxProfile[]>([]);
  const [spVariant, setSpVariant] = useState(''); const [spBook, setSpBook] = useState(''); const [spStore, setSpStore] = useState(''); const [spPrice, setSpPrice] = useState(''); const [spFrom, setSpFrom] = useState(''); const [spTo, setSpTo] = useState('');
  const [dealKind, setDealKind] = useState<VendorDealKind>('DISCOUNT_PER_CASE'); const [dealName, setDealName] = useState(''); const [dealAmount, setDealAmount] = useState(''); const [dealMin, setDealMin] = useState(''); const [dealVendor, setDealVendor] = useState('');

  const load = useCallback(async () => {
    if (!id) { setError('No product selected.'); return; }
    const [productDetail, books, storeRows, taxRows] = await Promise.all([costingApi.productDetail(id), costingApi.priceBooks(), adminApi.stores(), costingApi.taxProfiles()]);
    setDetail(productDetail); setPriceBooks(books.filter((book) => book.active)); setStores(storeRows); setTaxProfiles(taxRows.profiles.filter((profile) => profile.active));
    setSpVariant((current) => current || productDetail.product.variants[0]?.id || ''); setSpStore((current) => current || storeRows[0]?.id || ''); setDealVendor((current) => current || productDetail.mappings[0]?.vendorId || '');
  }, [id]);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load the product.')); }, [load]);
  async function act(operation: () => Promise<unknown>, success: string): Promise<void> {
    setError(''); setMessage('');
    try { await operation(); setMessage(success); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'That did not work.'); }
  }

  const baseOf = (variant: ProductDetail['product']['variants'][number]) => variant.baseVariantId ?? variant.id;
  const unitCostFor = useMemo(() => {
    const costs = new Map(detail?.storeCosts.map((cost) => [cost.variantId, BigInt(cost.amountMinor)]) ?? []);
    return (variant: ProductDetail['product']['variants'][number]) => { const unit = costs.get(baseOf(variant)); return unit === undefined ? null : unit * BigInt(variant.unitsPerPack); };
  }, [detail]);
  if (!detail) return <main className="admin-main costing-page"><header className="admin-heading"><div><a href="/admin/">← Back Office</a><h1>Product</h1></div></header>{error ? <p className="admin-alert error">{error}</p> : <p className="hint">Loading…</p>}</main>;
  const { product } = detail;
  const variantName = (variantId: string) => product.variants.find((variant) => variant.id === variantId)?.name ?? 'Variant';
  const priceOf = (variantId: string) => detail.prices.find((price) => price.variantId === variantId)?.amountMinor;
  const table = (headers: string[], rows: React.ReactNode[][], empty: string) => <div className="admin-table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
    <tbody>{rows.length === 0 ? <tr><td colSpan={headers.length}>{empty}</td></tr> : rows.map((cells, index) => <tr key={index}>{cells.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;

  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">{product.category.name}{product.brand ? ` · ${product.brand}` : ''}</span><h1>{product.name}</h1></div>
      <div><span className={`pill ${product.active ? '' : 'warn'}`}>{product.draft ? 'DRAFT' : product.active ? 'ACTIVE' : 'INACTIVE'}</span></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <nav className="tabs" role="tablist" aria-label="Product sections">{TABS.map((name) => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</nav>

    {tab === 'Overview' && <div className="detail-card"><h3>Overview</h3>
      <p>Category <strong>{product.category.name}</strong> · Brand <strong>{product.brand ?? '—'}</strong> · {product.ageRestricted ? 'Age restricted (21+)' : 'Not age restricted'}</p>
      <label className="inline-label">Tax profile<select aria-label="Product tax profile" value={product.taxProfileId ?? ''} onChange={(event) => void act(() => costingApi.assignTaxProfile({ productId: product.id, taxProfileId: event.target.value || null }), 'Tax profile updated. Past orders are unchanged.')}>
        <option value="">Default (Standard State Tax)</option>{taxProfiles.filter((profile) => !profile.isDefault).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.kind === 'CUSTOM' ? ` (${pct(profile.rateBasisPoints)})` : ''}</option>)}</select></label>
      <p>Last received <strong>{detail.receivingHistory[0] ? when(detail.receivingHistory[0].receipt.receivedAt) : 'never'}</strong></p>
      {product.draft && <p className="admin-alert error">This is an incomplete draft and is inactive.</p>}</div>}

    {tab === 'Vendors & Costs' && <>{table(['Vendor', 'Vendor SKU', 'Case UPC', 'Case cost', 'Units / case', 'Min order', 'Unit cost', 'Preferred'], detail.mappings.map((mapping) => [mapping.vendor.name, mapping.vendorSku ?? '—', mapping.caseUpc ?? '—', mapping.caseCostMinor ? money(mapping.caseCostMinor) : '—', mapping.casePackQuantity, mapping.minimumOrderQuantity, money(mapping.vendorCostMinor), mapping.preferred ? 'Yes' : '']), 'No vendor linked yet.')}
      {table(['Store', 'Current unit cost (what we actually pay)'], detail.storeCosts.map((cost) => [cost.store.name, money(cost.amountMinor)]), 'No store cost recorded.')}</>}

    {tab === 'Selling Variants' && table(['Format', 'SKU', 'UPC', 'Bottles used', 'Sells from', 'Active'], product.variants.map((variant) => [variant.name, variant.sku, variant.barcodes[0]?.barcodeValue ?? '—', variant.unitsPerPack, variant.baseVariant ? variant.baseVariant.name : 'Own stock (base)', variant.active ? 'Yes' : 'No']), 'No variants.')}

    {tab === 'Pricing' && <>{table(['Format', 'Cost', 'Standard price', 'Profit', 'Margin', 'Markup'], product.variants.map((variant) => {
      const cost = unitCostFor(variant); const price = priceOf(variant.id); const metrics = cost !== null && price !== undefined ? priceMetrics(cost, BigInt(price)) : null;
      return [variant.name, cost === null ? '—' : money(cost), price === undefined ? '—' : money(price), metrics ? `${metrics.profitMinor < 0n ? '−' : ''}${money(metrics.profitMinor < 0n ? -metrics.profitMinor : metrics.profitMinor)}` : '—', pct(metrics?.marginBasisPoints ?? null), pct(metrics?.markupBasisPoints ?? null)];
    }), 'No prices.')}<p className="hint">Standard price is the in-store price. Channel and special prices live under Special Pricing and never change it.</p></>}

    {tab === 'Special Pricing' && <>
      <section className="wizard-section" aria-label="Add special price"><h3>Add or change a special price</h3><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const minor = parseDollarsToMinor(spPrice); if (minor === null) { setError('Enter a price such as 23.99.'); return; }
        void act(() => costingApi.saveSpecialPrice({ priceBookId: spBook, storeId: spStore, variantId: spVariant, amountMinor: minor.toString(), ...(spFrom ? { effectiveFrom: new Date(spFrom).toISOString() } : {}), ...(spTo ? { effectiveTo: new Date(spTo).toISOString() } : {}) }), 'Special price saved.'); }}>
        <label>Price book<select aria-label="Price book" value={spBook} onChange={(event) => setSpBook(event.target.value)}><option value="">Choose…</option>{priceBooks.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</select></label>
        <label>Format<select aria-label="Special price format" value={spVariant} onChange={(event) => setSpVariant(event.target.value)}>{product.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}</select></label>
        <label>Store<select value={spStore} onChange={(event) => setSpStore(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
        <label>Price ($)<input aria-label="Special price" inputMode="decimal" value={spPrice} onChange={(event) => setSpPrice(event.target.value.replace(/[^\d.$]/g, ''))} /></label>
        <label>Starts (optional)<input type="date" value={spFrom} onChange={(event) => setSpFrom(event.target.value)} /></label>
        <label>Ends (optional)<input type="date" value={spTo} onChange={(event) => setSpTo(event.target.value)} /></label>
        <button className="primary" disabled={!spBook || !spVariant || !spStore}>Save special price</button></form></section>
      {table(['Price book', 'Format', 'Store', 'Price', 'Window', 'Status', ''], detail.specialPrices.map((special) => [special.priceBook.name, variantName(special.variantId), special.store?.name ?? '', money(special.amountMinor), `${when(special.effectiveFrom)} → ${when(special.effectiveTo)}`, special.active ? 'Active' : 'Inactive',
        <button key="toggle" onClick={() => void act(() => costingApi.saveSpecialPrice({ id: special.id, priceBookId: special.priceBookId, storeId: special.storeId, variantId: special.variantId, amountMinor: special.amountMinor, active: !special.active, effectiveFrom: special.effectiveFrom, effectiveTo: special.effectiveTo }), special.active ? 'Special price deactivated.' : 'Special price activated.')}>{special.active ? 'Deactivate' : 'Activate'}</button>]), 'No special prices yet.')}</>}

    {tab === 'Inventory' && table(['Store', 'Stock (single bottles)', 'Reserved', 'Sellable as'], detail.levels.map((level) => [level.store.name, level.onHand, level.reserved, product.variants.map((variant) => `${variant.name}: ${Math.floor((level.onHand - level.reserved) / variant.unitsPerPack)}`).join(' · ')]), 'No stock recorded.')}

    {tab === 'Purchase History' && table(['Date', 'PO', 'Vendor', 'Ordered', 'Received', 'Units / case', 'Case cost', 'Discount / case', 'Unit cost'], detail.purchaseHistory.map((line) => [when(line.createdAt), line.purchaseOrder.poNumber, line.purchaseOrder.vendor.name, line.orderedQuantity, line.receivedQuantity, line.unitsPerCase ?? '—', line.caseCostMinor ? money(line.caseCostMinor) : '—', line.discountPerCaseMinor ? money(line.discountPerCaseMinor) : '—', money(line.unitCostMinor)]), 'No purchase orders.')}

    {tab === 'Receiving History' && table(['Received', 'Reference', 'Delivered', 'Damaged', 'Rejected', 'Unit cost'], detail.receivingHistory.map((line) => [when(line.receipt.receivedAt), line.receipt.vendorReferenceNumber ?? '—', line.deliveredQuantity, line.damagedQuantity, line.rejectedQuantity, money(line.unitCostMinor)]), 'Nothing received yet.')}

    {tab === 'Invoices' && table(['Invoice', 'Date', 'Vendor', 'Status', 'Cases', 'Units / case', 'Case cost', 'Discount / case', 'Line total'], detail.invoices.map((line) => [line.invoiceDocument.invoiceNumber ?? '—', when(line.invoiceDocument.invoiceDate), line.invoiceDocument.vendor?.name ?? '—', line.invoiceDocument.reviewStatus, line.quantity, line.caseQuantity, line.caseCostMinor ? money(line.caseCostMinor) : '—', line.discountPerCaseMinor ? money(line.discountPerCaseMinor) : '—', money(line.lineTotalMinor)]), 'No invoices.')}

    {tab === 'Cost History' && <>{table(['Date', 'Source', 'Cases ord/recv', 'Units / case', 'Case cost', 'Discount', 'Rebate', 'Effective case', 'Effective unit', 'Units recv', 'Damaged', 'Rejected', 'Short'], detail.costHistory.map((row) => [when(row.occurredAt), row.source.replace(/_/g, ' '), `${row.casesOrdered ?? '—'} / ${row.casesReceived ?? '—'}`, row.unitsPerCase, money(row.baseCaseCostMinor), money(row.discountPerCaseMinor), money(row.rebatePerCaseMinor), money(row.effectiveCaseCostMinor), money(row.effectiveUnitCostMinor), row.unitsReceived ?? '—', row.unitsDamaged, row.unitsRejected, row.unitsShort]), 'No cost history.')}
      <p className="hint">History is append-only: changing the vendor's current price never rewrites earlier costs.</p></>}

    {tab === 'Vendor Deals/Rebates' && <>
      <section className="wizard-section" aria-label="Add vendor deal"><h3>Add a vendor deal</h3><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const amount = parseDollarsToMinor(dealAmount); if (amount === null) { setError('Enter an amount such as 10.00.'); return; }
        void act(() => costingApi.createVendorDeal({ vendorId: dealVendor, variantId: product.variants[0] ? baseOf(product.variants[0]) : null, name: dealName, kind: dealKind, ...(dealKind === 'DEAL_CASE_PRICE' ? { dealCaseCostMinor: amount.toString() } : { amountMinor: amount.toString() }), ...(dealMin ? { minimumCases: Number(dealMin) } : {}) }), 'Vendor deal added.'); }}>
        <label>Vendor<select aria-label="Deal vendor" value={dealVendor} onChange={(event) => setDealVendor(event.target.value)}>{detail.mappings.map((mapping) => <option key={mapping.vendorId} value={mapping.vendorId}>{mapping.vendor.name}</option>)}</select></label>
        <label>Type<select aria-label="Deal type" value={dealKind} onChange={(event) => setDealKind(event.target.value as VendorDealKind)}>{(Object.keys(DEAL_LABELS) as VendorDealKind[]).map((kind) => <option key={kind} value={kind}>{DEAL_LABELS[kind]}</option>)}</select></label>
        <label>Name<input aria-label="Deal name" value={dealName} onChange={(event) => setDealName(event.target.value)} /></label>
        <label>{dealKind === 'DEAL_CASE_PRICE' ? 'Case price ($)' : 'Amount per case ($)'}<input aria-label="Deal amount" inputMode="decimal" value={dealAmount} onChange={(event) => setDealAmount(event.target.value.replace(/[^\d.$]/g, ''))} /></label>
        <label>Min cases (optional)<input aria-label="Deal minimum cases" inputMode="numeric" value={dealMin} onChange={(event) => setDealMin(event.target.value.replace(/\D/g, ''))} /></label>
        <button className="primary" disabled={!dealVendor || !dealName.trim() || !dealAmount}>Add deal</button></form></section>
      {table(['Deal', 'Vendor', 'Type', 'Amount', 'Min cases', 'Status', ''], detail.vendorDeals.map((deal) => [deal.name, deal.vendor?.name ?? '', DEAL_LABELS[deal.kind], money(deal.dealCaseCostMinor ?? deal.amountMinor ?? '0'), deal.minimumCases ?? '—', deal.active ? 'Active' : 'Inactive',
        <button key="toggle" onClick={() => void act(() => costingApi.updateVendorDeal(deal.id, { active: !deal.active }), deal.active ? 'Deal deactivated.' : 'Deal activated.')}>{deal.active ? 'Deactivate' : 'Activate'}</button>]), 'No vendor deals.')}
      <p className="hint">Deals reduce the effective cost on new purchase orders and are recorded per component in cost history. They never overwrite the vendor's base case cost.</p></>}

    {tab === 'Audit' && table(['When', 'Action', 'Details'], detail.audit.map((entry) => [new Date(entry.createdAt).toLocaleString(), entry.action.replace(/_/g, ' '), <code key="d">{JSON.stringify(entry.afterJson ?? {}).slice(0, 160)}</code>]), 'No audit entries.')}
  </main>;
}
