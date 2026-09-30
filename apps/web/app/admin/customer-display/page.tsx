'use client';
import { useCallback, useEffect, useState } from 'react';
import { errorText, phaseNineApi, type PromoAsset } from '../phase9-client';
import '../admin.css';
import '../costing.css';

const MAX_BYTES = 600_000;
const toLocalInput = (value: string | null) => (value ? new Date(value).toISOString().slice(0, 16) : '');
const fromLocalInput = (value: string): string | null => (value ? new Date(value).toISOString() : null);
const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('IMAGE_READ_FAILED')); reader.readAsDataURL(file); });

/** Settings → Customer display. Simple promotions (image, title, message, order, dates) for the second screen; not a content system. */
export default function CustomerDisplaySettings(): React.ReactNode {
  const [promos, setPromos] = useState<PromoAsset[]>([]); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [title, setTitle] = useState(''); const [subtitle, setSubtitle] = useState(''); const [image, setImage] = useState<string | null>(null); const [starts, setStarts] = useState(''); const [ends, setEnds] = useState('');
  const load = useCallback(async () => { setPromos(await phaseNineApi.promos()); }, []);
  useEffect(() => { void load().catch((cause) => setError(errorText(cause))); }, [load]);
  async function act(operation: () => Promise<unknown>, success: string): Promise<void> {
    setError(''); setMessage('');
    try { await operation(); setMessage(success); await load(); } catch (cause) { setError(errorText(cause)); }
  }
  async function pickImage(file: File | undefined): Promise<void> {
    setError('');
    if (!file) { setImage(null); return; }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setError('Use a PNG, JPEG, or WebP image.'); return; }
    if (file.size > MAX_BYTES) { setError('That image is too large (600 KB maximum). Resize it and try again.'); return; }
    setImage(await readAsDataUrl(file));
  }
  const now = Date.now();
  const status = (promo: PromoAsset) => !promo.active ? 'Off' : promo.startsAt && new Date(promo.startsAt).getTime() > now ? 'Scheduled' : promo.endsAt && new Date(promo.endsAt).getTime() <= now ? 'Ended' : 'Showing';
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><span className="eyebrow">Settings</span><h1>Customer display</h1></div>
      <div><a className="hdr-link" href="/customer-display/" target="_blank" rel="noreferrer">Open preview ↗</a></div></header>
    <p className="hint">The customer display shows your store and promotions on the left and the live order on the right. With no promotions it shows a welcome screen. RJ POS support details never appear on it.</p>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <section className="wizard-section" aria-label="Promotions"><h2>Promotions</h2>
      {promos.length === 0 ? <p className="hint">No promotions yet. Add one below.</p> : <table className="line-table"><thead><tr><th>Image</th><th>Promotion</th><th>Order</th><th>Window</th><th>Status</th><th /></tr></thead><tbody>
        {promos.map((promo) => <tr key={promo.id}><td>{promo.imageData ? <img className="promo-thumb" src={promo.imageData} alt="" /> : <span className="hint">None</span>}</td>
          <td><strong>{promo.title}</strong>{promo.subtitle && <small className="stack">{promo.subtitle}</small>}</td>
          <td><input aria-label={`Order for ${promo.title}`} className="narrow" inputMode="numeric" defaultValue={promo.sortOrder} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value !== promo.sortOrder) void act(() => phaseNineApi.savePromo(promo.id, { sortOrder: value }), 'Order saved.'); }} /></td>
          <td><small>{promo.startsAt ? new Date(promo.startsAt).toLocaleDateString() : 'Any time'} – {promo.endsAt ? new Date(promo.endsAt).toLocaleDateString() : 'no end'}</small></td>
          <td><span className={`pill ${status(promo) === 'Showing' ? 'ok' : ''}`}>{status(promo)}</span></td>
          <td><button onClick={() => void act(() => phaseNineApi.savePromo(promo.id, { active: !promo.active }), promo.active ? 'Promotion turned off.' : 'Promotion turned on.')}>{promo.active ? 'Turn off' : 'Turn on'}</button>
            <button onClick={() => { if (window.confirm(`Delete “${promo.title}”?`)) void act(() => phaseNineApi.deletePromo(promo.id), 'Promotion deleted.'); }}>Delete</button></td></tr>)}</tbody></table>}</section>
    <section className="wizard-section" aria-label="Add promotion"><h2>Add a promotion</h2>
      <form className="grid-form" onSubmit={(event) => { event.preventDefault(); void act(async () => { await phaseNineApi.savePromo(null, { title, subtitle: subtitle || null, imageData: image, startsAt: fromLocalInput(starts), endsAt: fromLocalInput(ends), sortOrder: promos.length + 1 }); setTitle(''); setSubtitle(''); setImage(null); setStarts(''); setEnds(''); }, 'Promotion added.'); }}>
        <label>Title<input aria-label="Promotion title" maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Message (optional)<input aria-label="Promotion message" maxLength={160} value={subtitle} onChange={(event) => setSubtitle(event.target.value)} /></label>
        <label>Image (optional, 600 KB max)<input aria-label="Promotion image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void pickImage(event.target.files?.[0])} /></label>
        <label>Starts (optional)<input type="datetime-local" value={starts} onChange={(event) => setStarts(event.target.value)} /></label>
        <label>Ends (optional)<input type="datetime-local" value={ends} onChange={(event) => setEnds(event.target.value)} /></label>
        <div className="wizard-actions"><button className="big" disabled={!title.trim()}>Add promotion</button></div>
        {image && <img className="promo-preview" src={image} alt="Selected promotion" />}</form></section>
  </main>;
}
