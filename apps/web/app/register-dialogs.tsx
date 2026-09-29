'use client';

import { useEffect, useState } from 'react';
import { api, friendlyError, money, parseDollarsToMinor, parsePercentToBasisPoints, type PriceAdjustment } from './register-api';

export type Elevation = { token: string; expiresAt: string; approver: { id: string; name: string; role: string } };
export type ShiftReport = {
  sessionId: string; status: string; openedAt: string; closedAt: string | null; durationMinutes: number;
  openingCashMinor: string; expectedCashMinor: string | null; countedCashMinor: string | null; differenceMinor: string | null;
  detail?: {
    transactionCount: number; sales: { cashMinor: string; cardMinor: string; giftCardMinor: string; loyaltyMinor: string };
    refunds: { count: number; totalMinor: string }; voids: { count: number; totalMinor: string }; discountsMinor: string;
    channels: Array<{ channel: string; orderCount: number; totalMinor: string }>;
  };
};
export type CustomerRecord = { id: string; name: string; email: string | null; phone: string | null; pointsBalance?: number };
type DiscountLine = { variantId: string; productName: string; variantName: string; priceMinor: string | null; quantity: number };

export const isElevationActive = (elevation: Elevation | null): elevation is Elevation => Boolean(elevation && new Date(elevation.expiresAt).getTime() > Date.now());

/** Manager/Owner picks their name and enters a PIN; the server issues a short-lived approval token. */
export function ElevationDialog({ reason, onGranted }: { reason: string; onGranted: (elevation: Elevation) => void }): React.ReactNode {
  const [approvers, setApprovers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [approverId, setApproverId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Array<{ id: string; name: string; role: string }>>('/auth/approvers')
      .then((rows) => { setApprovers(rows); setApproverId(rows[0]?.id ?? ''); })
      .catch((cause) => setError(friendlyError(cause, 'Could not load managers.')));
  }, []);
  async function submit(): Promise<void> {
    setBusy(true); setError('');
    try { onGranted(await api<Elevation>('/auth/elevate', { method: 'POST', body: JSON.stringify({ employeeId: approverId, pin }) })); }
    catch (cause) { setError(friendlyError(cause, 'Approval failed.')); setPin(''); }
    finally { setBusy(false); }
  }
  return <>
    <h2>Manager approval</h2><p>{reason}</p>
    {approvers.length === 0 && !error && <p>Loading managers…</p>}
    {approvers.length === 0 && error && <p className="warning">{error}</p>}
    {approvers.length > 0 && <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="approver-list" role="radiogroup" aria-label="Approver">{approvers.map((approver) =>
        <button type="button" role="radio" aria-checked={approver.id === approverId} className={`held-sale${approver.id === approverId ? ' selected' : ''}`} key={approver.id} onClick={() => setApproverId(approver.id)}><strong>{approver.name}</strong><span>{approver.role === 'OWNER' ? 'Owner' : 'Manager'}</span></button>)}</div>
      <label>PIN<input aria-label="Manager PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={8} autoFocus value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} /></label>
      {error && <p className="warning" role="alert">{error}</p>}
      <button className="primary" disabled={busy || pin.length < 4 || !approverId}>Approve</button>
    </form>}
  </>;
}

/** Percentage, dollar-amount, or custom-price adjustment for the whole cart or one line. No reason is required. */
export function DiscountDialog({ lines, onApply, onClear, hasAdjustments }: {
  lines: DiscountLine[]; hasAdjustments: boolean;
  onApply: (target: { scope: 'cart' } | { scope: 'line'; variantId: string }, adjustment: PriceAdjustment) => void; onClear: () => void;
}): React.ReactNode {
  const [target, setTarget] = useState('cart');
  const [mode, setMode] = useState<'percent' | 'amount' | 'price'>('percent');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const line = lines.find((candidate) => candidate.variantId === target);
  const effectiveMode = target === 'cart' && mode === 'price' ? 'percent' : mode;
  function apply(): void {
    setError('');
    if (effectiveMode === 'percent') {
      const basisPoints = parsePercentToBasisPoints(value);
      if (basisPoints === null) return setError('Enter a percentage from 0 to 100, for example 10.');
      return onApply(line ? { scope: 'line', variantId: line.variantId } : { scope: 'cart' }, { mode: 'percent', basisPoints });
    }
    const minor = parseDollarsToMinor(value);
    if (minor === null) return setError('Enter a dollar amount, for example 3.25.');
    if (effectiveMode === 'price') {
      if (!line || line.priceMinor === null) return setError('Choose an item for a custom price.');
      if (minor > BigInt(line.priceMinor)) return setError(`Custom price cannot be higher than the current price (${money(line.priceMinor)}).`);
      return onApply({ scope: 'line', variantId: line.variantId }, { mode: 'price', priceMinor: minor });
    }
    onApply(line ? { scope: 'line', variantId: line.variantId } : { scope: 'cart' }, { mode: 'amount', amountMinor: minor });
  }
  return <>
    <h2>Discount / custom price</h2>
    <label>Apply to<select aria-label="Discount target" value={target} onChange={(event) => setTarget(event.target.value)}><option value="cart">Whole sale</option>{lines.map((item) => <option key={item.variantId} value={item.variantId}>{item.productName} · {item.variantName}</option>)}</select></label>
    <div className="mode-tabs" role="tablist">{([['percent', '% off'], ['amount', '$ off'], ['price', 'Custom price']] as const).map(([key, label]) =>
      <button type="button" role="tab" key={key} aria-selected={effectiveMode === key} disabled={key === 'price' && target === 'cart'} className={effectiveMode === key ? 'active' : ''} onClick={() => { setMode(key); setValue(''); setError(''); }}>{label}</button>)}</div>
    <label>{effectiveMode === 'percent' ? 'Percent off' : effectiveMode === 'amount' ? 'Dollars off' : 'New price per item'}<input aria-label="Discount value" inputMode="decimal" autoFocus placeholder={effectiveMode === 'percent' ? '10' : '3.25'} value={value} onChange={(event) => setValue(event.target.value.replace(effectiveMode === 'percent' ? /[^\d.%]/g : /[^\d.$]/g, ''))} /></label>
    {error && <p className="warning" role="alert">{error}</p>}
    <button className="primary" onClick={apply}>Apply</button>
    {hasAdjustments && <button className="quiet" onClick={onClear}>Remove all discounts</button>}
  </>;
}

