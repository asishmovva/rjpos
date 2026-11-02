'use client';
import { Fragment, useState } from 'react';
import { dollarsToMinor, minorToDollars, pct, show, type ReceivingLine, type ReceivingReview, type ReviewedLine } from './receiving-client';

type Save = (lineId: string, body: Record<string, unknown>) => Promise<void>;
const FLAG_TEXT: Record<string, string> = { UNEXPECTED_ITEM: 'Not on the PO', MISSING_ITEM: 'Missing from invoice', PRICE_CHANGED: 'Price differs from PO', OVER_SHIPMENT: 'Over PO quantity', SHORTAGE: 'Short', BACKORDER: 'Backordered', EXACT: 'Exact' };
const DISPOSITIONS: Array<[string, string]> = [['SELLABLE', 'Receive as sellable'], ['DAMAGED', 'Damaged (write off)'], ['REJECT_TO_VENDOR', 'Reject to vendor'], ['VENDOR_CLAIM', 'Vendor claim'], ['PENDING_CREDIT', 'Pending credit']];
const CLAIM_KINDS: Array<[string, string]> = [['SHORTAGE', 'Short shipment'], ['DAMAGE', 'Breakage / damage'], ['WRONG_PRODUCT', 'Wrong product'], ['INCORRECT_COST', 'Incorrect cost'], ['MISSING_DISCOUNT', 'Missing discount'], ['OVERCHARGE', 'Overcharge'], ['OTHER', 'Other']];

/** One editable value. Saves on blur (or Enter) only when it changed; money is typed in dollars and sent as minor units. */
function Field({ label, value, onSave, kind = 'text', disabled, hint }: { label: string; value: string; onSave: (next: string) => void; kind?: 'text' | 'money' | 'int'; disabled?: boolean; hint?: string }): React.ReactNode {
  const [error, setError] = useState('');
  const commit = (raw: string) => {
    if (raw === value) { setError(''); return; }
    if (kind === 'money') { const minor = dollarsToMinor(raw); if (minor === null) { setError('Amount like 12.50'); return; } setError(''); onSave(minor ?? ''); return; }
    if (kind === 'int' && raw !== '' && !/^\d{1,6}$/.test(raw)) { setError('Whole number'); return; }
    setError(''); onSave(raw);
  };
  return <label className="rt-field">{label}<input aria-label={label} key={value} defaultValue={value} disabled={disabled} inputMode={kind === 'text' ? 'text' : 'decimal'} onBlur={(event) => commit(event.target.value.trim())} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
    {error ? <small className="rt-error">{error}</small> : hint ? <small>{hint}</small> : null}</label>;
}

/**
 * The receiving review table. The default columns carry the decision-making numbers; everything else (identity, every discount
 * component, RIP, damage, backorder, notes, what the vendor printed) is in the expandable row so nothing is hidden or discarded.
 */
