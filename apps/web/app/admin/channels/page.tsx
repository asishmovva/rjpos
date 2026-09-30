'use client';
import { useCallback, useEffect, useState } from 'react';
import { costingApi, type PriceBook } from '../costing-client';
import { errorText, phaseNineApi, type SalesChannel } from '../phase9-client';
import '../admin.css';
import '../costing.css';

/** Settings → Sales channels. A channel is a label on each order, optionally tied to a price book. There is no marketplace integration. */
export default function ChannelsPage(): React.ReactNode {
  const [channels, setChannels] = useState<SalesChannel[]>([]); const [books, setBooks] = useState<PriceBook[]>([]);
  const [name, setName] = useState(''); const [bookId, setBookId] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = useCallback(async () => { const [list, priceBooks] = await Promise.all([phaseNineApi.channels(), costingApi.priceBooks()]); setChannels(list); setBooks(priceBooks.filter((book) => book.active)); }, []);
  useEffect(() => { void load().catch((cause) => setError(errorText(cause))); }, [load]);
  async function act(operation: () => Promise<unknown>, success: string): Promise<void> {
    setError(''); setMessage('');
    try { await operation(); setMessage(success); await load(); } catch (cause) { setError(errorText(cause)); }
  }
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Settings</span><h1>Sales channels</h1></div></header>
    <p className="hint">Pick a channel at the register to price the sale from that channel&apos;s price book and report sales by channel. Orders keep the channel name they were sold under.</p>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <section className="wizard-section" aria-label="Channels"><h2>Channels</h2>
      <table className="line-table"><thead><tr><th>Channel</th><th>Price book</th><th>Status</th><th /></tr></thead><tbody>
        {channels.map((channel) => <tr key={channel.id}><td><strong>{channel.name}</strong>{channel.isDefault && <span className="pill"> DEFAULT</span>}</td>
          <td><select aria-label={`Price book for ${channel.name}`} value={channel.priceBookId ?? ''} onChange={(event) => void act(() => phaseNineApi.updateChannel(channel.id, { priceBookId: event.target.value || null }), 'Channel updated.')}>
            <option value="">Standard prices</option>{books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</select></td>
          <td>{channel.active ? 'Active' : 'Inactive'}</td>
          <td>{!channel.isDefault && <button onClick={() => void act(() => phaseNineApi.updateChannel(channel.id, { active: !channel.active }), channel.active ? 'Channel deactivated.' : 'Channel activated.')}>{channel.active ? 'Deactivate' : 'Activate'}</button>}</td></tr>)}
      </tbody></table></section>
    <section className="wizard-section" aria-label="Add channel"><h2>Add a channel</h2>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void act(async () => { await phaseNineApi.createChannel({ name, ...(bookId ? { priceBookId: bookId } : {}) }); setName(''); setBookId(''); }, 'Channel added.'); }}>
        <label>Name<input aria-label="Channel name" maxLength={40} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Price book (optional)<select aria-label="New channel price book" value={bookId} onChange={(event) => setBookId(event.target.value)}><option value="">Standard prices</option>{books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</select></label>
        <button className="primary" disabled={!name.trim()}>Add channel</button></form></section>
  </main>;
}
