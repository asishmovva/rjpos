'use client';
import { useEffect, useMemo, useState } from 'react';
import { divideRounded, effectiveCost, priceMetrics, suggestRetailPrice, type PricingMode } from '@rjpos/domain-types';
import { parseDollarsToMinor } from '../../../register-api';
import { adminApi, money, type Category, type Store, type Vendor } from '../../admin-client';
import { costingApi, type PriceBook, type PurchasedProductRequest, type TaxProfile, type UpcLookup } from '../../costing-client';
import '../../admin.css';
import '../../costing.css';

type Unit = { key: number; name: string; unitsPerPack: number; upc: string; sku: string; price: string; touched: boolean };
type Special = { key: number; priceBookId: string; unitIndex: number; price: string };
const PRESETS = [{ name: 'Single', unitsPerPack: 1 }, { name: '6-Pack', unitsPerPack: 6 }, { name: '12-Pack', unitsPerPack: 12 }, { name: '24-Pack / Case', unitsPerPack: 24 }];
const ERRORS: Record<string, string> = {
  UPC_ALREADY_EXISTS: 'That UPC already exists in the catalog. Open the existing product instead of creating a duplicate.', SKU_ALREADY_EXISTS: 'That SKU is already used by another item.',
  VENDOR_REQUIRED: 'Choose a vendor, or save as an incomplete draft.', CASE_COST_REQUIRED: 'Enter the case cost.', SINGLE_UNIT_REQUIRED: 'Add a "Single" selling unit (1 bottle).',
  PRICE_REQUIRED: 'Enter a retail price for every selling unit, or save as a draft.', BRAND_REQUIRED: 'Enter the brand.', SIZE_REQUIRED: 'Enter the size, for example 750 ml.',
  DEALS_EXCEED_CASE_COST: 'Discount plus rebate cannot exceed the case cost.', SPECIAL_PRICE_OVERLAP: 'Two special prices overlap for the same price book.',
};
const dollars = (minor: bigint): string => `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
const percent = (bp: number | null): string => (bp === null ? '—' : `${(bp / 100).toFixed(2)}%`);
function parsePercentBp(text: string): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?%?$/.exec(text.trim());
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0') : null;
}

export default function NewProductPage(): React.ReactNode {
  const [stores, setStores] = useState<Store[]>([]); const [categories, setCategories] = useState<Category[]>([]); const [vendors, setVendors] = useState<Vendor[]>([]);
  const [taxProfiles, setTaxProfiles] = useState<TaxProfile[]>([]); const [priceBooks, setPriceBooks] = useState<PriceBook[]>([]);
  const [scanUpc, setScanUpc] = useState(''); const [lookup, setLookup] = useState<UpcLookup | null>(null);
  const [storeId, setStoreId] = useState(''); const [name, setName] = useState(''); const [categoryId, setCategoryId] = useState(''); const [brand, setBrand] = useState('');
  const [sizeLabel, setSizeLabel] = useState(''); const [sku, setSku] = useState(''); const [taxProfileId, setTaxProfileId] = useState(''); const [ageRestricted, setAgeRestricted] = useState(true);
  const [vendorId, setVendorId] = useState(''); const [vendorSku, setVendorSku] = useState(''); const [caseCost, setCaseCost] = useState(''); const [unitsPerCase, setUnitsPerCase] = useState('12');
  const [discount, setDiscount] = useState(''); const [rebate, setRebate] = useState('');
  const [units, setUnits] = useState<Unit[]>([{ key: 1, name: 'Single', unitsPerPack: 1, upc: '', sku: '', price: '', touched: false }]);
  const [mode, setMode] = useState<PricingMode>('MARKUP'); const [pct, setPct] = useState('');
  const [specials, setSpecials] = useState<Special[]>([]); const [opening, setOpening] = useState('');
  const [draft, setDraft] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [created, setCreated] = useState<{ productId: string; draft: boolean } | null>(null); const [nextKey, setNextKey] = useState(2);

  useEffect(() => {
    void Promise.all([adminApi.stores(), adminApi.categories(), adminApi.vendors('', true), costingApi.taxProfiles(), costingApi.priceBooks()]).then(([storeRows, categoryRows, vendorRows, taxRows, bookRows]) => {
      setStores(storeRows); setStoreId((current) => current || storeRows[0]?.id || ''); setCategories(categoryRows.items); setVendors(vendorRows.items);
      setTaxProfiles(taxRows.profiles.filter((profile) => profile.active)); setPriceBooks(bookRows.filter((book) => book.active));
    }).catch((cause) => setError(ERRORS[cause instanceof Error ? cause.message : ''] ?? 'Could not load setup data.'));
  }, []);

  // Live case → unit economics. Everything below is integer cents; the case cost stays the source of truth.
  const caseMinor = parseDollarsToMinor(caseCost); const casesUnits = Number(unitsPerCase);
  const cost = useMemo(() => {
    if (caseMinor === null || !Number.isSafeInteger(casesUnits) || casesUnits < 1) return null;
    try { return effectiveCost({ baseCaseCostMinor: caseMinor, unitsPerCase: casesUnits, discountPerCaseMinor: parseDollarsToMinor(discount || '0') ?? 0n, rebatePerCaseMinor: parseDollarsToMinor(rebate || '0') ?? 0n }); } catch { return null; }
  }, [caseMinor, casesUnits, discount, rebate]);
  const pctBp = parsePercentBp(pct);
  const packCost = (packUnits: number): bigint | null => (cost ? divideRounded(cost.effectiveCaseCostMinor * BigInt(packUnits), BigInt(cost.unitsPerCase)) : null);
  const suggestion = (packUnits: number): bigint | null => {
    const base = packCost(packUnits);
    if (base === null || pctBp === null) return null;
    try { return suggestRetailPrice(base, mode, pctBp); } catch { return null; }
  };
  const shownPrice = (unit: Unit): string => { const suggested = suggestion(unit.unitsPerPack); return unit.touched || suggested === null ? unit.price : dollars(suggested); };

  function applyLookup(result: UpcLookup): void {
    setLookup(result);
    if (result.status === 'MASTER_CATALOG') {
      setName((current) => current || result.master.name); setBrand((current) => current || result.master.brand || '');
      setSizeLabel((current) => current || [result.master.sizeLabel, result.master.packName].filter(Boolean).join(' '));
      const match = categories.find((category) => category.name.toLowerCase() === (result.master.category ?? '').toLowerCase());
      if (match) setCategoryId((current) => current || match.id);
    }
  }
  async function search(): Promise<void> {
    setError(''); setCreated(null);
    try { applyLookup(await costingApi.upcLookup(scanUpc.trim())); } catch (cause) { setError(cause instanceof Error && cause.message === 'MASTER_UPC_INVALID' ? 'Enter a valid UPC (8, 12, 13 or 14 digits).' : 'Search failed. Try again.'); }
  }
  const addUnit = (preset: { name: string; unitsPerPack: number }) => { if (units.some((unit) => unit.unitsPerPack === preset.unitsPerPack)) return; setUnits((current) => [...current, { key: nextKey, ...preset, upc: '', sku: '', price: '', touched: false }].sort((a, b) => a.unitsPerPack - b.unitsPerPack)); setNextKey((key) => key + 1); };
  const patchUnit = (key: number, patch: Partial<Unit>) => setUnits((current) => current.map((unit) => (unit.key === key ? { ...unit, ...patch } : unit)));

  const request = (): PurchasedProductRequest | string => {
    if (!storeId) return 'Choose a store.';
    if (!name.trim() || !categoryId || !brand.trim() || !sizeLabel.trim()) return 'Enter product name, category, brand, and size.';
    if (!draft && (!vendorId || !cost || cost.baseCaseCostMinor <= 0n)) return 'Choose a vendor and enter the case cost and bottles per case (or save as a draft).';
    const unitPayload = units.map((unit) => { const minor = parseDollarsToMinor(shownPrice(unit)); return { unit, minor }; });
    if (!draft && unitPayload.some(({ minor }) => minor === null)) return 'Enter a retail price for every selling unit.';
    const opening_ = opening ? Number(opening) : 0;
    if (!Number.isSafeInteger(opening_) || opening_ < 0) return 'Opening inventory must be a whole number.';
    return {
      storeId, draft, product: { name: name.trim(), categoryId, brand: brand.trim(), ageRestricted, ...(taxProfileId ? { taxProfileId } : {}) },
      identity: { upc: scanUpc.trim(), sizeLabel: sizeLabel.trim(), ...(sku.trim() ? { sku: sku.trim() } : {}) },
      ...(vendorId && cost ? { vendor: { vendorId, ...(vendorSku.trim() ? { vendorSku: vendorSku.trim() } : {}), caseCostMinor: cost.baseCaseCostMinor.toString(), unitsPerCase: cost.unitsPerCase,
        discountPerCaseMinor: cost.discountPerCaseMinor.toString(), rebatePerCaseMinor: cost.rebatePerCaseMinor.toString() } } : {}),
      sellingUnits: unitPayload.map(({ unit, minor }) => ({ name: unit.name, unitsPerPack: unit.unitsPerPack, ...(unit.sku.trim() ? { sku: unit.sku.trim() } : {}), ...(unit.upc.trim() && unit.unitsPerPack !== 1 ? { upc: unit.upc.trim() } : {}), ...(minor === null ? {} : { priceMinor: minor.toString() }) })),
      specialPrices: specials.flatMap((special) => { const minor = parseDollarsToMinor(special.price); return special.priceBookId && minor !== null ? [{ priceBookId: special.priceBookId, unitIndex: special.unitIndex, amountMinor: minor.toString() }] : []; }),
      ...(opening_ > 0 ? { inventory: { openingQuantity: opening_ } } : {}),
    };
  };
  async function save(): Promise<void> {
    const payload = request();
    if (typeof payload === 'string') { setError(payload); return; }
    setBusy(true); setError('');
    try { const result = await costingApi.createPurchasedProduct(payload); setCreated({ productId: result.productId, draft: result.draft }); }
    catch (cause) { setError(ERRORS[cause instanceof Error ? cause.message : ''] ?? (cause instanceof Error ? cause.message : 'Could not create the product.')); }
    finally { setBusy(false); }
  }

  if (created) return <main className="admin-main costing-page"><header className="admin-heading"><div><a href="/admin/">← Back Office</a><h1>{created.draft ? 'Draft saved' : 'Product created'}</h1></div></header>
    <p className="admin-alert success">{created.draft ? 'The draft is inactive until it is completed.' : 'The product is active and ready to sell.'}</p>
    <p><a className="costing-link" href={`/admin/product/?id=${created.productId}`}>Open product details</a> · <button onClick={() => window.location.reload()}>Create another product</button></p></main>;

  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Purchasing</span><h1>New purchased product</h1></div></header>
    <p className="hint">Scan the UPC first: an existing product is reused, never duplicated. New products need vendor and case cost so profit is known from day one.</p>
    {error && <p className="admin-alert error" role="alert">{error}</p>}

    <section className="wizard-section" aria-label="Scan or search UPC">
      <h2>1 · Scan / search UPC</h2>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label>UPC<input aria-label="UPC" autoFocus inputMode="numeric" value={scanUpc} onChange={(event) => { setScanUpc(event.target.value); setLookup(null); }} placeholder="Scan or type the UPC" /></label>
        <button className="primary" disabled={!scanUpc.trim()}>Search</button>
      </form>
      {lookup?.status === 'IN_STORE' && <p className="admin-alert error">Already in this catalog as <strong>{lookup.variant.productName}</strong> ({lookup.variant.name}, SKU {lookup.variant.sku}). <a className="costing-link" href={`/admin/product/?id=${lookup.variant.productId}`}>Open the existing product</a> — do not create a duplicate.</p>}
      {lookup?.status === 'MASTER_CATALOG' && <p className="admin-alert success">Found in the master catalog: <strong>{lookup.master.name}</strong>. Details were filled in; it will be linked to the master record.{lookup.master.referencePriceMinor ? ` Reference price ${money(lookup.master.referencePriceMinor)} (not applied).` : ''}</p>}
      {lookup?.status === 'NEW' && <p className="hint">New UPC — continue below.</p>}
    </section>

    {lookup && lookup.status !== 'IN_STORE' && <>
      <section className="wizard-section" aria-label="Product"><h2>2 · Product</h2><div className="grid-form">
        <label>Store<select value={storeId} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
        <label>Product name<input aria-label="Product name" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Brand<input aria-label="Brand" value={brand} onChange={(event) => setBrand(event.target.value)} /></label>
        <label>Category<select aria-label="Category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Choose…</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label>Size<input aria-label="Size" value={sizeLabel} onChange={(event) => setSizeLabel(event.target.value)} placeholder="750 ml" /></label>
        <label>SKU (optional)<input aria-label="SKU" value={sku} onChange={(event) => setSku(event.target.value)} placeholder="Generated from the UPC if blank" /></label>
        <label>Tax profile<select aria-label="Tax profile" value={taxProfileId} onChange={(event) => setTaxProfileId(event.target.value)}><option value="">Default (Standard State Tax)</option>{taxProfiles.filter((profile) => !profile.isDefault).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.kind === 'CUSTOM' ? ` (${percent(profile.rateBasisPoints)})` : profile.kind === 'NON_TAXABLE' ? ' (0%)' : ''}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={ageRestricted} onChange={(event) => setAgeRestricted(event.target.checked)} /> Age restricted (21+)</label>
      </div></section>

      <section className="wizard-section" aria-label="Vendor and case"><h2>3 · Vendor &amp; case</h2><div className="grid-form">
        <label>Vendor<select aria-label="Vendor" value={vendorId} onChange={(event) => setVendorId(event.target.value)}><option value="">Choose vendor…</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
        <label>Vendor SKU<input aria-label="Vendor SKU" value={vendorSku} onChange={(event) => setVendorSku(event.target.value)} /></label>
        <label>Case cost ($)<input aria-label="Case cost" inputMode="decimal" value={caseCost} onChange={(event) => setCaseCost(event.target.value.replace(/[^\d.$]/g, ''))} placeholder="180.00" /></label>
        <label>Bottles / units per case<input aria-label="Units per case" inputMode="numeric" value={unitsPerCase} onChange={(event) => setUnitsPerCase(event.target.value.replace(/\D/g, ''))} /></label>
        <label>Deal: $ off per case<input aria-label="Discount per case" inputMode="decimal" value={discount} onChange={(event) => setDiscount(event.target.value.replace(/[^\d.$]/g, ''))} placeholder="0.00" /></label>
        <label>Rebate / allowance per case ($)<input aria-label="Rebate per case" inputMode="decimal" value={rebate} onChange={(event) => setRebate(event.target.value.replace(/[^\d.$]/g, ''))} placeholder="0.00" /></label>
      </div>
      <dl className="calc" aria-label="Unit cost">
        <div><dt>Case cost</dt><dd>{cost ? money(cost.baseCaseCostMinor) : '—'}</dd></div>
        {cost && cost.discountPerCaseMinor > 0n && <div><dt>− Discount</dt><dd>{money(cost.discountPerCaseMinor)}</dd></div>}
        {cost && cost.rebatePerCaseMinor > 0n && <div><dt>− Rebate</dt><dd>{money(cost.rebatePerCaseMinor)}</dd></div>}
        <div><dt>Effective case cost</dt><dd>{cost ? money(cost.effectiveCaseCostMinor) : '—'}</dd></div>
        <div className="strong"><dt>Unit cost</dt><dd>{cost ? money(cost.effectiveUnitCostMinor) : '—'}</dd></div>
      </dl></section>

      <section className="wizard-section" aria-label="Selling units"><h2>4 · Selling units</h2>
        <p className="hint">All formats sell from the same single-bottle stock: a 6-pack sale uses 6 bottles.</p>
        <div className="preset-row">{PRESETS.filter((preset) => !units.some((unit) => unit.unitsPerPack === preset.unitsPerPack)).map((preset) => <button key={preset.unitsPerPack} onClick={() => addUnit(preset)}>+ {preset.name}</button>)}</div>
        <table className="line-table"><thead><tr><th>Format</th><th>Bottles used</th><th>UPC</th><th>SKU</th></tr></thead><tbody>
          {units.map((unit) => <tr key={unit.key}><td>{unit.name}</td><td>{unit.unitsPerPack}</td>
            <td>{unit.unitsPerPack === 1 ? <span>{scanUpc.trim() || '—'}</span> : <input aria-label={`UPC ${unit.name}`} value={unit.upc} onChange={(event) => patchUnit(unit.key, { upc: event.target.value })} placeholder="optional" />}</td>
            <td><input aria-label={`SKU ${unit.name}`} value={unit.sku} onChange={(event) => patchUnit(unit.key, { sku: event.target.value })} placeholder="auto" /></td></tr>)}
        </tbody></table></section>

      <section className="wizard-section" aria-label="Pricing"><h2>5 · Pricing</h2>
        <div className="pricing-mode" role="radiogroup" aria-label="Pricing method">
          <label><input type="radio" name="mode" checked={mode === 'MARKUP'} onChange={() => setMode('MARKUP')} /> Markup on cost <small>price = cost × (1 + %)</small></label>
          <label><input type="radio" name="mode" checked={mode === 'MARGIN'} onChange={() => setMode('MARGIN')} /> Gross margin <small>price = cost ÷ (1 − %)</small></label>
          <label>Desired {mode === 'MARKUP' ? 'markup' : 'margin'} %<input aria-label="Desired percent" inputMode="decimal" value={pct} onChange={(event) => setPct(event.target.value.replace(/[^\d.%]/g, ''))} placeholder="19" /></label>
        </div>
        {mode === 'MARGIN' && pctBp !== null && pctBp >= 10_000 && <p className="admin-alert error">Margin must be below 100%.</p>}
        <div className="pricing-grid">{units.map((unit) => {
          const base = packCost(unit.unitsPerPack); const priceMinor = parseDollarsToMinor(shownPrice(unit)); const metrics = base !== null && priceMinor !== null ? priceMetrics(base, priceMinor) : null;
          return <article key={unit.key} className="price-card"><h3>{unit.name}</h3>
            <label>Retail price ($)<input aria-label={`Retail price ${unit.name}`} inputMode="decimal" value={shownPrice(unit)} onChange={(event) => patchUnit(unit.key, { price: event.target.value.replace(/[^\d.$]/g, ''), touched: true })} /></label>
            {unit.touched && suggestion(unit.unitsPerPack) !== null && <button className="text" onClick={() => patchUnit(unit.key, { touched: false })}>Use suggested {money(suggestion(unit.unitsPerPack)!)}</button>}
            <dl className="calc compact" aria-label={`Profit ${unit.name}`}>
              <div><dt>Cost</dt><dd>{base === null ? '—' : money(base)}</dd></div>
              <div><dt>Retail</dt><dd>{priceMinor === null ? '—' : money(priceMinor)}</dd></div>
              <div><dt>Profit</dt><dd>{metrics ? `${metrics.profitMinor < 0n ? '−' : ''}${money(metrics.profitMinor < 0n ? -metrics.profitMinor : metrics.profitMinor)}` : '—'}</dd></div>
              <div><dt>Margin</dt><dd>{percent(metrics?.marginBasisPoints ?? null)}</dd></div>
              <div><dt>Markup</dt><dd>{percent(metrics?.markupBasisPoints ?? null)}</dd></div>
            </dl>{metrics && metrics.profitMinor < 0n && <p className="admin-alert error">Selling below cost.</p>}</article>;
        })}</div></section>

      <section className="wizard-section" aria-label="Special pricing"><h2>6 · Special pricing</h2>
        <p className="hint">Optional named prices (DoorDash, Uber Eats, Price A…). They are separate from the standard price above.</p>
        {specials.map((special) => <div className="inline-form" key={special.key}>
          <label>Price book<select value={special.priceBookId} onChange={(event) => setSpecials((current) => current.map((row) => (row.key === special.key ? { ...row, priceBookId: event.target.value } : row)))}><option value="">Choose…</option>{priceBooks.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</select></label>
          <label>Format<select value={special.unitIndex} onChange={(event) => setSpecials((current) => current.map((row) => (row.key === special.key ? { ...row, unitIndex: Number(event.target.value) } : row)))}>{units.map((unit, index) => <option key={unit.key} value={index}>{unit.name}</option>)}</select></label>
          <label>Price ($)<input inputMode="decimal" value={special.price} onChange={(event) => setSpecials((current) => current.map((row) => (row.key === special.key ? { ...row, price: event.target.value.replace(/[^\d.$]/g, '') } : row)))} /></label>
          <button onClick={() => setSpecials((current) => current.filter((row) => row.key !== special.key))}>Remove</button></div>)}
        <button onClick={() => { setSpecials((current) => [...current, { key: nextKey, priceBookId: '', unitIndex: 0, price: '' }]); setNextKey((key) => key + 1); }}>+ Add special price</button></section>

      <section className="wizard-section" aria-label="Inventory"><h2>7 · Inventory</h2>
        <label className="inline-label">Opening inventory (bottles, optional)<input aria-label="Opening inventory" inputMode="numeric" value={opening} onChange={(event) => setOpening(event.target.value.replace(/\D/g, ''))} /></label>
        <p className="hint">Posted through the inventory ledger against the single-bottle stock.</p></section>

      <footer className="wizard-actions">
        <label className="check"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} /> Save as incomplete draft (inactive; vendor and prices may be missing)</label>
        <button className="primary big" disabled={busy} onClick={() => void save()}>{draft ? 'Save draft' : 'Create product'}</button>
      </footer>
    </>}
  </main>;
}
