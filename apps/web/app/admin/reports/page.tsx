'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ADMIN_API, money, type Store } from '../admin-client';
import '../admin.css';

const sections = ['sales', 'products', 'inventory', 'purchasing', 'employees', 'customers', 'gift-cards', 'promotions'] as const;
type Section = (typeof sections)[number];
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Report = { kind: Section; filters: { from: string; toExclusive: string; timezone: string; storeId: string | null }; data: Record<string, JsonValue> };

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => { const value = new Date(); value.setUTCDate(value.getUTCDate() - 30); return value.toISOString().slice(0, 10); };
const params = (from: string, to: string, storeId: string) => new URLSearchParams({ from, to, ...(storeId ? { storeId } : {}) }).toString();

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${ADMIN_API}/admin${path}`, { headers: { 'x-rjpos-role': 'OWNER' } });
  const body = await response.json() as T & { error?: { code?: string } };
  if (!response.ok) throw new Error(body.error?.code ?? `HTTP_${response.status}`);
  return body;
}

function findRows(data: Record<string, JsonValue>): Array<Record<string, JsonValue>> {
  for (const value of Object.values(data)) {
    if (Array.isArray(value) && value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return value as Array<Record<string, JsonValue>>;
    if (value && typeof value === 'object' && !Array.isArray(value) && 'items' in value && Array.isArray(value.items)) return value.items as Array<Record<string, JsonValue>>;
  }
  return [];
}

const label = (value: string) => value.replace(/([A-Z])/g, ' $1').replace(/-/g, ' ').replace(/^./, (character) => character.toUpperCase());
const display = (key: string, value: JsonValue) => key.toLowerCase().includes('minor') && typeof value === 'string' ? money(value) : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—');

export default function ReportsPage(): React.ReactNode {
  const [section, setSection] = useState<Section>('sales');
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(today());
  const [storeId, setStoreId] = useState('');
  const [stores, setStores] = useState<Store[]>([]);
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load(target = section): Promise<void> {
    setLoading(true); setError('');
    try { setReport(await api<Report>(`/reports/${target}?${params(from, to, storeId)}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'REPORT_LOAD_FAILED'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void api<Store[]>('/stores').then(setStores); }, []);
  useEffect(() => { void load(section); }, [section]); // filters apply explicitly

  const summary = report?.data.summary && typeof report.data.summary === 'object' && !Array.isArray(report.data.summary) ? report.data.summary as Record<string, JsonValue> : undefined;
  const rows = report ? findRows(report.data) : [];
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 10);
  return (
    <main className="admin-shell">
      <aside className="admin-nav">
        <a className="admin-brand" href="/admin"><span className="eyebrow">RJ POS</span><strong>Reports</strong></a>
        <nav aria-label="Report sections">{sections.map((item) => <button className={section === item ? 'active' : ''} key={item} onClick={() => setSection(item)}>{label(item)}</button>)}</nav>
        <a className="register-link" href="/admin">Back to administration</a>
      </aside>
      <section className="admin-main">
        <header className="admin-heading"><div><span className="eyebrow">Operational analytics</span><h1>{label(section)}</h1></div></header>
        <form className="admin-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void load(); }}>
          <label>From<input aria-label="From date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>Through<input aria-label="Through date" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <label>Store<select aria-label="Store" value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="">All authorized stores</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>
          <button>Apply filters</button>
          <a className="report-export" href={`${ADMIN_API}/admin/reports/${section}/export.csv?${params(from, to, storeId)}`}>Export CSV</a>
        </form>
        {error && <p className="admin-alert error" role="alert">{error}</p>}
        {loading ? <div className="admin-empty">Calculating authoritative report…</div> : <>
          {summary && <div className="metric-grid">{Object.entries(summary).map(([key, value]) => <article key={key}><span>{label(key)}</span><strong>{display(key, value)}</strong></article>)}</div>}
          <p className="hint">Range: {report?.filters.from} through {report?.filters.toExclusive} ({report?.filters.timezone})</p>
          {rows.length ? <div className="admin-table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{label(header)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{headers.map((header) => <td key={header}>{display(header, row[header] ?? null)}</td>)}</tr>)}</tbody></table></div> : <div className="admin-empty">No rows match this period.</div>}
        </>}
      </section>
    </main>
  );
}
