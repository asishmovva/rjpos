'use client';
import { useEffect, useRef, useState } from 'react';
import { emptyDisplayState, subscribeDisplay, type DisplayState } from '../display-channel';
import { money } from '../register-api';
import './customer-display.css';

const ROTATE_MS = 8_000;

/**
 * Customer-facing display. Shows store content and the live order only. It deliberately has no support details,
 * employee names, approval information, or anything that can be acted on.
 */
export default function CustomerDisplayPage(): React.ReactNode {
  const [state, setState] = useState<DisplayState>(emptyDisplayState());
  const [index, setIndex] = useState(0);
  useEffect(() => subscribeDisplay(setState), []);
  const promoCount = state.promos.length;
  useEffect(() => {
    if (promoCount < 2) { setIndex(0); return undefined; }
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % promoCount), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [promoCount]);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [state.lines.length, state.itemCount]);

  const promo = promoCount ? state.promos[index % promoCount] : undefined;
  const storeName = state.storeName || 'Welcome';
  const saved = BigInt(state.discountMinor || '0');
  const phase = state.phase;

  if (phase === 'thanks') return <main className="cd cd-thanks"><h1>Thank you!</h1><p>{storeName}</p><div className="cd-paid"><span>Total paid</span><b>{money(state.totalMinor)}</b></div><p className="cd-sub">Have a great day.</p></main>;
  if (phase === 'cash-complete') return <main className="cd cd-thanks"><h1>Change due</h1><div className="cd-change">{money(state.changeDueMinor ?? '0')}</div>
    <div className="cd-paid"><span>Total</span><b>{money(state.totalMinor)}</b></div><div className="cd-paid"><span>Cash tendered</span><b>{money(state.tenderedMinor ?? '0')}</b></div></main>;

  return <main className="cd">
    <section className="cd-stage" aria-label="Store">
      {promo
        ? <div className="cd-promo" key={promo.id}>{promo.imageData && <img src={promo.imageData} alt="" />}<div className="cd-promo-text"><h2>{promo.title}</h2>{promo.subtitle && <p>{promo.subtitle}</p>}</div></div>
        : <div className="cd-welcome"><div className="cd-logo" aria-hidden="true">{storeName.slice(0, 1).toUpperCase()}</div><h2>{storeName}</h2><p>Welcome. Thank you for shopping with us.</p></div>}
      {promoCount > 1 && <div className="cd-dots" aria-hidden="true">{state.promos.map((item, at) => <span key={item.id} className={at === index % promoCount ? 'on' : ''} />)}</div>}
    </section>
    <section className="cd-order" aria-label="Your order">
      <header><h2>Your order</h2><span>{state.itemCount} item{state.itemCount === 1 ? '' : 's'}</span></header>
      {phase === 'age' && <div className="cd-banner age" role="status">Age verification required</div>}
      {phase === 'processing' && <div className="cd-banner processing" role="status">Processing payment…</div>}
      {state.lines.length === 0
        ? <div className="cd-empty">Your items will appear here.</div>
        : <ul ref={listRef} className="cd-lines">{state.lines.map((line) => <li key={line.id}><div><strong>{line.name}</strong><small>{line.quantity > 1 ? `${line.quantity} × ` : ''}{line.detail}</small></div><b>{money(line.totalMinor)}</b></li>)}</ul>}
      <footer>
        <div className="cd-row"><span>Subtotal</span><b>{money(state.subtotalMinor)}</b></div>
        {saved > 0n && <div className="cd-row save"><span>You saved</span><b>−{money(state.discountMinor)}</b></div>}
        <div className="cd-row"><span>Tax</span><b>{money(state.taxMinor)}</b></div>
        <div className="cd-total"><span>Total</span><b>{money(state.totalMinor)}</b></div>
      </footer>
    </section>
  </main>;
}
