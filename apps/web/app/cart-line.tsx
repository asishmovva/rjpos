'use client';

import { useRef, useState } from 'react';
import { money } from './register-api';

type Line = { variantId: string; productName: string; variantName: string; sku: string; priceMinor: string | null; quantity: number; ageRestricted: boolean };
type Priced = { subtotalMinor: string; discountMinor: string; totalMinor: string; promotionName: string | null } | undefined;

const REVEAL_DISTANCE = 70;
const ACTION_WIDTH = 132;

/**
 * A cart row. Swiping right on a touch screen reveals a red Remove action; nothing is removed until that action is
 * tapped, so an accidental swipe is harmless. The always-visible Remove button works with any input device.
 */
export function CartLine({ line, priced, manualDiscount, onQuantity, onRemove }: {
  line: Line; priced: Priced; manualDiscount: boolean; onQuantity: (quantity: number) => void; onRemove: () => void;
}): React.ReactNode {
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const horizontal = useRef(false);
  function move(x: number, y: number): void {
    if (!start.current) return;
    const dx = x - start.current.x; const dy = y - start.current.y;
    if (!horizontal.current && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) horizontal.current = true;
    if (!horizontal.current) return;
    setOffset(Math.max(0, Math.min(ACTION_WIDTH, (revealed ? ACTION_WIDTH : 0) + dx)));
  }
  function end(): void {
    if (!start.current) return;
    const open = horizontal.current ? offset >= REVEAL_DISTANCE : revealed;
    setRevealed(open); setOffset(open ? ACTION_WIDTH : 0);
    start.current = null; horizontal.current = false;
  }
  const shown = revealed && offset === ACTION_WIDTH ? ACTION_WIDTH : offset;
  return <div className="cart-swipe">
    <button className="swipe-remove" aria-label={`Confirm remove ${line.productName}`} tabIndex={shown > 0 ? 0 : -1} onClick={onRemove}>Remove item</button>
    <article className="line" data-testid="cart-line" style={{ transform: `translateX(${shown}px)`, transition: start.current ? 'none' : 'transform .18s ease' }}
      onTouchStart={(event) => { const touch = event.touches[0]; if (touch) start.current = { x: touch.clientX, y: touch.clientY }; }}
      onTouchMove={(event) => { const touch = event.touches[0]; if (touch) move(touch.clientX, touch.clientY); }}
      onTouchEnd={end} onTouchCancel={end}>
      <div>
        <strong>{line.productName}</strong>
        <small>{line.variantName} · {line.sku}{line.ageRestricted ? ' · 21+' : ''}</small>
        {manualDiscount && <small>Manual discount applied</small>}
        {!manualDiscount && priced?.promotionName && <small>{priced.promotionName} · save {money(priced.discountMinor)}</small>}
        <button className="text remove-line" aria-label={`Remove ${line.productName}`} onClick={onRemove}>Remove</button>
      </div>
      <div className="quantity">
        <button aria-label={`Decrease ${line.productName}`} onClick={() => onQuantity(line.quantity - 1)}>−</button>
        <input aria-label="Quantity" value={line.quantity} onChange={(event) => onQuantity(Math.max(1, Number(event.target.value) || 1))} />
        <button aria-label={`Increase ${line.productName}`} onClick={() => onQuantity(line.quantity + 1)}>+</button>
      </div>
      <b>{priced && BigInt(priced.discountMinor) > 0n ? <><s>{money(priced.subtotalMinor)}</s><br />{money(priced.totalMinor)}</> : money(BigInt(line.priceMinor ?? 0) * BigInt(line.quantity))}</b>
    </article>
  </div>;
}
