'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, money, type Store } from '../admin-client';
import { dayCloseApi, type DayTotals } from '../costing-client';
import '../admin.css';
import '../costing.css';

const ERRORS: Record<string, string> = {
  DAY_ALREADY_CLOSED: 'This day was already finalized. The stored report cannot be changed.', OPEN_REGISTERS_REQUIRE_ACKNOWLEDGEMENT: 'Registers are still open. Close them, or acknowledge and finalize anyway.',
  BUSINESS_DATE_IN_FUTURE: 'You cannot close a day that has not happened yet.', BUSINESS_DATE_INVALID: 'Pick a valid date.', FORBIDDEN: 'Only an Owner or Manager can close the day.',
};
const today = () => new Date().toLocaleDateString('en-CA');

function Report({ totals }: { totals: DayTotals }): React.ReactNode {
  const line = (label: string, value: string | number, strong = false) => <div className={strong ? 'strong' : ''} key={label}><dt>{label}</dt><dd>{typeof value === 'number' ? value : money(value)}</dd></div>;
  return <div aria-label="Z report">
    <section className="wizard-section"><h2>{totals.storeName} · {totals.businessDate}</h2>
      <dl className="calc">{line('Gross sales', totals.grossSalesMinor)}{line('Discounts', totals.discountsMinor)}{line('Refunds', totals.refundsMinor)}{line('Net sales', totals.netSalesMinor, true)}{line('Tax collected', totals.taxMinor)}{line('Transactions', totals.transactionCount)}</dl>
      <p className="hint">Net sales = gross − discounts − refunds (refunds include the tax refunded). Voids ({totals.voids.count}, {money(totals.voids.totalMinor)}) are excluded from sales.</p></section>
    <section className="wizard-section"><h3>Tenders</h3><dl className="calc">{line('Cash', totals.tenders.cashMinor)}{line('Card', totals.tenders.cardMinor)}{line('Gift card', totals.tenders.giftCardMinor)}{line('Other (loyalty)', totals.tenders.otherMinor)}</dl></section>
    <section className="wizard-section"><h3>Cash</h3><dl className="calc">{line('Cash sales', totals.cash.cashSalesMinor)}{line('Cash refunds', totals.cash.cashRefundsMinor)}{line('Paid in', totals.cash.paidInMinor)}{line('Paid out', totals.cash.paidOutMinor)}{line('Safe drops', totals.cash.safeDropsMinor)}{line('Adjustments (net)', totals.cash.adjustmentsNetMinor)}{line('Drawer opens', totals.cash.drawerOpens)}{line('Register differences', totals.registerDifferenceMinor, true)}</dl></section>
    <section className="wizard-section"><h3>Register sessions</h3>
      <table className="line-table"><thead><tr><th>Register</th><th>Status</th><th>Opened</th><th>Closed</th><th>Expected</th><th>Counted</th><th>Difference</th></tr></thead><tbody>
        {totals.registerSessions.length === 0 ? <tr><td colSpan={7}>No register sessions on this day.</td></tr> : totals.registerSessions.map((session, index) => <tr key={index}><td>{session.registerName}</td><td>{session.status}</td><td>{new Date(session.openedAt).toLocaleTimeString()}</td><td>{session.closedAt ? new Date(session.closedAt).toLocaleTimeString() : '—'}</td>
          <td>{session.expectedCashMinor ? money(session.expectedCashMinor) : '—'}</td><td>{session.countedCashMinor ? money(session.countedCashMinor) : '—'}</td><td>{session.differenceMinor ? money(session.differenceMinor) : '—'}</td></tr>)}</tbody></table></section>
  </div>;
}

/** Store/day closeout (Z report). Finalizing stores an immutable snapshot; a business date can be finalized once. */
export default function DayClosePage(): React.ReactNode {
  const [stores, setStores] = useState<Store[]>([]); const [storeId, setStoreId] = useState(''); const [date, setDate] = useState(today());
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof dayCloseApi.preview>> | null>(null); const [history, setHistory] = useState<Awaited<ReturnType<typeof dayCloseApi.history>>>([]);
  const [acknowledge, setAcknowledge] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void adminApi.stores().then((rows) => { setStores(rows); setStoreId((current) => current || rows[0]?.id || ''); }).catch(() => setError('Could not load stores.')); }, []);
  const load = useCallback(async () => {
    if (!storeId) return;
    setError(''); setAcknowledge(false);
    try { const [result, past] = await Promise.all([dayCloseApi.preview(storeId, date), dayCloseApi.history(storeId)]); setPreview(result); setHistory(past); }
    catch (cause) { setPreview(null); setError(ERRORS[cause instanceof Error ? cause.message : ''] ?? (cause instanceof Error ? cause.message : 'Could not load the report.')); }
  }, [storeId, date]);
  useEffect(() => { void load(); }, [load]);
  async function finalize(): Promise<void> {
    if (!window.confirm(`Finalize ${date}? The report will be stored and cannot be changed.`)) return;
    setBusy(true); setError(''); setMessage('');
    try { await dayCloseApi.finalize({ storeId, businessDate: date, acknowledgeOpenRegisters: acknowledge }); setMessage(`${date} finalized.`); await load(); }
    catch (cause) { setError(ERRORS[cause instanceof Error ? cause.message : ''] ?? (cause instanceof Error ? cause.message : 'Could not finalize.')); }
    finally { setBusy(false); }
  }
  const open = preview?.totals.openRegisters ?? [];
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Operations</span><h1>End of day (Z report)</h1></div><button onClick={() => window.print()}>Print</button></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <section className="wizard-section"><form className="inline-form" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <label>Store<select aria-label="Store" value={storeId} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      <label>Business date<input aria-label="Business date" type="date" value={date} max={today()} onChange={(event) => setDate(event.target.value)} /></label>
      <button className="primary">Refresh</button></form></section>
    {preview?.finalized && <p className="admin-alert success">Finalized {new Date(preview.finalized.closedAt).toLocaleString()}. This stored report is read-only.</p>}
    {!preview?.finalized && open.length > 0 && <div className="admin-alert error" role="alert"><strong>{open.length} register{open.length === 1 ? ' is' : 's are'} still open:</strong> {open.map((session) => session.registerName).join(', ')}.
      <label className="check"><input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} /> Finalize anyway; open registers are not included as closed.</label></div>}
    {preview && <Report totals={preview.totals} />}
    {preview && !preview.finalized && <footer className="wizard-actions"><span className="hint">Finalizing stores this report permanently.</span><button className="primary big" disabled={busy || (open.length > 0 && !acknowledge)} onClick={() => void finalize()}>Finalize day</button></footer>}
    <section className="wizard-section"><h2>Closed days</h2><table className="line-table"><thead><tr><th>Date</th><th>Closed</th><th>Net sales</th><th>Transactions</th><th>Open registers</th><th /></tr></thead><tbody>
      {history.length === 0 ? <tr><td colSpan={6}>No closed days yet.</td></tr> : history.map((close) => <tr key={close.id}><td>{close.businessDate}</td><td>{new Date(close.closedAt).toLocaleString()}</td><td>{money(close.totals.netSalesMinor)}</td><td>{close.totals.transactionCount}</td><td>{close.openRegisterCount}</td><td><button onClick={() => setDate(close.businessDate)}>View</button></td></tr>)}</tbody></table></section>
  </main>;
}
