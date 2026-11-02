'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type Employee, type Vendor } from '../admin-client';
import { pct, receivingApi, receivingError, show, type ReceiptDetail, type ReceiptRow } from '../invoices/receiving-client';
import '../admin.css';
import '../costing.css';
import '../invoices/receiving.css';

const STATUSES: Array<[string, string]> = [['', 'Any status'], ['PARTIALLY_RECEIVED', 'Partially received'], ['RECEIVED', 'Received'], ['SUBMITTED', 'Open / ordered'], ['CANCELLED', 'Cancelled']];

/** Receiving history: find a delivery by vendor, invoice, PO, product, UPC, vendor SKU, date, employee, status, or problems; open it to see the exact economics it was posted with. */
export default function ReceivingHistoryPage(): React.ReactNode {
  const [vendors, setVendors] = useState<Vendor[]>([]); const [employees, setEmployees] = useState<Employee[]>([]);
  const [filter, setFilter] = useState({ vendorId: '', invoiceNumber: '', poNumber: '', product: '', employeeId: '', status: '', from: '', to: '', discrepancy: false });
  const [page, setPage] = useState(1); const [data, setData] = useState<{ total: number; pageSize: number; items: ReceiptRow[] } | null>(null);
  const [detail, setDetail] = useState<ReceiptDetail | null>(null); const [error, setError] = useState('');
  useEffect(() => { void Promise.all([adminApi.vendors('', undefined), adminApi.employees()]).then(([v, e]) => { setVendors(v.items); setEmployees(e.items); }).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    setError('');
    try { setData(await receivingApi.search({ ...filter, page, from: filter.from ? new Date(`${filter.from}T00:00:00`).toISOString() : undefined, to: filter.to ? new Date(`${filter.to}T23:59:59`).toISOString() : undefined, discrepancy: filter.discrepancy || undefined })); }
    catch (cause) { setError(receivingError(cause)); }
  }, [filter, page]);
  useEffect(() => { const timer = setTimeout(() => void load(), 250); return () => clearTimeout(timer); }, [load]);
  const set = (key: keyof typeof filter, value: string | boolean) => { setFilter((current) => ({ ...current, [key]: value })); setPage(1); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Purchasing</span><h1>Receiving history</h1></div><div><a className="hdr-link" href="/admin/invoices/">Receive an invoice →</a></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}
    <form className="inline-form rt-filters" onSubmit={(event) => event.preventDefault()}>
      <label>Vendor<select aria-label="Vendor" value={filter.vendorId} onChange={(event) => set('vendorId', event.target.value)}><option value="">All vendors</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
      <label>Invoice #<input aria-label="Invoice number" value={filter.invoiceNumber} onChange={(event) => set('invoiceNumber', event.target.value)} /></label>
      <label>PO #<input aria-label="PO number" value={filter.poNumber} onChange={(event) => set('poNumber', event.target.value)} /></label>
      <label>Product, UPC or vendor SKU<input aria-label="Product" value={filter.product} onChange={(event) => set('product', event.target.value)} /></label>
      <label>Received by<select aria-label="Employee" value={filter.employeeId} onChange={(event) => set('employeeId', event.target.value)}><option value="">Anyone</option>{employees.map((person) => <option key={person.id} value={person.id}>{person.firstName} {person.lastName}</option>)}</select></label>
      <label>PO status<select aria-label="Status" value={filter.status} onChange={(event) => set('status', event.target.value)}>{STATUSES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      <label>From<input type="date" value={filter.from} onChange={(event) => set('from', event.target.value)} /></label><label>To<input type="date" value={filter.to} onChange={(event) => set('to', event.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={filter.discrepancy} onChange={(event) => set('discrepancy', event.target.checked)} /> Only with shortages, damage or rejects</label>
    </form>
    <section className="wizard-section" aria-label="Receipts"><table className="line-table"><thead><tr><th>Received</th><th>Vendor</th><th>Invoice #</th><th>PO</th><th className="num">Bottles</th><th className="num">Damaged</th><th>By</th></tr></thead><tbody>
      {data?.items.map((receipt) => <tr key={receipt.id} className={detail?.id === receipt.id ? 'selected' : ''}><td><button className="text" onClick={() => void receivingApi.receipt(receipt.id).then(setDetail).catch((cause) => setError(receivingError(cause)))}>{new Date(receipt.receivedAt).toLocaleString()}</button></td>
        <td><a href={`/admin/vendor/?id=${receipt.purchaseOrder.vendor.id}`}>{receipt.purchaseOrder.vendor.name}</a></td><td>{receipt.invoiceNumber ?? '—'}</td><td>{receipt.purchaseOrder.poNumber}<small className="stack">{receipt.purchaseOrder.status.toLowerCase().replace('_', ' ')}</small></td>
        <td className="num">{receipt.deliveredUnits}</td><td className="num">{receipt.damagedUnits + receipt.rejectedUnits || ''}</td><td>{receipt.receivedBy.firstName} {receipt.receivedBy.lastName}</td></tr>)}
      {data && data.items.length === 0 && <tr><td colSpan={7}>No receipts match.</td></tr>}</tbody></table>
      <div className="wizard-actions"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages} · {data?.total ?? 0} receipts</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div></section>
    {detail && <section className="wizard-section" aria-label="Receipt detail"><h2>Receipt {new Date(detail.receivedAt).toLocaleDateString()} · {detail.purchaseOrder.vendor.name}</h2>
      <p className="hint">Invoice {detail.invoice ? <a href="/admin/invoices/">{detail.invoice.invoiceNumber ?? 'unnumbered'}</a> : detail.invoiceNumber ?? '—'}{detail.invoice?.invoiceDate ? ` · ${new Date(detail.invoice.invoiceDate).toLocaleDateString()}` : ''}{detail.invoice?.paymentTerms ? ` · ${detail.invoice.paymentTerms}` : ''} · PO {detail.purchaseOrder.poNumber} · received by {detail.receivedBy.firstName} {detail.receivedBy.lastName}. These costs are as posted and never change when the vendor&apos;s price changes later.</p>
      <div className="rt-wrap"><table className="rt"><thead><tr><th>Product</th><th>Vendor SKU</th><th className="num">Received</th><th className="num">Sellable</th><th className="num">Damaged</th><th className="num">List case</th><th className="num">Base case</th><th className="num">Discount</th><th className="num">Net case</th><th className="num">Effective case</th><th className="num">Unit cost</th></tr></thead><tbody>
        {detail.lines.map((line) => <tr key={line.id}><td><strong>{line.productName}</strong><small className="stack">{line.variantName} · {line.sku}</small></td><td>{line.vendorSku ?? '—'}</td><td className="num">{line.deliveredUnits}</td><td className="num">{line.sellableUnits}</td><td className="num">{line.damagedUnits + line.rejectedUnits || ''}</td>
          <td className="num">{show(line.cost?.listCaseCostMinor)}</td><td className="num">{show(line.cost?.baseCaseCostMinor)}</td><td className="num">{show(line.cost?.discountPerCaseMinor)}</td><td className="num">{show(line.cost?.netCaseCostMinor)}</td><td className="num">{show(line.cost?.effectiveCaseCostMinor)}{line.cost?.temporaryDeal && <small className="stack rt-warn">deal price</small>}</td><td className="num">{show(line.cost?.effectiveUnitCostMinor ?? line.unitCostMinor)}</td></tr>)}</tbody></table></div>
      {detail.claims.length > 0 && <><h3>Claims and credits</h3><table className="line-table compact"><tbody>{detail.claims.map((claim) => <tr key={claim.id}><td>{claim.kind.replace(/_/g, ' ').toLowerCase()}</td><td>{claim.status.toLowerCase()}</td><td className="num">expected {show(claim.expectedCreditMinor)}</td><td className="num">{claim.creditedMinor ? `credited ${show(claim.creditedMinor)}` : ''}</td><td>{claim.creditReference ?? ''}</td><td>{claim.resolvedAt ? new Date(claim.resolvedAt).toLocaleDateString() : ''}</td></tr>)}</tbody></table><a href="/admin/claims/">Open vendor claims →</a></>}
      <button className="text" onClick={() => setDetail(null)}>Close</button></section>}
    <span hidden>{pct(0)}</span>
  </main>;
}