export function ReceivingTable({ lines, review, disabled, onSave, onRemove, onClaim }: {
  lines: ReceivingLine[]; review: ReceivingReview; disabled: boolean; onSave: Save; onRemove: (lineId: string) => void;
  onClaim: (line: ReceivingLine, claim: { kind: string; quantity: number; unitCostMinor: string; reason: string }) => void;
}): React.ReactNode {
  const [open, setOpen] = useState<string | null>(null);
  const [claim, setClaim] = useState<{ kind: string; quantity: string; unit: string; reason: string }>({ kind: 'SHORTAGE', quantity: '1', unit: '', reason: '' });
  const reviewed = new Map(review.lines.map((line) => [line.lineId, line]));
  const productLines = lines.filter((line) => line.lineKind === 'PRODUCT');
  const save = (line: ReceivingLine, key: string, kind: 'text' | 'money' | 'int' = 'text') => (next: string) => {
    const value: unknown = kind === 'int' ? (next === '' ? null : Number(next)) : next === '' ? null : next;
    void onSave(line.id, { [key]: value });
  };
  return <div className="rt-wrap"><table className="rt" aria-label="Receiving review">
    <thead><tr><th /><th>Product</th><th>Vendor item #</th><th>Size</th><th className="num">Pack</th><th className="num">Ordered</th><th className="num">Invoiced</th><th className="num">Received</th><th className="num">Base case</th><th className="num">Discount</th><th className="num">Net case</th><th className="num">Net unit</th><th className="num">Line total</th><th>Difference</th><th>Status</th></tr></thead>
    <tbody>{productLines.map((line) => {
      const row: ReviewedLine | undefined = reviewed.get(line.id);
      const expanded = open === line.id;
      const variance = row?.quantities.variance ?? 'EXACT';
      const cost = row?.costChange;
      const flags = (row?.comparison.flags ?? []).filter((flag) => flag !== 'EXACT');
      return <Fragment key={line.id}>
        <tr className={`${line.ignored ? 'ignored' : ''} ${row?.issues.length ? 'rt-issue' : ''}`}>
          <td><button className="text" aria-expanded={expanded} aria-label={`Details line ${line.lineNumber}`} onClick={() => setOpen(expanded ? null : line.id)}>{expanded ? '▾' : '▸'}</button></td>
          <td><strong>{line.variant ? `${line.variant.product.name}` : line.description}</strong>{!line.variantId && !line.ignored && <small className="stack rt-warn">Not matched</small>}{row?.lowConfidence && <small className="stack rt-warn">Low confidence: check</small>}</td>
          <td>{line.vendorItemNumber ?? line.vendorSku ?? '—'}</td><td>{line.size ?? '—'}</td><td className="num">{line.caseQuantity}</td>
          <td className="num">{line.casesOrdered ?? '—'}</td><td className="num">{line.quantity}</td>
          <td className="num"><input className="rt-inline" aria-label={`Cases received line ${line.lineNumber}`} inputMode="numeric" disabled={disabled} key={String(line.casesReceived)} defaultValue={line.casesReceived ?? line.quantity} onBlur={(event) => { const next = event.target.value.trim(); if (/^\d{1,6}$/.test(next) && Number(next) !== (line.casesReceived ?? line.quantity)) void onSave(line.id, { casesReceived: Number(next) }); }} /></td>
          <td className="num">{show(row?.economics.baseCaseMinor)}{cost?.direction === 'UP' && <small className={`stack ${cost.significant ? 'rt-bad' : ''}`}>▲ {pct(cost.deltaBasisPoints)}</small>}{cost?.direction === 'DOWN' && <small className="stack rt-good">▼ {pct(cost.deltaBasisPoints)}</small>}</td>
          <td className="num">{show(row?.economics.discountPerCaseMinor)}</td><td className="num">{show(row?.economics.netCaseMinor)}</td><td className="num">{show(row?.economics.netUnitMinor)}</td>
          <td className="num">{show(line.lineTotalMinor)}{row?.economics.warnings.includes('EXTENDED_MISMATCH') && <small className="stack rt-bad">≠ {show(row.economics.extendedMinor)}</small>}</td>
          <td>{variance === 'EXACT' ? <span className="pill">Exact</span> : <span className={`pill ${variance === 'SHORT' ? 'warn' : 'tone-warn'}`}>{variance === 'SHORT' ? `Short ${row?.quantities.shortUnits}` : `Over ${row?.quantities.overUnits}`}</span>}{row && row.quantities.damagedUnits > 0 && <small className="stack rt-warn">{row.quantities.damagedUnits} damaged</small>}</td>
          <td><span className="pill">{line.ignored ? 'Ignored' : (row?.quantities.fulfillment ?? line.fulfillment).toLowerCase().replace('_', ' ')}</span>{flags.map((flag) => <small key={flag} className="stack rt-warn">{FLAG_TEXT[flag] ?? flag}</small>)}</td>
        </tr>
        {expanded && row && <tr className="rt-detail"><td colSpan={15}>
          <div className="rt-grid">
            <fieldset><legend>Identification</legend>
              <Field label="Vendor item #" value={line.vendorItemNumber ?? ''} disabled={disabled} onSave={save(line, 'vendorItemNumber')} /><Field label="Vendor SKU" value={line.vendorSku ?? ''} disabled={disabled} onSave={save(line, 'vendorSku')} />
              <Field label="UPC" value={line.upc ?? ''} disabled={disabled} onSave={save(line, 'upc')} /><Field label="Case UPC" value={line.caseUpc ?? ''} disabled={disabled} onSave={save(line, 'caseUpc')} /><Field label="Alternate UPC" value={line.alternateUpc ?? ''} disabled={disabled} onSave={save(line, 'alternateUpc')} />
              <Field label="Brand" value={line.brand ?? ''} disabled={disabled} onSave={save(line, 'brand')} /><Field label="Size" value={line.size ?? ''} disabled={disabled} onSave={save(line, 'size')} /><Field label="Pack label" value={line.packLabel ?? ''} disabled={disabled} onSave={save(line, 'packLabel')} /><Field label="Vintage" value={line.vintage ?? ''} disabled={disabled} onSave={save(line, 'vintage')} />
              <Field label="Units per case" kind="int" value={String(line.caseQuantity)} disabled={disabled} onSave={save(line, 'caseQuantity', 'int')} />
            </fieldset>
            <fieldset><legend>Quantities</legend>
              <Field label="Cases ordered" kind="int" value={line.casesOrdered === null ? '' : String(line.casesOrdered)} disabled={disabled} onSave={save(line, 'casesOrdered', 'int')} /><Field label="Cases invoiced" kind="int" value={String(line.quantity)} disabled={disabled} onSave={save(line, 'casesShipped', 'int')} />
              <Field label="Cases backordered" kind="int" value={String(line.casesBackordered)} disabled={disabled} onSave={save(line, 'casesBackordered', 'int')} /><Field label="Cases rejected" kind="int" value={String(line.casesRejected)} disabled={disabled} onSave={save(line, 'casesRejected', 'int')} />
              <Field label="Loose bottles received" kind="int" value={String(line.looseUnitsReceived)} disabled={disabled} onSave={save(line, 'looseUnitsReceived', 'int')} /><Field label="Bonus / free bottles" kind="int" value={String(line.bonusUnits)} disabled={disabled} onSave={save(line, 'bonusUnits', 'int')} />
              <Field label="Damaged bottles" kind="int" value={String(line.unitsDamaged)} disabled={disabled} onSave={save(line, 'unitsDamaged', 'int')} /><Field label="Broken bottles" kind="int" value={String(line.unitsBroken)} disabled={disabled} onSave={save(line, 'unitsBroken', 'int')} /><Field label="Missing bottles" kind="int" value={String(line.unitsMissing)} disabled={disabled} onSave={save(line, 'unitsMissing', 'int')} />
              <label className="rt-field">Damaged / broken units are<select aria-label="Damage disposition" disabled={disabled} value={line.damageDisposition ?? ''} onChange={(event) => void onSave(line.id, { damageDisposition: event.target.value || null })}><option value="">Choose…</option>{DISPOSITIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
              <p className="hint rt-sum">{row.quantities.receivedUnits} bottles received → <strong>{row.quantities.sellableUnits} sellable</strong>{row.quantities.damagedUnits ? `, ${row.quantities.damagedUnits} damaged` : ''}{row.quantities.rejectedUnits ? `, ${row.quantities.rejectedUnits} rejected` : ''}{row.quantities.backorderedUnits ? `, ${row.quantities.backorderedUnits} on backorder` : ''}</p>
            </fieldset>
            <fieldset><legend>Cost and discounts (per case)</legend>
              <Field label="List case price ($)" kind="money" value={minorToDollars(line.listCaseMinor)} disabled={disabled} onSave={save(line, 'listCaseMinor', 'money')} hint="Printed list/base price" /><Field label="Unit list price ($)" kind="money" value={minorToDollars(line.unitListMinor)} disabled={disabled} onSave={save(line, 'unitListMinor', 'money')} />
              <Field label="Post-off ($)" kind="money" value={minorToDollars(line.postOffPerCaseMinor)} disabled={disabled} onSave={save(line, 'postOffPerCaseMinor', 'money')} /><Field label="Quantity discount ($)" kind="money" value={minorToDollars(line.qtyDiscountPerCaseMinor)} disabled={disabled} onSave={save(line, 'qtyDiscountPerCaseMinor', 'money')} />
              <Field label="Case discount ($)" kind="money" value={minorToDollars(line.caseDiscountPerCaseMinor)} disabled={disabled} onSave={save(line, 'caseDiscountPerCaseMinor', 'money')} /><Field label="Promotional discount ($)" kind="money" value={minorToDollars(line.promoDiscountPerCaseMinor)} disabled={disabled} onSave={save(line, 'promoDiscountPerCaseMinor', 'money')} />
              <Field label="Other discount ($)" kind="money" value={minorToDollars(line.otherDiscountPerCaseMinor)} disabled={disabled} onSave={save(line, 'otherDiscountPerCaseMinor', 'money')} /><Field label="Allowance ($)" kind="money" value={minorToDollars(line.allowancePerCaseMinor)} disabled={disabled} onSave={save(line, 'allowancePerCaseMinor', 'money')} hint="Lowers true cost, not the invoice" /><Field label="Rebate ($)" kind="money" value={minorToDollars(line.rebatePerCaseMinor)} disabled={disabled} onSave={save(line, 'rebatePerCaseMinor', 'money')} />
              <Field label="RIP code" value={line.ripCode ?? ''} disabled={disabled} onSave={save(line, 'ripCode')} hint="Kept as printed" /><Field label="RIP value ($)" kind="money" value={minorToDollars(line.ripValueMinor)} disabled={disabled} onSave={save(line, 'ripValueMinor', 'money')} />
              <Field label="Printed line total ($)" kind="money" value={minorToDollars(line.lineTotalMinor)} disabled={disabled} onSave={save(line, 'lineTotalMinor', 'money')} />
              <label className="rt-check"><input type="checkbox" disabled={disabled} checked={line.temporaryDeal} onChange={(event) => void onSave(line.id, { temporaryDeal: event.target.checked })} /> Temporary deal price</label>
              {line.temporaryDeal && <><Field label="Standard case cost ($)" kind="money" value={minorToDollars(line.standardCaseCostMinor)} disabled={disabled} onSave={save(line, 'standardCaseCostMinor', 'money')} hint="Used if you update vendor cost" /><Field label="Deal ends" value={line.dealEndsAt?.slice(0, 10) ?? ''} disabled={disabled} onSave={(next) => void onSave(line.id, { dealEndsAt: next ? new Date(next).toISOString() : null })} hint="YYYY-MM-DD" /></>}
              <dl className="calc compact"><div><dt>Base case</dt><dd>{show(row.economics.baseCaseMinor)}</dd></div><div><dt>Net case</dt><dd>{show(row.economics.netCaseMinor)}</dd></div><div><dt>Effective case</dt><dd>{show(row.economics.effectiveCaseMinor)}</dd></div><div><dt>Net unit</dt><dd>{show(row.economics.netUnitMinor)}</dd></div></dl>
            </fieldset>
            <fieldset><legend>Cost change and retail impact</legend>
              {cost && cost.previousCaseMinor !== null ? <dl className="calc compact"><div><dt>Previous case cost</dt><dd>{show(cost.previousCaseMinor)}</dd></div><div><dt>Invoice case cost</dt><dd>{show(cost.invoiceCaseMinor)}</dd></div><div><dt>Change</dt><dd className={cost.significant ? 'rt-bad' : ''}>{cost.deltaMinor && BigInt(cost.deltaMinor) >= 0n ? '+' : ''}{show(cost.deltaMinor)} / {pct(cost.deltaBasisPoints)}</dd></div></dl> : <p className="hint">No vendor cost on file for comparison.</p>}
              {cost && cost.retailMinor !== null && <dl className="calc compact"><div><dt>Current retail</dt><dd>{show(cost.retailMinor)}</dd></div><div><dt>Previous margin</dt><dd>{pct(cost.previousMarginBasisPoints)}</dd></div><div><dt>New margin</dt><dd className={cost.marginDropBasisPoints && cost.marginDropBasisPoints > 0 ? 'rt-bad' : ''}>{pct(cost.newMarginBasisPoints)}</dd></div></dl>}
              {cost && cost.significant && line.variantId && <p className="hint"><a href={`/admin/product/?id=${line.variantId}`}>Review pricing</a> after confirming. Retail prices are never changed automatically.</p>}
              <label className="rt-check"><input type="checkbox" disabled={disabled} checked={line.updateVendorCost} onChange={(event) => void onSave(line.id, { updateVendorCost: event.target.checked })} /> Make this the vendor&apos;s current cost{line.temporaryDeal ? ' (uses the standard cost above)' : ''}</label>
              <Field label="Notes" value={line.notes ?? ''} disabled={disabled} onSave={save(line, 'notes')} />
            </fieldset>
            <fieldset><legend>What the vendor printed</legend>
              {line.evidence && Object.values(line.evidence).some((entry) => entry.label !== 'DERIVED') ? <table className="line-table compact"><thead><tr><th>Field</th><th>Vendor label</th><th>Printed</th><th>Confidence</th></tr></thead><tbody>{Object.entries(line.evidence).filter(([, entry]) => entry.label !== 'DERIVED').map(([key, entry]) => <tr key={key}><td>{key}</td><td>{entry.label ?? '—'}</td><td>{entry.original ?? entry.normalized ?? '—'}{entry.corrected ? <small className="stack">corrected to {entry.corrected}</small> : null}</td><td>{entry.confidence === undefined ? '—' : `${Math.round(entry.confidence * 100)}%`}</td></tr>)}</tbody></table> : <p className="hint">Entered by hand (no printed evidence).</p>}
              {line.correctedFields && Object.keys(line.correctedFields).length > 0 && <p className="hint">Corrected: {Object.entries(line.correctedFields).map(([key, change]) => `${key} ${String(change.from ?? '—')} → ${String(change.to ?? '—')}`).join('; ')}</p>}
            </fieldset>
            <fieldset><legend>Vendor claim</legend>
              <label className="rt-field">Type<select value={claim.kind} onChange={(event) => setClaim({ ...claim, kind: event.target.value })}>{CLAIM_KINDS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
              <label className="rt-field">Units<input inputMode="numeric" value={claim.quantity} onChange={(event) => setClaim({ ...claim, quantity: event.target.value.replace(/\D/g, '') })} /></label>
              <label className="rt-field">Amount per unit ($)<input inputMode="decimal" value={claim.unit} placeholder={minorToDollars(row.economics.effectiveUnitMinor)} onChange={(event) => setClaim({ ...claim, unit: event.target.value.replace(/[^\d.]/g, '') })} /></label>
              <label className="rt-field">Reason<input value={claim.reason} onChange={(event) => setClaim({ ...claim, reason: event.target.value })} /></label>
              <button disabled={disabled || !claim.reason.trim() || !/^[1-9]\d*$/.test(claim.quantity)} onClick={() => { const minor = claim.unit ? dollarsToMinor(claim.unit) : row.economics.effectiveUnitMinor; if (minor) onClaim(line, { kind: claim.kind, quantity: Number(claim.quantity), unitCostMinor: minor, reason: claim.reason }); }}>Create draft claim</button>
            </fieldset>
          </div>
          <div className="rt-actions"><button disabled={disabled} onClick={() => void onSave(line.id, { ignored: !line.ignored })}>{line.ignored ? 'Restore line' : 'Ignore line'}</button><button className="danger" disabled={disabled} onClick={() => { if (window.confirm('Remove this line from the invoice?')) onRemove(line.id); }}>Remove line</button></div>
        </td></tr>}
      </Fragment>;
    })}{productLines.length === 0 && <tr><td colSpan={15}>No product lines yet. Add one below.</td></tr>}</tbody></table></div>;
}
