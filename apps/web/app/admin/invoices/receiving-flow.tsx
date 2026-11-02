'use client';
import { useState } from 'react';
import type { Vendor } from '../admin-client';
import { dollarsToMinor, minorToDollars, receivingError, receivingApi, show, type FullReview, type ReceivingLine } from './receiving-client';
import { ReceivingTable } from './receiving-table';

export type HeaderDoc = Record<string, unknown> & { id: string; reviewStatus: string; docType: string; vendor: { id: string; name: string } | null };
const str = (doc: HeaderDoc, key: string): string => { const value = doc[key]; return typeof value === 'string' ? value : ''; };
const dateStr = (doc: HeaderDoc, key: string): string => { const value = doc[key]; return typeof value === 'string' ? value.slice(0, 10) : ''; };
const moneyStr = (doc: HeaderDoc, key: string): string => { const value = doc[key]; return typeof value === 'string' ? minorToDollars(value) : ''; };
const lines = (value: unknown): string => (value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}: ${String(entry)}`).join('\n') : '');
const parseLines = (text: string): Record<string, string> | null => { const out: Record<string, string> = {}; for (const row of text.split('\n')) { const at = row.indexOf(':'); if (at > 0 && row.slice(at + 1).trim()) out[row.slice(0, at).trim()] = row.slice(at + 1).trim(); } return Object.keys(out).length ? out : null; };

const DOC_TYPES: Array<[string, string]> = [['INVOICE', 'Invoice'], ['CREDIT_MEMO', 'Credit memo'], ['DELIVERY_RECEIPT', 'Delivery receipt'], ['BACKORDER', 'Backorder notice'], ['ADJUSTMENT', 'Adjustment']];
const CHARGE_KINDS: Array<[string, string]> = [['DELIVERY', 'Delivery'], ['FREIGHT', 'Freight'], ['SERVICE', 'Service charge'], ['FUEL', 'Fuel surcharge'], ['FEE', 'Misc fee'], ['DEPOSIT', 'Deposit'], ['TAX', 'Other tax / statutory'], ['CREDIT', 'Credit']];

function Text({ doc, field, label, disabled, save, kind = 'text' }: { doc: HeaderDoc; field: string; label: string; disabled: boolean; save: (body: Record<string, unknown>) => void; kind?: 'text' | 'money' | 'date' }): React.ReactNode {
  const current = kind === 'money' ? moneyStr(doc, field) : kind === 'date' ? dateStr(doc, field) : str(doc, field);
  return <label className="rt-field">{label}<input aria-label={label} key={current} defaultValue={current} disabled={disabled} type={kind === 'date' ? 'date' : 'text'} inputMode={kind === 'money' ? 'decimal' : 'text'}
    onBlur={(event) => { const next = event.target.value.trim(); if (next === current) return; if (kind === 'money') { const minor = dollarsToMinor(next); if (minor === null) return; save({ [field]: minor ?? '' }); } else save({ [field]: next }); }} /></label>;
}

/** Every header field a distributor may print, all optional. Vendor-specific extras and regulatory/remittance details are kept as notes, not required. */
export function HeaderForm({ doc, vendors, disabled, onSave }: { doc: HeaderDoc; vendors: Vendor[]; disabled: boolean; onSave: (body: Record<string, unknown>) => void }): React.ReactNode {
  const props = { doc, disabled, save: onSave };
  const extras = Array.isArray(doc.vendorExtras) ? (doc.vendorExtras as Array<{ label: string; value: string }>) : [];
  return <div className="rt-grid" aria-label="Invoice header">
    <fieldset><legend>Vendor / distributor</legend>
      <label className="rt-field">Vendor<select aria-label="Vendor" disabled={disabled} value={doc.vendor?.id ?? ''} onChange={(event) => onSave({ vendorId: event.target.value || null })}><option value="">Choose vendor…</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
      <Text {...props} field="vendorAccountNumber" label="Vendor account #" /><Text {...props} field="vendorAddress" label="Vendor address" /><Text {...props} field="vendorPhone" label="Vendor phone" />
    </fieldset>
    <fieldset><legend>Store / customer</legend>
      <Text {...props} field="billTo" label="Bill to" /><Text {...props} field="shipTo" label="Ship to" /><Text {...props} field="customerAccountNumber" label="Customer / account #" /><Text {...props} field="licenseNumber" label="Store / license #" />
    </fieldset>
    <fieldset><legend>Document</legend>
      <label className="rt-field">Document type<select aria-label="Document type" disabled={disabled} value={doc.docType} onChange={(event) => onSave({ docType: event.target.value })}>{DOC_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      <Text {...props} field="invoiceNumber" label="Invoice #" /><Text {...props} field="invoiceDate" label="Invoice date" kind="date" /><Text {...props} field="orderNumber" label="Order #" /><Text {...props} field="poReference" label="PO # / reference" /><Text {...props} field="documentNumber" label="Document #" />
      <Text {...props} field="shipDate" label="Ship date" kind="date" /><Text {...props} field="deliveryDate" label="Delivery date" kind="date" /><Text {...props} field="dueDate" label="Due date" kind="date" />
      <Text {...props} field="routeReference" label="Route / reference" /><Text {...props} field="salesperson" label="Salesperson / rep" /><Text {...props} field="customerTerms" label="Customer terms" /><Text {...props} field="paymentTerms" label="Payment terms (e.g. NET 30)" />
    </fieldset>
    <fieldset><legend>Invoice totals (as printed)</legend>
      <Text {...props} field="grossMerchandiseMinor" label="Gross merchandise ($)" kind="money" /><Text {...props} field="postOffTotalMinor" label="Post-off total ($)" kind="money" /><Text {...props} field="discountMinor" label="Discount total ($)" kind="money" /><Text {...props} field="rebateMinor" label="Rebate / allowance ($)" kind="money" />
      <Text {...props} field="feesMinor" label="Delivery / freight / fees ($)" kind="money" /><Text {...props} field="taxMinor" label="Tax ($)" kind="money" /><Text {...props} field="depositMinor" label="Deposit ($)" kind="money" /><Text {...props} field="creditMinor" label="Credit ($)" kind="money" />
      <Text {...props} field="subtotalMinor" label="Invoice subtotal ($)" kind="money" /><Text {...props} field="invoiceNetMinor" label="Invoice net amount ($)" kind="money" /><Text {...props} field="totalMinor" label="Invoice total ($)" kind="money" /><Text {...props} field="amountDueMinor" label="Amount due ($)" kind="money" />
    </fieldset>
    <fieldset><legend>Other printed information (kept, not required)</legend>
      <label className="rt-field">Summary (bottles, packages, gallons by class)<textarea aria-label="Summary details" rows={3} disabled={disabled} key={lines(doc.summaryMetadata)} defaultValue={lines(doc.summaryMetadata)} placeholder="Total bottles: 48" onBlur={(event) => { if (event.target.value !== lines(doc.summaryMetadata)) onSave({ summaryMetadata: parseLines(event.target.value) }); }} /></label>
      <label className="rt-field">Previous balance / payments (accounting only)<textarea aria-label="Remittance details" rows={3} disabled={disabled} key={lines(doc.remittanceMetadata)} defaultValue={lines(doc.remittanceMetadata)} placeholder="Previous invoice 1234: $200.00" onBlur={(event) => { if (event.target.value !== lines(doc.remittanceMetadata)) onSave({ remittanceMetadata: parseLines(event.target.value) }); }} /></label>
      {extras.length > 0 && <div><strong>Other fields the vendor printed</strong><ul className="hint">{extras.map((entry) => <li key={entry.label}>{entry.label}: {entry.value}</li>)}</ul></div>}
      <p className="hint">Previous balances and payments never count as merchandise received.</p>
    </fieldset>
  </div>;
}

/** Charges, reconciliation, blockers, notes, and the one explicit Final Confirmation. Nothing is posted before it. */
export function ConfirmPanel({ docId, status, review, busy, onChanged, onConfirmed, setError }: {
  docId: string; status: string; review: FullReview; busy: boolean; onChanged: () => void; onConfirmed: (message: string) => void; setError: (message: string) => void;
}): React.ReactNode {
  const r = review.receiving; const rec = r.reconciliation;
  const [kind, setKind] = useState('DELIVERY'); const [amount, setAmount] = useState(''); const [label, setLabel] = useState('');
  const [ack, setAck] = useState(false); const [note, setNote] = useState(''); const [dup, setDup] = useState(false); const [claims, setClaims] = useState(true);
  const locked = status !== 'DRAFT';
  const diff = rec.differenceMinor === null ? null : BigInt(rec.differenceMinor);
  const canConfirm = !locked && !busy && r.blockers.length === 0 && (!review.hasDiscrepancies || ack) && (!r.requiresNote || note.trim().length > 3) && (!r.warnings.some((warning) => warning.code === 'PROBABLE_DUPLICATE') || dup);
  async function addCharge(): Promise<void> {
    const minor = dollarsToMinor(amount); if (!minor) return;
    try { await receivingApi.addCharge(docId, { kind, amountMinor: minor, ...(label.trim() ? { label: label.trim() } : {}) }); setAmount(''); setLabel(''); onChanged(); } catch (cause) { setError(receivingError(cause)); }
  }
  async function confirm(): Promise<void> {
    try {
      const result = await receivingApi.confirm(docId, { acknowledgeDiscrepancies: ack, acknowledgeDuplicate: dup, createClaims: claims, ...(note.trim() ? { reconciliationNote: note.trim() } : {}) });
      onConfirmed(r.postsInventory ? `Received and posted to inventory.${result.claimsCreated?.length ? ` ${result.claimsCreated.length} draft vendor claim${result.claimsCreated.length === 1 ? '' : 's'} created.` : ''}` : 'Recorded. This document type does not change inventory.');
    } catch (cause) { setError(receivingError(cause)); }
  }
  return <div className="rt-confirm">
    <section className="detail-card" aria-label="Charges and credits"><h3>Charges, fees, deposits and credits</h3>
      <p className="hint">Kept separate from product cost. They are never spread into unit costs.</p>
      {r.charges.length > 0 && <table className="line-table compact"><tbody>{r.charges.map((charge) => <tr key={charge.id}><td>{charge.label}{charge.originalLabel ? <small className="stack">Vendor label: {charge.originalLabel}</small> : null}</td><td className="num">{show(charge.amountMinor)}</td><td>{!locked && <button onClick={() => void receivingApi.removeCharge(docId, charge.id).then(onChanged).catch((cause) => setError(receivingError(cause)))}>Remove</button>}</td></tr>)}</tbody></table>}
      {r.nonInventoryLines.length > 0 && <p className="hint">Non-inventory lines (never create products): {r.nonInventoryLines.map((line) => `${line.description} ${show(line.amountMinor)}`).join('; ')}</p>}
      {!locked && <div className="inline-form"><label>Type<select value={kind} onChange={(event) => setKind(event.target.value)}>{CHARGE_KINDS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><label>Label (optional)<input value={label} onChange={(event) => setLabel(event.target.value)} /></label><label>Amount ($)<input aria-label="Charge amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))} /></label><button disabled={!dollarsToMinor(amount)} onClick={() => void addCharge()}>Add</button></div>}
    </section>
    <section className="detail-card" aria-label="Reconciliation"><h3>Invoice reconciliation</h3>
      <dl className="calc"><div><dt>Merchandise</dt><dd>{show(rec.merchandiseMinor)}</dd></div><div><dt>Calculated total</dt><dd>{show(rec.calculatedTotalMinor)}</dd></div><div><dt>Invoice total</dt><dd>{show(rec.invoiceTotalMinor)}</dd></div>
        <div className={rec.status === 'MATCH' ? '' : 'strong'}><dt>Difference</dt><dd className={rec.status === 'MATERIAL_DIFFERENCE' ? 'rt-bad' : ''}>{diff === null ? '—' : `${diff < 0n ? '−' : ''}${show(String(diff < 0n ? -diff : diff))}`}</dd></div></dl>
      <p className="hint">Lines + charges + tax + deposits − credits. {rec.status === 'MATCH' ? 'Totals agree.' : rec.status === 'MINOR_DIFFERENCE' ? 'Small difference: check rounding.' : rec.status === 'MATERIAL_DIFFERENCE' ? 'Material difference: it must be explained before confirming.' : 'No invoice total entered.'}</p>
    </section>
    {(r.blockers.length > 0 || r.warnings.length > 0 || r.missingFromInvoice.length > 0) && <section className="detail-card" aria-label="Review items"><h3>Before you confirm</h3>
      {r.blockers.map((item) => <p key={item.code} className="discrepancy error" role="alert">⛔ {item.message}</p>)}{r.warnings.map((item) => <p key={item.code} className="discrepancy">⚠ {item.message}</p>)}
      {r.missingFromInvoice.length > 0 && <p className="discrepancy">⚠ On the purchase order but not on this invoice: {r.missingFromInvoice.map((entry) => `${entry.productName} (${entry.outstandingUnits})`).join(', ')}.</p>}
      {r.continuation.length > 0 && !locked && <p className="discrepancy">Possible other pages: {r.continuation.map((entry) => <button key={entry.id} onClick={() => void receivingApi.merge(docId, entry.id).then(onChanged).catch((cause) => setError(receivingError(cause)))}>Merge “{entry.originalFilename}” ({entry._count.lines} lines) into this invoice</button>)}</p>}
    </section>}
    {!locked && <section className="detail-card" aria-label="Final confirmation"><h3>Final confirmation</h3>
      <p className="hint">{r.postsInventory ? 'Confirming posts only the sellable received units to inventory, writes damaged units to the damage ledger, saves the exact costs to history, and drafts vendor claims for shortages and damage. Retail prices are not changed.' : 'This document type records the paperwork only. Inventory is not changed.'}</p>
      {review.hasDiscrepancies && <label className="warning"><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} /> I reviewed the discrepancies (short/over quantities, cost or total differences) and accept them.</label>}
      {r.warnings.some((warning) => warning.code === 'PROBABLE_DUPLICATE') && <label className="warning"><input type="checkbox" checked={dup} onChange={(event) => setDup(event.target.checked)} /> I checked this is not a duplicate of an earlier invoice.</label>}
      {r.requiresNote && <label className="rt-field">Why do the totals differ?<input aria-label="Reconciliation note" value={note} onChange={(event) => setNote(event.target.value)} /></label>}
      {r.postsInventory && <label className="rt-check"><input type="checkbox" checked={claims} onChange={(event) => setClaims(event.target.checked)} /> Draft vendor claims for shortages, damage and rejected product</label>}
      <div className="wizard-actions"><span className="hint">{r.blockers.length ? 'Clear the blocking items above first.' : ''}</span><button className="big" disabled={!canConfirm} onClick={() => void confirm()}>{r.postsInventory ? 'Confirm and post inventory' : 'Confirm document'}</button></div>
    </section>}
  </div>;
}

export { ReceivingTable };
export type { ReceivingLine };
