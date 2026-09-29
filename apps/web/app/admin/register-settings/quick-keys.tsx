'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ADMIN_API } from '../admin-client';

type QuickKey = { id: string; label: string; groupName: string; position: number; enabled: boolean; registerId: string | null; variantId: string; variant: { name: string; sku: string; product: { name: string } } };
type CatalogItem = { variantId: string; productName: string; variantName: string; sku: string; barcode: string | null; priceMinor: string | null; active: boolean };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ADMIN_API}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-rjpos-role': 'OWNER', ...init?.headers } });
  const body = await response.json() as T & { error?: { code: string } };
  if (!response.ok) throw new Error(body.error?.code ?? `HTTP_${response.status}`);
  return body;
}
const ERRORS: Record<string, string> = {
  QUICK_KEY_POSITION_TAKEN: 'That position is already used.', QUICK_KEY_LABEL_INVALID: 'Enter a button label (up to 40 characters).',
  QUICK_KEY_LIMIT_REACHED: 'This register already has the maximum of 100 Quick Add buttons.', PRODUCT_VARIANT_NOT_FOUND: 'That product is not available.',
};
const describe = (error: unknown) => ERRORS[error instanceof Error ? error.message : ''] ?? 'Could not save. Try again.';
const money = (minor: string | null) => minor === null ? 'No price' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(minor) / 100);

export function QuickKeyManager({ onMessage }: { onMessage: (message: string) => void }): React.ReactNode {
  const [keys, setKeys] = useState<QuickKey[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [picked, setPicked] = useState<CatalogItem | null>(null);
  const [label, setLabel] = useState('');
  const [groupName, setGroupName] = useState('Favorites');
  const [scope, setScope] = useState<'register' | 'store'>('register');
  const [drafts, setDrafts] = useState<Record<string, { label: string; groupName: string }>>({});
  const load = useCallback(async () => {
    const rows = await request<QuickKey[]>('/admin/quick-keys');
    setKeys(rows);
    setDrafts(Object.fromEntries(rows.map((key) => [key.id, { label: key.label, groupName: key.groupName }])));
  }, []);
  useEffect(() => { void load().catch((error) => onMessage(describe(error))); }, [load, onMessage]);
  useEffect(() => {
    const value = search.trim();
    if (value.length < 2) { setResults([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void request<CatalogItem[]>(`/catalog/lookup?search=${encodeURIComponent(value)}`).then((items) => { if (active) setResults(items.filter((item) => item.active).slice(0, 12)); }).catch(() => { if (active) setResults([]); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search]);

  function choose(item: CatalogItem): void {
    setPicked(item); setLabel(item.productName.slice(0, 40)); setSearch(''); setResults([]);
  }
  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!picked) return;
    try {
      await request('/admin/quick-keys', { method: 'POST', body: JSON.stringify({ variantId: picked.variantId, label, groupName: groupName.trim() || 'Favorites', enabled: true, registerSpecific: scope === 'register' }) });
      setPicked(null); setLabel(''); onMessage('Quick Add button added. The register shows it right away.'); await load();
    } catch (error) { onMessage(describe(error)); }
  }
  async function update(key: QuickKey, changes: Partial<{ label: string; groupName: string; enabled: boolean }>): Promise<void> {
    try {
      const draft = drafts[key.id] ?? { label: key.label, groupName: key.groupName };
      await request(`/admin/quick-keys/${key.id}`, { method: 'PATCH', body: JSON.stringify({ variantId: key.variantId, label: draft.label, groupName: draft.groupName, enabled: key.enabled, ...changes }) });
      onMessage('Quick Add button saved.'); await load();
    } catch (error) { onMessage(describe(error)); }
  }
  async function move(key: QuickKey, direction: -1 | 1): Promise<void> {
    const sameScope = keys.filter((candidate) => candidate.registerId === key.registerId).sort((a, b) => a.position - b.position);
    const index = sameScope.findIndex((candidate) => candidate.id === key.id);
    const target = index + direction;
    if (target < 0 || target >= sameScope.length) return;
    const ids = sameScope.map((candidate) => candidate.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    try { await request('/admin/quick-keys/reorder', { method: 'POST', body: JSON.stringify({ ids }) }); await load(); } catch (error) { onMessage(describe(error)); }
  }

  const groups = [...new Set(keys.map((key) => key.groupName))];
  return <section aria-label="Quick Add buttons">
    <h2>Quick Add buttons</h2>
    <p>Buttons appear on the register for fast selling. Search for a product, name the button, and choose a group.</p>
    <form className="admin-form" onSubmit={(event) => void add(event)}>
      <label>Find product<input aria-label="Find product" placeholder="Type a name, SKU, or barcode" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      {results.length > 0 && <div className="quick-key-results" role="listbox" aria-label="Product results">{results.map((item) => <button type="button" role="option" aria-selected="false" key={item.variantId} onClick={() => choose(item)}><strong>{item.productName}</strong> <span>{item.variantName} · {item.sku} · {money(item.priceMinor)}</span></button>)}</div>}
      {picked && <p role="status"><strong>Selected:</strong> {picked.productName} · {picked.variantName} · {money(picked.priceMinor)}</p>}
      <label>Button label<input name="label" required maxLength={40} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label>Group<input name="groupName" list="quick-key-groups" required value={groupName} onChange={(event) => setGroupName(event.target.value)} /><datalist id="quick-key-groups">{groups.map((group) => <option key={group} value={group} />)}</datalist></label>
      <label>Show on<select value={scope} onChange={(event) => setScope(event.target.value as 'register' | 'store')}><option value="register">This register</option><option value="store">Every register in this store</option></select></label>
      <button disabled={!picked || !label.trim()}>Add button</button>
    </form>
    <div className="admin-table-wrap"><table><thead><tr><th>Order</th><th>Label</th><th>Group</th><th>Product</th><th>Shown on</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      {keys.length === 0 && <tr><td colSpan={7}>No Quick Add buttons yet.</td></tr>}
      {[...keys].sort((a, b) => a.groupName.localeCompare(b.groupName) || a.position - b.position).map((key) => {
        const draft = drafts[key.id] ?? { label: key.label, groupName: key.groupName };
        const changed = draft.label !== key.label || draft.groupName !== key.groupName;
        return <tr key={key.id}>
          <td><button aria-label={`Move ${key.label} up`} onClick={() => void move(key, -1)}>↑</button> <button aria-label={`Move ${key.label} down`} onClick={() => void move(key, 1)}>↓</button></td>
          <td><input aria-label={`Label for ${key.label}`} maxLength={40} value={draft.label} onChange={(event) => setDrafts((current) => ({ ...current, [key.id]: { ...draft, label: event.target.value } }))} /></td>
          <td><input aria-label={`Group for ${key.label}`} value={draft.groupName} onChange={(event) => setDrafts((current) => ({ ...current, [key.id]: { ...draft, groupName: event.target.value } }))} /></td>
          <td>{key.variant.product.name} · {key.variant.name}</td>
          <td>{key.registerId ? 'This register' : 'Whole store'}</td>
          <td>{key.enabled ? 'Enabled' : 'Disabled'}</td>
          <td><button disabled={!changed || !draft.label.trim()} onClick={() => void update(key, {})}>Save</button> <button onClick={() => void update(key, { enabled: !key.enabled })}>{key.enabled ? 'Disable' : 'Enable'}</button></td>
        </tr>;
      })}
    </tbody></table></div>
  </section>;
}