export function CustomerCreateForm({ onCreated }: { onCreated: (customer: CustomerRecord) => void }): React.ReactNode {
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [email, setEmail] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(): Promise<void> {
    setBusy(true); setError('');
    try {
      onCreated(await api<CustomerRecord>('/customers', { method: 'POST', body: JSON.stringify({ name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) }) }));
    } catch (cause) { setError(friendlyError(cause, 'Could not create the customer.')); } finally { setBusy(false); }
  }
  return <>
    <h2>New customer</h2>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>Name<input aria-label="Customer name" autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Phone (optional)<input aria-label="Customer phone" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
      <label>Email (optional)<input aria-label="Customer email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      {error && <p className="warning" role="alert">{error}</p>}
      <button className="primary" disabled={busy || !name.trim()}>Save and select customer</button>
    </form>
  </>;
}

export function OpenRegisterDialog({ onOpen }: { onOpen: (openingCashMinor: bigint, note: string) => void }): React.ReactNode {
  const [cash, setCash] = useState('100.00'); const [note, setNote] = useState('');
  const minor = parseDollarsToMinor(cash);
  return <>
    <h2>Open register</h2>
    <form onSubmit={(event) => { event.preventDefault(); if (minor !== null) onOpen(minor, note); }}>
      <label>Opening cash in drawer<input aria-label="Opening cash" inputMode="decimal" autoFocus value={cash} onChange={(event) => setCash(event.target.value.replace(/[^\d.$]/g, ''))} /></label>
      <label>Note (optional)<input aria-label="Opening note" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      {minor === null && <p className="warning" role="alert">Enter the cash amount, for example 100.00.</p>}
      <button className="primary" disabled={minor === null}>Open register</button>
    </form>
  </>;
}

const minutes = (value: number) => `${Math.floor(value / 60)}h ${value % 60}m`;

export function ShiftReportView({ report }: { report: ShiftReport }): React.ReactNode {
  const row = (label: string, value: string | null) => <div className="receipt-line" key={label}><span>{label}</span><b>{value === null ? '—' : money(value)}</b></div>;
  const detail = report.detail;
  return <>
    <h2>Shift closed</h2>
    <p>Opened {new Date(report.openedAt).toLocaleString()} · {minutes(report.durationMinutes)}</p>
    {row('Opening cash', report.openingCashMinor)}{row('Expected cash', report.expectedCashMinor)}{row('Counted cash', report.countedCashMinor)}
    <div className="receipt-line grand"><span>Difference</span><b>{report.differenceMinor === null ? '—' : `${BigInt(report.differenceMinor) > 0n ? '+' : ''}${money(report.differenceMinor)}`}</b></div>
    {detail && <section aria-label="Detailed shift report">
      <hr /><h3>Sales by tender</h3>
      {row('Cash sales', detail.sales.cashMinor)}{row('Card sales', detail.sales.cardMinor)}{row('Gift card', detail.sales.giftCardMinor)}{row('Loyalty', detail.sales.loyaltyMinor)}
      <div className="receipt-line"><span>Transactions</span><b>{detail.transactionCount}</b></div>
      <div className="receipt-line"><span>Refunds ({detail.refunds.count})</span><b>{money(detail.refunds.totalMinor)}</b></div>
      <div className="receipt-line"><span>Voids ({detail.voids.count})</span><b>{money(detail.voids.totalMinor)}</b></div>
      {row('Discounts given', detail.discountsMinor)}
      <h3>Sales by channel</h3>
      {detail.channels.map((channel) => <div className="receipt-line" key={channel.channel}><span>{channel.channel.replace(/_/g, ' ').toLowerCase()} ({channel.orderCount})</span><b>{money(channel.totalMinor)}</b></div>)}
    </section>}
  </>;
}
