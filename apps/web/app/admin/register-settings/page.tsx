'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ADMIN_API, type InventoryRow } from '../admin-client';
import '../admin.css';

type QuickKey = { id: string; label: string; groupName: string; position: number; enabled: boolean; variantId: string; variant: { name: string; sku: string; product: { name: string } } };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ADMIN_API}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-rjpos-role': 'OWNER', ...init?.headers } });
  const body = await response.json() as T & { error?: { code: string } }; if (!response.ok) throw new Error(body.error?.code ?? `HTTP_${response.status}`); return body;
}
export default function RegisterSettingsPage(): React.ReactNode {
  const [keys, setKeys] = useState<QuickKey[]>([]); const [inventory, setInventory] = useState<InventoryRow[]>([]); const [hardware, setHardware] = useState<Record<string, string>>({}); const [message, setMessage] = useState('');
  const electron = typeof window === 'undefined' ? undefined : window.rjpos;
  async function load() { const [keyRows, levels] = await Promise.all([request<QuickKey[]>('/admin/quick-keys'), request<{ items: InventoryRow[] }>('/admin/inventory?pageSize=100')]); setKeys(keyRows); setInventory(levels.items); if (electron) setHardware(await electron.hardwareStatus()); }
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load settings.')); }, []);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await request('/admin/quick-keys', { method: 'POST', body: JSON.stringify({ variantId: form.get('variantId'), label: form.get('label'), groupName: form.get('groupName'), position: Number(form.get('position')), enabled: true, registerSpecific: true }) }); event.currentTarget.reset(); setMessage('Quick Key saved.'); await load(); }
  return <main className="admin-main"><header className="admin-heading"><div><span className="eyebrow">RJ POS register</span><h1>Register &amp; hardware settings</h1></div><a href="/admin">Back to administration</a></header>{message && <p role="status" className="admin-alert success">{message}</p>}
    <section className="settings-grid">{['scanner','printer','drawer','terminal'].map((device) => <article key={device}><h2>{device[0]!.toUpperCase()+device.slice(1)}</h2><p><span className="pill">{hardware[device] ?? (electron ? 'checking' : 'browser only')}</span></p>{device === 'printer' && <button disabled={!electron} onClick={() => void electron?.testPrinter().then((result) => setMessage(result.message))}>Test printer</button>}{device === 'drawer' && <button disabled={!electron} onClick={() => void electron?.openDrawer({ reason: 'Authorized hardware settings test' }).then((result) => setMessage(result.message))}>Test drawer</button>}</article>)}</section>
    <h2>Quick Keys</h2><form className="admin-form" onSubmit={(event) => void save(event)}><label>Product / variant<select name="variantId" required>{inventory.map((row) => <option value={row.variantId} key={row.variantId}>{row.variant.product.name} · {row.variant.name} · {row.variant.sku}</option>)}</select></label><label>Button label<input name="label" required maxLength={40}/></label><label>Category / group<input name="groupName" defaultValue="Favorites" required/></label><label>Position<input name="position" type="number" min="0" max="99" required/></label><button>Save Quick Key</button></form>
    <div className="admin-table-wrap"><table><thead><tr><th>Position</th><th>Label</th><th>Group</th><th>Product</th><th>Status</th></tr></thead><tbody>{keys.map((key) => <tr key={key.id}><td>{key.position}</td><td>{key.label}</td><td>{key.groupName}</td><td>{key.variant.product.name} · {key.variant.name}</td><td>{key.enabled ? 'Enabled' : 'Disabled'}</td></tr>)}</tbody></table></div>
  </main>;
}
