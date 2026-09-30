'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { errorText, phaseNineApi, type AuditView } from '../phase9-client';
import '../admin.css';
import '../costing.css';

/** Readable audit trail: who did what to which record, old and new values, when, and where. */
export default function AuditPage(): React.ReactNode {
  const [view, setView] = useState<AuditView | null>(null); const [page, setPage] = useState(1); const [action, setAction] = useState(''); const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [error, setError] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError('');
    try { setView(await phaseNineApi.audit({ page, action: action.trim(), entityType: entityType.trim(), ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}), ...(to ? { to: new Date(`${to}T23:59:59`).toISOString() } : {}) })); } catch (cause) { setError(errorText(cause)); }
  }, [page, action, entityType, from, to]);
  useEffect(() => { void load(); }, [load]);
  const pages = view ? Math.max(1, Math.ceil(view.total / view.pageSize)) : 1;
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Owner</span><h1>Audit log</h1></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}
    <form className="inline-form" onSubmit={(event) => { event.preventDefault(); setPage(1); }}>
      <label>Action<input value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }} placeholder="e.g. PRICE" /></label>
      <label>Record type<input value={entityType} onChange={(event) => { setEntityType(event.target.value); setPage(1); }} placeholder="e.g. Order" /></label>
      <label>From<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
      <label>To<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label></form>
    <section className="wizard-section" aria-label="Audit records"><table className="line-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Where</th></tr></thead><tbody>
      {view?.items.map((record) => <Fragment key={record.id}><tr><td>{new Date(record.at).toLocaleString()}</td><td>{record.user?.name ?? 'System'}</td>
        <td><button className="text" onClick={() => setOpen(open === record.id ? null : record.id)} aria-expanded={open === record.id}>{record.actionLabel}{record.changes.length > 0 ? ` (${record.changes.length})` : ''}</button></td>
        <td>{record.entityType}<small className="stack">{record.entityId.slice(0, 8)}</small></td><td>{[record.store?.name, record.register?.name].filter(Boolean).join(' · ') || '—'}</td></tr>
        {open === record.id && <tr><td colSpan={5}>{record.changes.length === 0 ? <em>No value changes recorded.</em> :
          <table className="line-table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{record.changes.map((change) => <tr key={change.field}><td>{change.field}</td><td>{change.before ?? '—'}</td><td>{change.after ?? '—'}</td></tr>)}</tbody></table>}</td></tr>}</Fragment>)}
      {view && view.items.length === 0 && <tr><td colSpan={5}>No records match.</td></tr>}</tbody></table>
      <div className="wizard-actions"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div></section>
  </main>;
}
