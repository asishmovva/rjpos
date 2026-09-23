'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

const API = process.env.NEXT_PUBLIC_RJPOS_API_URL ?? 'http://127.0.0.1:3001/api/v1';
type CatalogItem = { variantId:string; productName:string; variantName:string; sku:string; barcode:string|null; priceMinor:string|null; active:boolean; ageRestricted:boolean };
type CartLine = CatalogItem & { quantity:number };
type Receipt = { orderNumber:string; subtotalMinor:string; discountMinor:string; taxMinor:string; totalMinor:string; items:Array<{id:string;productNameSnapshot:string;variantNameSnapshot:string;quantity:number;totalMinor:string}> };

function money(value: bigint | string): string {
  return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(Number(BigInt(value)) / 100);
}
async function api<T>(path:string, init?:RequestInit):Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers:{ 'content-type':'application/json', ...init?.headers } });
  const body = await response.json() as T & { error?:{code:string} };
  if (!response.ok) throw new Error(body.error?.code ?? `HTTP_${response.status}`);
  return body;
}

export default function Register(): React.ReactNode {
  const [sessionId,setSessionId]=useState('');
  const [query,setQuery]=useState('');
  const [cart,setCart]=useState<CartLine[]>([]);
  const [message,setMessage]=useState('Open the register to begin selling.');
  const [ageVerified,setAgeVerified]=useState(false);
  const [receipt,setReceipt]=useState<Receipt|null>(null);
  const [history,setHistory]=useState<Array<{id:string;orderNumber:string;status:string;totalMinor:string}>>([]);
  const [inventory,setInventory]=useState<Array<{id:string;onHand:number;reserved:number;variant:{name:string;sku:string;product:{name:string}}}>>([]);
  const [taxRate,setTaxRate]=useState(0);
  const [view,setView]=useState<'register'|'inventory'|'orders'>('register');
  const scanInput=useRef<HTMLInputElement>(null);
  const subtotal=useMemo(()=>cart.reduce((sum,line)=>sum+BigInt(line.priceMinor??0)*BigInt(line.quantity),0n),[cart]);
  const projectedTax=(subtotal*BigInt(taxRate)+5000n)/10000n;
  const total=subtotal+projectedTax;

  const addItem=useCallback((item:CatalogItem)=>{
    if(!item.active){setMessage('This product is inactive and cannot be sold.');return;}
    if(item.priceMinor===null){setMessage('This product has no active selling price.');return;}
    setCart(lines=>{const found=lines.find(line=>line.variantId===item.variantId);return found?lines.map(line=>line.variantId===item.variantId?{...line,quantity:line.quantity+1}:line):[...lines,{...item,quantity:1}]});
    setMessage(`${item.productName} added.`);
  },[]);
  async function lookup():Promise<void>{
    const value=query.trim();if(!value)return;
    try{const exact=await api<CatalogItem[]>(`/catalog/lookup?barcode=${encodeURIComponent(value)}`);const items=exact.length?exact:await api<CatalogItem[]>(`/catalog/lookup?search=${encodeURIComponent(value)}`);if(!items[0])setMessage('Product not found. No item was created.');else if(exact.length===1){addItem(items[0]);setQuery('');}else setMessage(`${items.length} matches. Enter an exact UPC or SKU to add.`);}catch(error){setMessage(error instanceof Error?error.message:'Lookup failed');}scanInput.current?.focus();
  }
  async function openRegister():Promise<void>{try{const [session,store]=await Promise.all([api<{id:string}>('/register-sessions/open',{method:'POST',body:JSON.stringify({openingCashMinor:'10000'})}),api<{taxRateBasisPoints:number}>('/store/current')]);setSessionId(session.id);setTaxRate(store.taxRateBasisPoints);setMessage('Register open. Ready to sell.');}catch(error){setMessage(error instanceof Error?error.message:'Could not open register');}}
  async function checkout(kind:'cash'|'terminal'):Promise<void>{
    if(!sessionId){setMessage('Open the register before checkout.');return;}
    try{const result=await api<{orderId:string}>(`/checkout/${kind}`,{method:'POST',body:JSON.stringify({registerSessionId:sessionId,idempotencyKey:crypto.randomUUID(),lines:cart.map(line=>({variantId:line.variantId,quantity:line.quantity})),ageVerified,...(kind==='cash'?{tenderedMinor:(total+2000n).toString()}:{simulatedOutcome:'APPROVED'})})});setReceipt(await api<Receipt>(`/orders/${result.orderId}/receipt`));setCart([]);setAgeVerified(false);setMessage('Sale complete. Receipt ready to print.');}catch(error){setMessage(error instanceof Error?error.message:'Checkout failed');}
  }
  async function loadHistory():Promise<void>{try{setHistory(await api('/orders'));setView('orders');}catch(error){setMessage(error instanceof Error?error.message:'History failed');}}
  async function loadInventory():Promise<void>{try{setInventory(await api('/inventory'));setView('inventory');}catch(error){setMessage(error instanceof Error?error.message:'Inventory failed');}}
  async function closeRegister():Promise<void>{if(!sessionId)return;try{await api(`/register-sessions/${sessionId}/close`,{method:'POST',body:JSON.stringify({countedCashMinor:'10000'})});setSessionId('');setMessage('Register closed. Cash difference is recorded.');}catch(error){setMessage(error instanceof Error?error.message:'Could not close register');}}

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow">RJ POS</span><h1>Downtown Register</h1></div><div className={`status ${sessionId?'open':''}`}><span/>{sessionId?'Register open':'Register closed'}</div><nav><button onClick={()=>setView('register')}>Register</button><button onClick={()=>void loadInventory()}>Inventory</button><button onClick={()=>void loadHistory()}>Orders</button></nav></header>
    {view==='register'&&<div className="register-grid"><section className="workspace">
      <div className="session-actions">{!sessionId?<button className="primary" onClick={()=>void openRegister()}>Open register · $100.00</button>:<button className="quiet" onClick={()=>void closeRegister()}>Close register</button>}<p>{message}</p></div>
      <div className="scanbox"><label htmlFor="scan">Scan UPC, enter SKU, or search products</label><div><input id="scan" ref={scanInput} autoFocus value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void lookup();}} placeholder="Scan barcode…"/><button onClick={()=>void lookup()}>Find</button></div></div>
      <div className="cart-head"><h2>Current sale</h2><button className="text" onClick={()=>setCart([])}>Clear cart</button></div><div className="cart">{cart.length===0&&<div className="empty">Your cart is empty.<br/><small>Scanned items appear here.</small></div>}{cart.map(line=><article key={line.variantId} className="line"><div><strong>{line.productName}</strong><small>{line.variantName} · {line.sku}{line.ageRestricted?' · 21+':''}</small></div><div className="quantity"><button onClick={()=>setCart(rows=>rows.flatMap(row=>row.variantId!==line.variantId?[row]:row.quantity===1?[]:[{...row,quantity:row.quantity-1}]))}>−</button><input aria-label="Quantity" value={line.quantity} onChange={event=>{const quantity=Math.max(1,Number(event.target.value)||1);setCart(rows=>rows.map(row=>row.variantId===line.variantId?{...row,quantity}:row));}}/><button onClick={()=>setCart(rows=>rows.map(row=>row.variantId===line.variantId?{...row,quantity:row.quantity+1}:row))}>+</button></div><b>{money(BigInt(line.priceMinor!)*BigInt(line.quantity))}</b></article>)}</div>
    </section><aside className="checkout"><h2>Checkout</h2><dl><div><dt>Subtotal</dt><dd>{money(subtotal)}</dd></div><div><dt>Projected tax</dt><dd>{money(projectedTax)}</dd></div><div className="total"><dt>Total</dt><dd>{money(total)}</dd></div></dl>{cart.some(line=>line.ageRestricted)&&<label className="age"><input type="checkbox" checked={ageVerified} onChange={event=>setAgeVerified(event.target.checked)}/>I verified the customer is of legal age.</label>}<button className="pay cash" disabled={!cart.length||!sessionId} onClick={()=>void checkout('cash')}>Take cash</button><button className="pay card" disabled={!cart.length||!sessionId} onClick={()=>void checkout('terminal')}>Simulated terminal</button><small>Final pricing and inventory are verified by the server.</small></aside></div>}
    {view==='inventory'&&<section className="management"><span className="eyebrow">Management</span><h2>Inventory</h2><p>Every opening balance and reason-coded adjustment creates a ledger movement and audit record.</p>{inventory.map(level=><article className="history" key={level.id}><strong>{level.variant.product.name} · {level.variant.name}</strong><span>{level.variant.sku}</span><b>{level.onHand-level.reserved} available</b></article>)}<button onClick={()=>setView('register')}>Back to register</button></section>}
    {view==='orders'&&<section className="management"><span className="eyebrow">Sales history</span><h2>Recent orders</h2>{history.map(order=><article className="history" key={order.id}><strong>{order.orderNumber}</strong><span>{order.status}</span><b>{money(order.totalMinor)}</b></article>)}<button onClick={()=>setView('register')}>Back to register</button></section>}
    {receipt&&<div className="modal" role="dialog" aria-label="Receipt"><section className="receipt"><button className="close" onClick={()=>setReceipt(null)}>×</button><span className="eyebrow">RJ POS · Downtown</span><h2>Receipt</h2><p>{receipt.orderNumber}</p>{receipt.items.map(item=><div className="receipt-line" key={item.id}><span>{item.quantity} × {item.productNameSnapshot} {item.variantNameSnapshot}</span><b>{money(item.totalMinor)}</b></div>)}<hr/><div className="receipt-line"><span>Subtotal</span><b>{money(receipt.subtotalMinor)}</b></div><div className="receipt-line"><span>Tax</span><b>{money(receipt.taxMinor)}</b></div><div className="receipt-line grand"><span>Total</span><b>{money(receipt.totalMinor)}</b></div><button className="primary" onClick={()=>window.print()}>Print receipt</button></section></div>}
  </main>;
}
