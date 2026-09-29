'use client';
import { useCallback, useEffect, useState } from 'react';
import { costingApi, type PriceBook } from '../costing-client';
import '../admin.css';
import '../costing.css';

/** Named price lists for special/channel pricing (Price A, Price B, DoorDash, Uber Eats, or anything custom). */
export default function PriceBooksPage(): React.ReactNode {
  const [books, setBooks] = useState<PriceBook[]>([]); const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = useCallback(async () => setBooks(await costingApi.priceBooks()), []);
  useEffect(() => { void load().catch(() => setError('Could not load price books.')); }, [load]);
  async function act(operation: () => Promise<unknown>, success: string): Promise<void> {
    setError(''); setMessage('');
    try { await operation(); setMessage(success); await load(); } catch (cause) { setError(cause instanceof Error && cause.message === 'PRICE_BOOK_NAME_TAKEN' ? 'A price book with that name already exists.' : cause instanceof Error ? cause.message : 'That did not work.'); }
  }
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Settings</span><h1>Price books</h1></div></header>
    <p className="hint">The standard store price is separate. Add a special price for a product from its Special Pricing tab. Completed orders keep the price that was charged.</p>
    {error && <p className="admin-alert error" role="alert">{error}</p>}{message && <p className="admin-alert success">{message}</p>}
    <section className="wizard-section"><table className="line-table"><thead><tr><th>Name</th><th>Special prices</th><th>Status</th><th /></tr></thead><tbody>
      {books.map((book) => <tr key={book.id}><td><strong>{book.name}</strong><small className="stack">{book.description ?? ''}</small></td><td>{book._count?.specialPrices ?? 0}</td><td>{book.active ? 'Active' : 'Inactive'}</td>
        <td><button onClick={() => void act(() => costingApi.updatePriceBook(book.id, { active: !book.active }), book.active ? 'Price book deactivated.' : 'Price book activated.')}>{book.active ? 'Deactivate' : 'Activate'}</button></td></tr>)}
    </tbody></table></section>
    <section className="wizard-section" aria-label="Add price book"><h2>Add a price book</h2>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void act(async () => { await costingApi.createPriceBook({ name, ...(description.trim() ? { description } : {}) }); setName(''); setDescription(''); }, 'Price book added.'); }}>
        <label>Name<input aria-label="Price book name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Grubhub, Wholesale, Custom…" /></label>
        <label>Description (optional)<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <button className="primary" disabled={!name.trim()}>Add price book</button></form></section>
  </main>;
}
