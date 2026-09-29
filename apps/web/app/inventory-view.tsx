'use client';

import { useEffect, useState } from 'react';
import { api, friendlyError } from './register-api';

type Row = { id: string; onHand: number; reserved: number; lowStockThreshold: number; variant: { name: string; sku: string; product: { name: string; category: { name: string } | null }; barcodes: Array<{ barcodeValue: string }> } };
type Result = { items: Row[]; total: number; page: number; pageSize: number; categories: Array<{ id: string; name: string }> };
type Status = '' | 'in_stock' | 'low' | 'zero';
const PAGE_SIZE = 25;
const STATUSES: Array<[Status, string]> = [['', 'All'], ['in_stock', 'In stock'], ['low', 'Low'], ['zero', 'Out of stock']];

function stockState(row: Row): { label: string; className: string } {
  const available = row.onHand - row.reserved;
  if (available <= 0) return { label: 'Out of stock', className: 'stock-zero' };
  if (row.onHand <= row.lowStockThreshold) return { label: 'Low', className: 'stock-low' };
  return { label: 'In stock', className: 'stock-ok' };
}

/** Paged, filterable stock list. Each request is bounded to one page, so a large catalog stays fast. */
export function InventoryView({ storeName, onBack }: { storeName: string; onBack: () => void }): React.ReactNode {
  const [search, setSearch] = useState('');
  const [size, setSize] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<Status>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      if (size.trim()) params.set('size', size.trim());
      if (categoryId) params.set('categoryId', categoryId);
      if (status) params.set('status', status);
      void api<Result>(`/inventory?${params.toString()}`)
        .then((next) => { if (active) { setResult(next); setError(''); } })
        .catch((cause) => { if (active) setError(friendlyError(cause, 'Could not load inventory.')); })
        .finally(() => { if (active) setLoading(false); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, size, categoryId, status, page]);
  const refilter = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setPage(1); };
  const total = result?.total ?? 0;
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE);
  return <section className="management inventory">
    <div className="inventory-head">
      <div><span className="eyebrow">Management · {storeName}</span><h2>Inventory</h2></div>
      <button onClick={onBack}>Back to register</button>
    </div>
    <div className="inventory-filters">
      <label>Product, SKU, or UPC<input aria-label="Search inventory" placeholder="Search…" value={search} onChange={(event) => refilter(setSearch)(event.target.value)} /></label>
      <label>Size<input aria-label="Filter by size" placeholder="e.g. 750" value={size} onChange={(event) => refilter(setSize)(event.target.value)} /></label>
      <label>Category<select aria-label="Filter by category" value={categoryId} onChange={(event) => refilter(setCategoryId)(event.target.value)}><option value="">All categories</option>{result?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
      <div className="status-filter" role="group" aria-label="Stock status">{STATUSES.map(([value, label]) => <button key={label} className={status === value ? 'active' : ''} aria-pressed={status === value} onClick={() => refilter(setStatus)(value)}>{label}</button>)}</div>
    </div>
    {error && <p className="warning" role="alert">{error}</p>}
    <div className="inventory-scroll" aria-busy={loading}>
      <table>
        <thead><tr><th>Product</th><th>Size</th><th>SKU / UPC</th><th>Category</th><th className="num">On hand</th><th className="num">Available</th><th>Status</th></tr></thead>
        <tbody>
          {result?.items.map((row) => { const state = stockState(row); return <tr key={row.id}>
            <td><strong>{row.variant.product.name}</strong></td><td>{row.variant.name}</td>
            <td>{row.variant.sku}{row.variant.barcodes[0] ? <small>{row.variant.barcodes[0].barcodeValue}</small> : null}</td>
            <td>{row.variant.product.category?.name ?? '—'}</td><td className="num">{row.onHand}</td><td className="num"><b>{row.onHand - row.reserved}</b></td>
            <td><span className={`stock-pill ${state.className}`}>{state.label}</span></td></tr>; })}
          {result && result.items.length === 0 && <tr><td colSpan={7} className="empty-row">No items match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="inventory-pager">
      <span>{total === 0 ? 'No items' : `Showing ${first}–${last} of ${total.toLocaleString('en-US')}`}</span>
      <div><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><button disabled={last >= total} onClick={() => setPage((value) => value + 1)}>Next</button></div>
    </div>
  </section>;
}
