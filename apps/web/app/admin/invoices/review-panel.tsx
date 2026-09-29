'use client';
import { money, type InvoiceDocument } from '../admin-client';
import type { InvoiceReview } from '../costing-client';

const label = (code: string) => code.replace(/_/g, ' ').toLowerCase();

/**
 * Case economics for every extracted line, with each disagreement between the invoice, its own arithmetic, the PO, and the
 * vendor's current cost highlighted. Nothing here changes data; vendor cost updates require the explicit per-line choice.
 */
export function InvoiceReviewPanel({ document, review, disabled, onToggleVendorCost }: {
  document: InvoiceDocument & { poReference?: string | null; discountMinor?: string | null; rebateMinor?: string | null; feesMinor?: string | null };
  review: InvoiceReview; disabled: boolean; onToggleVendorCost: (lineId: string, value: boolean) => void;
}): React.ReactNode {
  const header: Array<[string, string | null | undefined]> = [['PO / reference', document.poReference], ['Subtotal', document.subtotalMinor ? money(document.subtotalMinor) : null], ['Discounts', document.discountMinor ? money(document.discountMinor) : null],
    ['Rebates / allowances', document.rebateMinor ? money(document.rebateMinor) : null], ['Tax', document.taxMinor ? money(document.taxMinor) : null], ['Fees', document.feesMinor ? money(document.feesMinor) : null], ['Invoice total', document.totalMinor ? money(document.totalMinor) : null]];
  return <section className="invoice-economics" aria-label="Invoice cost review">
    <h3>Cost review</h3>
    <div className="calc" aria-label="Invoice header">{header.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? '—'}</dd></div>)}</div>
    {review.totals.discrepancies.map((item) => <p className="discrepancy error" role="alert" key={item.code}>⚠ {item.message} Expected {money(item.expectedMinor)}, invoice shows {money(item.actualMinor)}.</p>)}
    <div className="admin-table-wrap"><table className="review-table"><thead><tr><th>Line</th><th className="num">Cases</th><th className="num">Units / case</th><th className="num">Base case cost</th><th className="num">Case discount</th><th className="num">Effective case</th><th className="num">Effective unit</th><th className="num">Total units</th><th>Vendor cost</th></tr></thead><tbody>
      {document.lines.map((line) => {
        const row = review.lines.find((candidate) => candidate.lineId === line.id);
        if (!row) return null;
        if (row.ignored) return <tr key={line.id} className="ignored"><td colSpan={9}>Line {line.lineNumber}: ignored</td></tr>;
        const cost = row.review;
        const flagged = (code: string) => cost?.discrepancies.some((item) => item.code === code);
        return <tr key={line.id}><td><strong>{line.description}</strong>{row.error && <p className="discrepancy error">⚠ {label(row.error)}</p>}
          {cost?.discrepancies.map((item) => <p className="discrepancy" key={item.code}>⚠ {item.message}{item.expectedMinor !== undefined && item.actualMinor !== undefined ? ` (${money(item.expectedMinor)} vs ${money(item.actualMinor)})` : ''}</p>)}
          {row.dealPreview && <p className="hint">Available vendor deals ({row.availableDeals.map((deal) => deal.name).join(', ')}) would make the effective case {money(row.dealPreview.effectiveCaseCostMinor)} — not applied.</p>}</td>
          <td className="num">{cost?.cases ?? '—'}{line.casesReceived != null && line.casesReceived !== line.quantity ? <small className="stack">{line.casesReceived} received</small> : null}</td>
          <td className="num">{cost?.unitsPerCase ?? '—'}</td><td className="num">{cost ? money(cost.baseCaseCostMinor) : '—'}</td><td className="num">{cost ? money(cost.discountPerCaseMinor) : '—'}</td>
          <td className={`num ${flagged('LINE_TOTAL_MISMATCH') ? 'bad' : ''}`}>{cost ? money(cost.effectiveCaseCostMinor) : '—'}</td><td className={`num ${flagged('PO_COST_MISMATCH') ? 'bad' : ''}`}>{cost ? money(cost.effectiveUnitCostMinor) : '—'}</td>
          <td className={`num ${flagged('CASES_RECEIVED_DIFFER') ? 'bad' : ''}`}>{cost?.totalUnits ?? '—'}</td>
          <td className={flagged('VENDOR_COST_MISMATCH') ? 'bad' : ''}><label><input type="checkbox" aria-label={`Update vendor cost line ${line.lineNumber}`} disabled={disabled} checked={line.updateVendorCost === true} onChange={(event) => onToggleVendorCost(line.id, event.target.checked)} /> Update vendor cost</label></td></tr>;
      })}
    </tbody></table></div>
    <p className="hint">Vendor costs change only for lines you tick here. Retail prices and inventory are never changed by the review itself.</p>
  </section>;
}
