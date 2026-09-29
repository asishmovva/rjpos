'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../admin-client';
import { costingApi, type TaxProfile, type TaxStore } from '../costing-client';
import '../admin.css';
import '../costing.css';

const ERRORS: Record<string, string> = {
  TAX_PROFILE_NAME_TAKEN: 'A tax profile with that name already exists.', TAX_PROFILE_NAME_INVALID: 'Enter a name (up to 60 characters).', TAX_RATE_INVALID: 'Enter a rate between 0% and 100%.',
  TAX_PROFILE_IN_USE: 'This profile is still used by products. Deactivate it instead.', TAX_PROFILE_DEFAULT_REQUIRED: 'The default profile cannot be deactivated. Make another profile the default first.',
  TAX_PROFILE_PROTECTED: 'System and default profiles cannot be deleted.', TAX_PROFILE_RATE_FIXED: 'This profile’s rate is fixed.',
};
const rate = (bp: number | null) => (bp === null ? '' : (bp / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
function parseRate(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,3}))?%?$/.exec(text.trim());
  if (!match) return null;
  const bp = Math.round(Number(`${match[1]}.${match[2] ?? '0'}`) * 100);
  return bp <= 10_000 ? bp : null;
}

/** Settings → Taxes. Profiles are configurable data; sales snapshot the rate they used, so edits never rewrite history. */
export default function TaxSettingsPage(): React.ReactNode {
  const [profiles, setProfiles] = useState<TaxProfile[]>([]); const [stores, setStores] = useState<TaxStore[]>([]);
  const [name, setName] = useState(''); const [newRate, setNewRate] = useState(''); const [description, setDescription] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({}); const [storeRates, setStoreRates] = useState<Record<string, string>>({});
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    const result = await costingApi.taxProfiles();
    setProfiles(result.profiles); setStores(result.stores);
    setEdits(Object.fromEntries(result.profiles.map((profile) => [profile.id, rate(profile.rateBasisPoints)]))); setStoreRates(Object.fromEntries(result.stores.map((store) => [store.id, rate(store.taxRateBasisPoints)])));
  }, []);
  useEffect(() => { void load().catch(() => setError('Could not load tax profiles.')); }, [load]);
  async function act(operation: () => Promise<unknown>, success: string): Promise<void> {
    setError(''); setMessage('');
    try { await operation(); setMessage(success); await load(); } catch (cause) { setError(ERRORS[cause instanceof Error ? cause.message : ''] ?? (cause instanceof Error ? cause.message : 'That did not work.')); }
  }
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Settings</span><h1>Taxes</h1></div></header>
    <p className="hint">Products and variants point at a tax profile; checkout charges each line at its own profile rate. Changing a rate affects future sales only.</p>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}

    <section className="wizard-section" aria-label="Standard state tax"><h2>Standard State Tax</h2>
      <p className="hint">The default profile follows each store's standard rate.</p>
      <table className="line-table"><thead><tr><th>Store</th><th>Standard rate (%)</th><th /></tr></thead><tbody>{stores.map((store) => <tr key={store.id}><td>{store.name}</td>
        <td><input aria-label={`Standard rate ${store.name}`} inputMode="decimal" value={storeRates[store.id] ?? ''} onChange={(event) => setStoreRates((current) => ({ ...current, [store.id]: event.target.value.replace(/[^\d.]/g, '') }))} /></td>
        <td><button disabled={parseRate(storeRates[store.id] ?? '') === null || parseRate(storeRates[store.id] ?? '') === store.taxRateBasisPoints} onClick={() => void act(() => adminApi.updateStore(store.id, { taxRateBasisPoints: parseRate(storeRates[store.id] ?? '') }), 'Standard rate saved.')}>Save</button></td></tr>)}</tbody></table></section>

    <section className="wizard-section" aria-label="Tax profiles"><h2>Tax profiles</h2>
      <table className="line-table"><thead><tr><th>Profile</th><th>Rate (%)</th><th>Used by</th><th>Status</th><th /></tr></thead><tbody>
        {profiles.map((profile) => <tr key={profile.id}><td><strong>{profile.name}</strong>{profile.isDefault && <span className="pill"> DEFAULT</span>}<small className="stack">{profile.description ?? ''}</small></td>
          <td>{profile.kind === 'CUSTOM' ? <input aria-label={`Rate ${profile.name}`} inputMode="decimal" value={edits[profile.id] ?? ''} onChange={(event) => setEdits((current) => ({ ...current, [profile.id]: event.target.value.replace(/[^\d.]/g, '') }))} /> : profile.kind === 'NON_TAXABLE' ? '0' : 'Store rate'}</td>
          <td>{profile.referenceCount} item{profile.referenceCount === 1 ? '' : 's'}</td><td>{profile.active ? 'Active' : 'Inactive'}</td>
          <td>{profile.kind === 'CUSTOM' && <button disabled={parseRate(edits[profile.id] ?? '') === null || parseRate(edits[profile.id] ?? '') === profile.rateBasisPoints} onClick={() => void act(() => costingApi.updateTaxProfile(profile.id, { rateBasisPoints: parseRate(edits[profile.id] ?? '') }), 'Rate saved for future sales.')}>Save rate</button>}
            {!profile.isDefault && profile.active && <button onClick={() => void act(() => costingApi.updateTaxProfile(profile.id, { makeDefault: true }), `${profile.name} is now the default.`)}>Make default</button>}
            {!profile.isDefault && <button onClick={() => void act(() => costingApi.updateTaxProfile(profile.id, { active: !profile.active }), profile.active ? 'Profile deactivated.' : 'Profile activated.')}>{profile.active ? 'Deactivate' : 'Activate'}</button>}
            {profile.kind === 'CUSTOM' && !profile.isDefault && profile.referenceCount === 0 && <button onClick={() => void act(() => costingApi.deleteTaxProfile(profile.id), 'Profile deleted.')}>Delete</button>}</td></tr>)}
      </tbody></table></section>

    <section className="wizard-section" aria-label="Add tax profile"><h2>Add a profile</h2>
      <p className="hint">For example Tax 1, Tax 2, or Tobacco. Nothing is hardcoded; set the rate that applies to you.</p>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const bp = parseRate(newRate); if (bp === null) { setError(ERRORS.TAX_RATE_INVALID!); return; }
        void act(async () => { await costingApi.createTaxProfile({ name, rateBasisPoints: bp, ...(description.trim() ? { description } : {}) }); setName(''); setNewRate(''); setDescription(''); }, 'Tax profile added.'); }}>
        <label>Name<input aria-label="Profile name" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Rate (%)<input aria-label="Profile rate" inputMode="decimal" value={newRate} onChange={(event) => setNewRate(event.target.value.replace(/[^\d.%]/g, ''))} placeholder="6.625" /></label>
        <label>Description (optional)<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <button className="primary" disabled={!name.trim() || !newRate}>Add profile</button></form></section>
  </main>;
}
