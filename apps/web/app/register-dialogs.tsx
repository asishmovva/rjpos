'use client';

import { useEffect, useRef, useState } from 'react';
import { api, friendlyError, money, parseDollarsToMinor, parsePercentToBasisPoints, type PriceAdjustment } from './register-api';
import { evaluateBirthDate, formatUsDate, latestEligibleBirthDate, todayInZone, type AgeResult } from './age';

export type Elevation = { token: string; expiresAt: string; approver: { id: string; name: string; role: string } };
export type ShiftReport = {
  sessionId: string; status: string; openedAt: string; closedAt: string | null; durationMinutes: number;
  openingCashMinor: string; expectedCashMinor: string | null; countedCashMinor: string | null; differenceMinor: string | null;
  detail?: {
    transactionCount: number; sales: { cashMinor: string; cardMinor: string; giftCardMinor: string; loyaltyMinor: string };
    refunds: { count: number; totalMinor: string }; voids: { count: number; totalMinor: string }; discountsMinor: string;
    cash: { openingMinor: string; cashSalesMinor: string; cashRefundsMinor: string; paidInMinor: string; paidOutMinor: string; safeDropsMinor: string; adjustmentsNetMinor: string; drawerOpens: number; expectedMinor: string };
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
      <hr /><h3>Drawer cash</h3>
      {row('Opening cash', detail.cash.openingMinor)}{row('Cash sales', detail.cash.cashSalesMinor)}{row('Cash refunds', detail.cash.cashRefundsMinor)}{row('Paid in', detail.cash.paidInMinor)}{row('Paid out', detail.cash.paidOutMinor)}{row('Safe drops', detail.cash.safeDropsMinor)}{row('Adjustments (net)', detail.cash.adjustmentsNetMinor)}
      <div className="receipt-line"><span>Drawer opens (no sale)</span><b>{detail.cash.drawerOpens}</b></div>
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

/**
 * Compact age tool: the latest eligible birth date, a typed date of birth, and an explicit CHECK AGE step.
 * The date of birth lives only in this component's state; it is never stored or sent anywhere.
 */
export function AgeCheckDialog({ timeZone, needsVerification, alreadyVerified, onVerified, onClose }: {
  timeZone: string | undefined; needsVerification: boolean; alreadyVerified: boolean; onVerified: () => void; onClose: () => void;
}): React.ReactNode {
  const today = todayInZone(timeZone);
  const [dob, setDob] = useState({ month: '', day: '', year: '' });
  const [result, setResult] = useState<AgeResult | null>(null);
  const dayRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  function edit(key: 'month' | 'day' | 'year', value: string): void {
    const digits = value.replace(/\D/g, '');
    setDob((current) => ({ ...current, [key]: digits }));
    setResult(null);
    if (key === 'month' && digits.length === 2) dayRef.current?.focus();
    if (key === 'day' && digits.length === 2) yearRef.current?.focus();
  }
  function check(): void { setResult(evaluateBirthDate(dob, today)); }
  const eligible = result?.status === 'ok' && result.eligible;
  return <>
    <div className="age-title"><h2>AGE CHECK</h2><button className="close" aria-label="Close" onClick={onClose}>×</button></div>
    <p className="age-cutoff">Must be born on or before<strong>{formatUsDate(latestEligibleBirthDate(today))}</strong></p>
    <form className="dob-fields" onSubmit={(event) => { event.preventDefault(); check(); }}>
      <label>Month<input aria-label="Month" inputMode="numeric" maxLength={2} autoFocus placeholder="MM" value={dob.month} onChange={(event) => edit('month', event.target.value)} /></label>
      <label>Day<input aria-label="Day" ref={dayRef} inputMode="numeric" maxLength={2} placeholder="DD" value={dob.day} onChange={(event) => edit('day', event.target.value)} /></label>
      <label>Year<input aria-label="Year" ref={yearRef} inputMode="numeric" maxLength={4} placeholder="YYYY" value={dob.year} onChange={(event) => edit('year', event.target.value)} /></label>
      <button className="check-age" type="submit">CHECK AGE</button>
    </form>
    <div className="age-outcome" role="status">
      {result?.status === 'incomplete' && <p className="age-result neutral">Enter month, day, and a 4-digit year.</p>}
      {result?.status === 'invalid' && <p className="age-result ineligible">{result.reason}</p>}
      {result?.status === 'ok' && <p className={`age-result ${result.eligible ? 'eligible' : 'ineligible'}`}>{result.eligible ? `ELIGIBLE — Age ${result.age}` : `NOT ELIGIBLE — Age ${result.age}`}</p>}
      {!result && alreadyVerified && needsVerification && <p className="age-result eligible">Age already confirmed for this sale.</p>}
    </div>
    {eligible && needsVerification && !alreadyVerified && <button className="confirm-age" onClick={onVerified}>CONFIRM AGE CHECK</button>}
  </>;
}

/** Find, select, or remove the customer for this sale (and redeem loyalty points). New customers use the create form. */
export function CustomerDialog({ customer, program, points, projectedEarn, search, results, onSearch, onFind, onSelect, onNew, onRemove, onPoints, onClose }: {
  customer: CustomerRecord | null; program: { enabled: boolean } | null; points: number; projectedEarn: number; search: string; results: CustomerRecord[];
  onSearch: (value: string) => void; onFind: () => void; onSelect: (customer: CustomerRecord) => void; onNew: () => void; onRemove: () => void; onPoints: (points: number) => void; onClose: () => void;
}): React.ReactNode {
  return <>
    <h2>Customer</h2>
    {customer ? <>
      <div className="customer-card"><strong>{customer.name}</strong><span>{customer.pointsBalance ?? 0} points · projected earn {projectedEarn}</span></div>
      {program?.enabled && <label>Redeem loyalty points<input aria-label="Loyalty points" type="number" inputMode="numeric" min="0" max={customer.pointsBalance ?? 0} value={points || ''} placeholder="0" onChange={(event) => onPoints(Number(event.target.value) || 0)} /></label>}
      <button className="danger" onClick={() => { onRemove(); onClose(); }}>Remove customer</button>
      <button className="primary" onClick={onClose}>Done</button>
    </> : <>
      <form className="customer-search" onSubmit={(event) => { event.preventDefault(); onFind(); }}>
        <input aria-label="Customer search" autoFocus placeholder="Name, phone, or email" value={search} onChange={(event) => onSearch(event.target.value)} />
        <button>Find</button>
      </form>
      <div className="customer-results">{results.map((result) => <button className="held-sale" key={result.id} onClick={() => onSelect(result)}><strong>{result.name}</strong><span>{result.phone || result.email || 'No contact'}</span></button>)}</div>
      <button onClick={onNew}>New customer</button>
    </>}
  </>;
}

/** Gift card code and the amount to redeem (entered in dollars, held as cents). */
export function GiftCardDialog({ code, amountMinor, onApply, onClear }: { code: string; amountMinor: string; onApply: (code: string, amountMinor: string) => void; onClear: () => void }): React.ReactNode {
  const [giftCode, setGiftCode] = useState(code);
  const [amount, setAmount] = useState(amountMinor !== '0' && /^\d+$/.test(amountMinor) ? (Number(amountMinor) / 100).toFixed(2) : '');
  const minor = parseDollarsToMinor(amount);
  return <>
    <h2>Gift card</h2>
    <form onSubmit={(event) => { event.preventDefault(); if (minor !== null && minor > 0n && giftCode.trim()) onApply(giftCode.trim(), minor.toString()); }}>
      <label>Gift-card code<input aria-label="Gift-card code" autoFocus autoComplete="off" value={giftCode} onChange={(event) => setGiftCode(event.target.value)} /></label>
      <label>Amount to redeem ($)<input aria-label="Gift-card amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.$]/g, ''))} /></label>
      {amount && (minor === null || minor === 0n) && <p className="warning" role="alert">Enter an amount greater than zero, for example 25.00.</p>}
      <button className="primary" disabled={!giftCode.trim() || minor === null || minor === 0n}>Apply gift card</button>
    </form>
    {(code || amountMinor !== '0') && <button className="quiet" onClick={onClear}>Remove gift card</button>}
  </>;
}

const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const;
/** Touch keypad for a custom cash tender, with the change preview updating as digits are entered. */
export function TenderDialog({ dueMinor, onSet }: { dueMinor: bigint; onSet: (tenderedMinor: bigint) => void }): React.ReactNode {
  const [text, setText] = useState('');
  const minor = parseDollarsToMinor(text);
  const short = minor !== null && minor < dueMinor;
  function press(key: (typeof KEYPAD_KEYS)[number]): void {
    setText((current) => {
      if (key === '⌫') return current.slice(0, -1);
      if (key === '.') return current.includes('.') ? current : `${current || '0'}.`;
      const next = current + key;
      return parseDollarsToMinor(next) === null ? current : next;
    });
  }
  return <>
    <h2>Cash tendered</h2>
    <div className="tender-display" aria-live="polite"><span>Amount due</span><b>{money(dueMinor)}</b></div>
    <div className="tender-display"><span>Tendered</span><b aria-label="Tendered amount">{text ? `$${text}` : '$0.00'}</b></div>
    <div className={`tender-display change ${short ? 'short' : ''}`}><span>{short ? 'Still due' : 'Change due'}</span><b>{minor === null ? '$0.00' : money(short ? dueMinor - minor : minor - dueMinor)}</b></div>
    <div className="keypad">{KEYPAD_KEYS.map((key) => <button type="button" key={key} onClick={() => press(key)}>{key}</button>)}</div>
    <button className="primary" disabled={minor === null || short} onClick={() => minor !== null && onSet(minor)}>Use this amount</button>
  </>;
}

export type SaleSummary = { totalMinor: string; tenderedMinor: string; changeDueMinor: string };
/** Full-screen confirmation after a cash sale: change due is the largest thing on screen. */
export function SaleCompleteDialog({ summary, onDone, onReceipt }: { summary: SaleSummary; onDone: () => void; onReceipt: () => void }): React.ReactNode {
  return <section className="sale-complete">
    <h2>SALE COMPLETE</h2>
    <div className="sale-line"><span>Total</span><b>{money(summary.totalMinor)}</b></div>
    <div className="sale-line"><span>Cash Tendered</span><b>{money(summary.tenderedMinor)}</b></div>
    <div className="change-due"><span>CHANGE DUE</span><b aria-label="Change due">{money(summary.changeDueMinor)}</b></div>
    <button className="primary done" autoFocus onClick={onDone}>DONE / NEXT SALE</button>
    <button className="quiet" onClick={onReceipt}>View receipt</button>
  </section>;
}

export type CashKind = 'PAID_IN' | 'PAID_OUT' | 'SAFE_DROP' | 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT';
const CASH_OPTIONS: Array<{ kind: CashKind; label: string; reasonRequired: boolean; needsApproval: boolean }> = [
  { kind: 'PAID_IN', label: 'Paid in', reasonRequired: false, needsApproval: false },
  { kind: 'SAFE_DROP', label: 'Safe drop', reasonRequired: false, needsApproval: false },
  { kind: 'PAID_OUT', label: 'Paid out', reasonRequired: true, needsApproval: true },
  { kind: 'ADJUSTMENT_IN', label: 'Adjust +', reasonRequired: true, needsApproval: true },
  { kind: 'ADJUSTMENT_OUT', label: 'Adjust −', reasonRequired: true, needsApproval: true },
];
export const cashKindNeedsApproval = (kind: CashKind): boolean => CASH_OPTIONS.find((option) => option.kind === kind)?.needsApproval ?? true;

/** Drawer cash operations. Paid in and safe drops are open to cashiers; paid out, adjustments, and no-sale need a manager. */
export function CashOperationsDialog({ isManager, onSubmit, onNoSale }: { isManager: boolean; onSubmit: (kind: CashKind, amountMinor: bigint, reason: string) => void; onNoSale: () => void }): React.ReactNode {
  const [kind, setKind] = useState<CashKind>('PAID_IN'); const [amount, setAmount] = useState(''); const [reason, setReason] = useState('');
  const option = CASH_OPTIONS.find((candidate) => candidate.kind === kind)!;
  const minor = parseDollarsToMinor(amount);
  const valid = minor !== null && minor > 0n && (!option.reasonRequired || reason.trim().length > 0);
  return <>
    <h2>Cash &amp; drawer</h2>
    <div className="mode-tabs" role="tablist" aria-label="Cash operation">{CASH_OPTIONS.map((candidate) => <button type="button" role="tab" key={candidate.kind} aria-selected={kind === candidate.kind} className={kind === candidate.kind ? 'active' : ''} onClick={() => setKind(candidate.kind)}>{candidate.label}</button>)}</div>
    {option.needsApproval && !isManager && <p className="hint">A manager approves this when you submit.</p>}
    <form onSubmit={(event) => { event.preventDefault(); if (valid && minor !== null) onSubmit(kind, minor, reason.trim()); }}>
      <label>Amount ($)<input aria-label="Cash amount" inputMode="decimal" autoFocus value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.$]/g, ''))} placeholder="0.00" /></label>
      <label>Reason{option.reasonRequired ? ' (required)' : ' (optional)'}<input aria-label="Cash reason" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></label>
      <button className="primary" disabled={!valid}>Record {option.label.toLowerCase()}</button>
    </form>
    <button className="quiet" onClick={onNoSale}>No-sale drawer open…</button>
  </>;
}
