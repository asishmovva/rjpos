'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './register.css';

const API = process.env.NEXT_PUBLIC_RJPOS_API_URL ?? 'http://127.0.0.1:3001/api/v1';
type CatalogItem = {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  barcode: string | null;
  priceMinor: string | null;
  active: boolean;
  ageRestricted: boolean;
};
type CartLine = CatalogItem & { quantity: number };
type Receipt = {
  id: string;
  orderNumber: string;
  subtotalMinor: string;
  discountMinor: string;
  taxMinor: string;
  totalMinor: string;
  items: Array<{
    id: string;
    productNameSnapshot: string;
    variantNameSnapshot: string;
    quantity: number;
    unitPriceMinor: string;
    subtotalMinor: string;
    discountMinor: string;
    totalMinor: string;
    promotionNameSnapshot: string | null;
  }>;
  refunds?: Array<{
    status: string;
    items: Array<{ orderItemId: string; quantity: number }>;
  }>;
};
type QuickKey = CatalogItem & { id: string; label: string; groupName: string; position: number };
type HeldTransaction = { id: string; label: string; heldAt: string; cartJson: { lines: CartLine[]; customerId?: string; ageVerified?: boolean }; employee: { firstName: string; lastName: string }; customer: { name: string } | null };
type CheckoutQuote = {
  subtotalMinor: string;
  discountMinor: string;
  taxMinor: string;
  totalMinor: string;
  lines: Array<{
    variantId: string;
    unitPriceMinor: string;
    quantity: number;
    subtotalMinor: string;
    discountMinor: string;
    taxMinor: string;
    totalMinor: string;
    promotionName: string | null;
  }>;
};
function isCheckoutQuote(value: unknown): value is CheckoutQuote {
  if (!value || typeof value !== 'object') return false;
  const quote = value as Partial<CheckoutQuote>;
  return typeof quote.subtotalMinor === 'string' && typeof quote.discountMinor === 'string' && typeof quote.taxMinor === 'string' && typeof quote.totalMinor === 'string' && Array.isArray(quote.lines);
}
type Customer = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  pointsBalance?: number;
};
type LoyaltyProgram = {
  enabled: boolean;
  pointsEarned: number;
  spendMinor: string;
  redeemMinorPerPoint: string;
} | null;

function money(value: bigint | string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(BigInt(value)) / 100);
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers }, signal: init?.signal ?? AbortSignal.timeout(10_000) });
    const body = (typeof response.text === 'function'
      ? await response.text().then((text) => text ? JSON.parse(text) : null)
      : await response.json()) as T & { error?: { code: string } } | null;
    if (!response.ok) throw new Error(body?.error?.code ?? `HTTP_${response.status}`);
    return body as T;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) throw new Error('Register cannot reach the server. No sale was recorded.');
    throw error;
  }
}

export default function Register(): React.ReactNode {
  const [sessionId, setSessionId] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CatalogItem[]>([]);
  const [highlightedResult, setHighlightedResult] = useState(0);
  const [priceCheckMode, setPriceCheckMode] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [message, setMessage] = useState('Open the register to begin selling.');
  const [ageVerified, setAgeVerified] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      orderNumber: string;
      status: string;
      totalMinor: string;
    }>
  >([]);
  const [inventory, setInventory] = useState<
    Array<{
      id: string;
      onHand: number;
      reserved: number;
      variant: { name: string; sku: string; product: { name: string } };
    }>
  >([]);
  const [taxRate, setTaxRate] = useState(0);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loyaltyProgram, setLoyaltyProgram] = useState<LoyaltyProgram>(null);
  const [loyaltyPoints, setLoyaltyPoints] = useState(0);
  const [giftCode, setGiftCode] = useState('');
  const [giftAmount, setGiftAmount] = useState('0');
  const [clockedIn, setClockedIn] = useState(false);
  const [view, setView] = useState<'register' | 'inventory' | 'orders'>('register');
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quickKeys, setQuickKeys] = useState<QuickKey[]>([]);
  const [quickGroup, setQuickGroup] = useState('All');
  const [heldTransactions, setHeldTransactions] = useState<HeldTransaction[]>([]);
  const [utility, setUtility] = useState<'none' | 'resume' | 'discount' | 'drawer' | 'hardware' | 'return'>('none');
  const [returnOrder, setReturnOrder] = useState<Receipt | null>(null);
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [returnReason, setReturnReason] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [orderDiscount, setOrderDiscount] = useState('');
  const [online, setOnline] = useState(true);
  const scanInput = useRef<HTMLInputElement>(null);
  const scannerBuffer = useRef('');
  const scannerAt = useRef(0);
  const lastScan = useRef({ value: '', at: 0 });
  const localSubtotal = useMemo(() => cart.reduce((sum, line) => sum + BigInt(line.priceMinor ?? 0) * BigInt(line.quantity), 0n), [cart]);
  const subtotal = quote ? BigInt(quote.subtotalMinor) : localSubtotal;
  const discount = quote ? BigInt(quote.discountMinor) : 0n;
  const projectedTax = quote ? BigInt(quote.taxMinor) : (subtotal * BigInt(taxRate) + 5000n) / 10000n;
  const total = quote ? BigInt(quote.totalMinor) : subtotal + projectedTax;

  useEffect(() => {
    void (async () => {
      const [shiftResult, sessionResult, storeResult, keysResult] = await Promise.allSettled([api<{ clockedOutAt: string | null } | null>('/workforce/current'), api<{ id: string; status: 'OPEN' | 'CLOSING' } | null>('/register-sessions/current'), api<{ taxRateBasisPoints: number }>('/store/current'), api<QuickKey[]>('/quick-keys')]);
      if (shiftResult.status === 'fulfilled') setClockedIn(Boolean(shiftResult.value && shiftResult.value.clockedOutAt === null));
      if (sessionResult.status === 'fulfilled' && sessionResult.value?.status === 'OPEN') {
        setSessionId(sessionResult.value.id);
        setMessage('Existing register session restored. Ready to sell.');
      }
      if (storeResult.status === 'fulfilled') setTaxRate(storeResult.value.taxRateBasisPoints);
      if (keysResult.status === 'fulfilled' && Array.isArray(keysResult.value)) setQuickKeys(keysResult.value);
      setOnline([shiftResult, sessionResult, storeResult].some((result) => result.status === 'fulfilled'));
    })();
  }, []);
  useEffect(() => {
    let active = true;
    if (!cart.length) {
      setQuote(null);
      return () => {
        active = false;
      };
    }
    const timer = window.setTimeout(() => {
      void api<CheckoutQuote>('/checkout/quote', {
        method: 'POST',
        body: JSON.stringify({
          lines: cart.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
        }),
      })
        .then((result) => {
          if (active) setQuote(isCheckoutQuote(result) ? result : null);
        })
        .catch((error) => {
          if (active) {
            setQuote(null);
            setMessage(error instanceof Error ? error.message : 'Could not calculate promotions');
          }
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [cart]);

  const addItem = useCallback((item: CatalogItem) => {
    if (!item.active) {
      setMessage('This product is inactive and cannot be sold.');
      return;
    }
    if (item.priceMinor === null) {
      setMessage('This product has no active selling price.');
      return;
    }
    setCart((lines) => {
      const found = lines.find((line) => line.variantId === item.variantId);
      return found ? lines.map((line) => (line.variantId === item.variantId ? { ...line, quantity: line.quantity + 1 } : line)) : [...lines, { ...item, quantity: 1 }];
    });
    setMessage(`${item.productName} added.`);
  }, []);
  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) {
      setSearchResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api<CatalogItem[]>(`/catalog/lookup?search=${encodeURIComponent(value)}`)
        .then((items) => {
          if (active) {
            setSearchResults(items);
            setHighlightedResult(0);
          }
        })
        .catch((error) => {
          if (active) {
            setSearchResults([]);
            setMessage(error instanceof Error ? error.message : 'Product search failed');
          }
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  function selectSearchResult(item: CatalogItem): void {
    if (priceCheckMode) {
      setMessage(`${item.productName} · ${item.variantName}: ${item.priceMinor === null ? 'No active price' : money(item.priceMinor)}.`);
      setPriceCheckMode(false);
    } else addItem(item);
    setQuery('');
    setSearchResults([]);
    setHighlightedResult(0);
    scanInput.current?.focus();
  }
  async function lookupValue(rawValue = query): Promise<void> {
    const value = rawValue.trim();
    if (!value) return;
    const now = Date.now();
    if (lastScan.current.value === value && now - lastScan.current.at < 35) return;
    lastScan.current = { value, at: now };
    try {
      const exact = await api<CatalogItem[]>(`/catalog/lookup?barcode=${encodeURIComponent(value)}`);
      const items = exact.length ? exact : await api<CatalogItem[]>(`/catalog/lookup?search=${encodeURIComponent(value)}`);
      if (!items[0]) setMessage('Product not found. No item was created.');
      else if (exact.length === 1) {
        selectSearchResult(items[0]);
      } else {
        setSearchResults(items);
        setMessage(`${items.length} matches. Choose an item below.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Lookup failed');
    }
    scanInput.current?.focus();
  }
  useEffect(() => {
    const capture = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select') || event.ctrlKey || event.altKey || event.metaKey) return;
      const now = Date.now();
      if (now - scannerAt.current > 80) scannerBuffer.current = '';
      scannerAt.current = now;
      if (event.key === 'Enter') {
        const value = scannerBuffer.current; scannerBuffer.current = '';
        if (value.length >= 4) { event.preventDefault(); void lookupValue(value); }
      } else if (event.key.length === 1) scannerBuffer.current += event.key;
    };
    window.addEventListener('keydown', capture);
    return () => window.removeEventListener('keydown', capture);
  });
  async function openRegister(): Promise<void> {
    try {
      const existing = await api<{ id: string; status: 'OPEN' | 'CLOSING' } | null>('/register-sessions/current');
      if (existing?.status === 'OPEN') {
        setSessionId(existing.id);
        setMessage('Existing register session restored. Ready to sell.');
        return;
      }
      const [session, store] = await Promise.all([
        api<{ id: string }>('/register-sessions/open', {
          method: 'POST',
          body: JSON.stringify({ openingCashMinor: '10000' }),
        }),
        api<{ taxRateBasisPoints: number }>('/store/current'),
      ]);
      setSessionId(session.id);
      setTaxRate(store.taxRateBasisPoints);
      setMessage('Register open. Ready to sell.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open register');
    }
  }
  async function checkout(kind: 'cash' | 'terminal', tendered = total.toString()): Promise<void> {
    if (!sessionId) {
      setMessage('Open the register before checkout.');
      return;
    }
    try {
      const result = await api<{ orderId: string }>(`/checkout/${kind}`, {
        method: 'POST',
        body: JSON.stringify({
          registerSessionId: sessionId,
          idempotencyKey: crypto.randomUUID(),
          lines: cart.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
          ...(orderDiscount && BigInt(orderDiscount) > 0n ? { orderDiscount: { kind: 'FIXED', amountMinor: orderDiscount }, overrideReason } : {}),
          ageVerified,
          ...(customer ? { customerId: customer.id } : {}),
          ...(kind === 'cash' ? { tenderedMinor: tendered } : { simulatedOutcome: 'APPROVED' }),
        }),
      });
      await finishSale(result.orderId);
      if (kind === 'cash' && window.rjpos) {
        const drawerResult = await window.rjpos.openDrawer({ orderId: result.orderId });
        if (!drawerResult.ok) setMessage(`Sale complete. ${drawerResult.message}`);
      }
    } catch (error) {
      setMessage(kind === 'terminal' && error instanceof Error && error.message.includes('cannot reach') ? 'Payment status is unknown. Do not retry until the order is checked.' : error instanceof Error ? error.message : 'Checkout failed');
    }
  }
  async function finishSale(orderId: string): Promise<void> {
    setReceipt(await api<Receipt>(`/orders/${orderId}/receipt`));
    setCart([]);
    setAgeVerified(false);
    setCustomer(null);
    setLoyaltyPoints(0);
    setGiftCode('');
    setGiftAmount('0');
    setOrderDiscount('');
    setOverrideReason('');
    setMessage('Sale complete. Receipt ready to print.');
  }
  async function findCustomers(): Promise<void> {
    try {
      const result = await api<{ items: Customer[] }>(`/customers?search=${encodeURIComponent(customerSearch)}&active=true`);
      setCustomerResults(result.items);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Customer search failed');
    }
  }
  async function selectCustomer(selected: Customer): Promise<void> {
    try {
      const [detail, program] = await Promise.all([api<Customer>(`/customers/${selected.id}`), api<LoyaltyProgram>('/loyalty/program')]);
      setCustomer(detail);
      setLoyaltyProgram(program);
      setCustomerResults([]);
      setCustomerSearch('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Customer selection failed');
    }
  }
  async function mixedCheckout(kind: 'CASH' | 'TERMINAL'): Promise<void> {
    if (!sessionId) {
      setMessage('Open the register before checkout.');
      return;
    }
    try {
      const amount = BigInt(giftAmount || '0');
      const benefit = amount + BigInt(loyaltyPoints) * BigInt(loyaltyProgram?.redeemMinorPerPoint ?? '0');
      const rawRemainder = total - benefit;
      if (kind === 'TERMINAL' && rawRemainder <= 0n) throw new Error('TERMINAL_AMOUNT_REQUIRED');
      const remainder = rawRemainder < 0n ? 0n : rawRemainder;
      const result = await api<{ orderId: string }>('/checkout/mixed', {
        method: 'POST',
        body: JSON.stringify({
          registerSessionId: sessionId,
          idempotencyKey: crypto.randomUUID(),
          lines: cart.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
          ageVerified,
          ...(customer ? { customerId: customer.id } : {}),
          ...(giftCode && amount > 0n
            ? {
                giftCards: [{ code: giftCode, amountMinor: amount.toString() }],
              }
            : {}),
          ...(loyaltyPoints > 0 ? { loyaltyPoints } : {}),
          remainder: kind === 'CASH' ? { kind, tenderedMinor: remainder.toString() } : { kind, simulatedOutcome: 'APPROVED' },
        }),
      });
      await finishSale(result.orderId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Split checkout failed');
    }
  }
  async function toggleClock(): Promise<void> {
    try {
      if (!clockedIn) {
        const existing = await api<{ clockedOutAt: string | null } | null>('/workforce/current');
        if (existing?.clockedOutAt === null) {
          setClockedIn(true);
          setMessage('Existing clock-in restored.');
          return;
        }
      }
      const shift = await api<{ clockedOutAt: string | null }>(`/workforce/${clockedIn ? 'clock-out' : 'clock-in'}`, { method: 'POST', body: '{}' });
      const active = shift.clockedOutAt === null;
      setClockedIn(active);
      setMessage(active ? 'Clocked in.' : 'Clocked out.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Time clock failed');
    }
  }
  async function loadHistory(): Promise<void> {
    try {
      setHistory(await api('/orders'));
      setView('orders');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'History failed');
    }
  }
  async function showReturns(): Promise<void> {
    try {
      setHistory(await api('/orders'));
      setReturnOrder(null);
      setReturnQuantities({});
      setReturnReason('');
      setUtility('return');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load refundable orders.');
    }
  }
  async function selectReturnOrder(orderId: string): Promise<void> {
    try {
      const selected = await api<Receipt>(`/orders/${orderId}/receipt`);
      setReturnOrder(selected);
      setReturnQuantities({});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load the order.');
    }
  }
  function refundedQuantity(order: Receipt, orderItemId: string): number {
    return (order.refunds ?? []).filter((refund) => refund.status === 'SUCCEEDED')
      .flatMap((refund) => refund.items).filter((item) => item.orderItemId === orderItemId)
      .reduce((sum, item) => sum + item.quantity, 0);
  }
  async function submitReturn(): Promise<void> {
    if (!returnOrder) return;
    const items = returnOrder.items.flatMap((item) => {
      const quantity = returnQuantities[item.id] ?? 0;
      return quantity > 0 ? [{ orderItemId: item.id, quantity, returnToStock: true }] : [];
    });
    if (!returnReason.trim() || items.length === 0) {
      setMessage('Choose at least one item and enter a return reason.');
      return;
    }
    try {
      await api(`/orders/${returnOrder.id}/refund`, { method: 'POST', body: JSON.stringify({ reason: returnReason, idempotencyKey: crypto.randomUUID(), items }) });
      setUtility('none');
      setReturnOrder(null);
      setMessage('Return completed. Refund and stock movement were recorded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Return could not be completed.');
    }
  }
  async function loadInventory(): Promise<void> {
    try {
      setInventory(await api('/inventory'));
      setView('inventory');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Inventory failed');
    }
  }
  async function closeRegister(): Promise<void> {
    if (!sessionId) return;
    try {
      await api(`/register-sessions/${sessionId}/close`, {
        method: 'POST',
        body: JSON.stringify({ countedCashMinor: '10000' }),
      });
      setSessionId('');
      setMessage('Register closed. Cash difference is recorded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not close register');
    }
  }
  async function endShift(): Promise<void> {
    try {
      if (sessionId) {
        await api(`/register-sessions/${sessionId}/close`, { method: 'POST', body: JSON.stringify({ countedCashMinor: '10000' }) });
        setSessionId('');
      }
      if (clockedIn) {
        await api('/workforce/clock-out', { method: 'POST', body: '{}' });
        setClockedIn(false);
      }
      setMessage('Shift ended. Register closed and cashier clocked out.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not end shift.'); }
  }
  function voidCart(): void {
    if (!cart.length) return;
    setCart([]); setCustomer(null); setAgeVerified(false); setOrderDiscount(''); setOverrideReason('');
    setMessage('Current cart cleared. No sale was recorded.');
  }
  async function holdSale(): Promise<void> {
    if (!cart.length) { setMessage('Add an item before holding this sale.'); return; }
    try {
      await api('/held-transactions', { method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), label: customer?.name || `Cart · ${cart.length} item${cart.length === 1 ? '' : 's'}`, cart: { lines: cart, ...(customer ? { customerId: customer.id } : {}), ageVerified } }) });
      setCart([]); setCustomer(null); setAgeVerified(false); setMessage('Sale held. You can resume it from this register.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not hold sale.'); }
  }
  async function showHeld(): Promise<void> {
    try { setHeldTransactions(await api('/held-transactions')); setUtility('resume'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load held sales.'); }
  }
  async function resumeSale(id: string): Promise<void> {
    try {
      const result = await api<{ cart: { lines: CartLine[]; customerId?: string; ageVerified?: boolean }; pricingRevalidated: boolean }>(`/held-transactions/${id}/resume`, { method: 'POST', body: '{}' });
      setCart(result.cart.lines); setAgeVerified(Boolean(result.cart.ageVerified)); setUtility('none'); setMessage('Held sale resumed. Prices and promotions were rechecked.');
      if (result.cart.customerId) await selectCustomer({ id: result.cart.customerId, name: '', email: null, phone: null });
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not resume sale.'); }
  }
  async function manualDrawerOpen(): Promise<void> {
    const reason = overrideReason.trim();
    if (!reason) { setMessage('Enter a reason for the manual drawer open.'); return; }
    if (!window.rjpos) { setMessage('Cash drawer controls are available in the register application.'); return; }
    const result = await window.rjpos.openDrawer({ reason });
    setMessage(result.message); if (result.ok) { setUtility('none'); setOverrideReason(''); }
  }
  async function printCurrentReceipt(): Promise<void> {
    if (!receipt) return;
    if (!window.rjpos) { window.print(); return; }
    const result = await window.rjpos.printReceipt(receipt.id); setMessage(result.message);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">RJ POS</span>
          <h1>Downtown Register</h1>
        </div>
        <div className={`status ${sessionId ? 'open' : ''}`}>
          <span />
          {sessionId ? 'Register open' : 'Register closed'}
        </div>
        <div className={`status ${online ? 'open' : 'offline'}`}><span />{online ? 'Server online' : 'Server unavailable'}</div>
        <div className="cashier-summary"><strong>Demo Owner</strong><small>{clockedIn ? 'Clocked in' : 'Clocked out'} · {customer?.name ?? 'Walk-in'}</small></div>
        <nav>
          <button onClick={() => setView('register')}>Register</button>
          <button onClick={() => void loadInventory()}>Inventory</button>
          <button onClick={() => void loadHistory()}>Orders</button>
        </nav>
      </header>
      {view === 'register' && (<>
        <div className="register-grid">
          <section className="workspace">
            <div className="session-actions">
              {!sessionId ? (
                <button className="primary" onClick={() => void openRegister()}>
                  Open register · $100.00
                </button>
              ) : (
                <button className="quiet" onClick={() => void closeRegister()}>
                  Close register
                </button>
              )}
              <button className="quiet" onClick={() => void toggleClock()}>
                {clockedIn ? 'Clock out' : 'Clock in'}
              </button>
              <p>{message}</p>
            </div>
            <div className="scanbox">
              <label htmlFor="scan">Scan UPC, enter SKU, or search products</label>
              <div>
                <input
                  id="scan"
                  ref={scanInput}
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && searchResults.length) {
                      event.preventDefault();
                      setHighlightedResult((value) => (value + 1) % searchResults.length);
                    }
                    if (event.key === 'ArrowUp' && searchResults.length) {
                      event.preventDefault();
                      setHighlightedResult((value) => (value - 1 + searchResults.length) % searchResults.length);
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (searchResults[highlightedResult]) selectSearchResult(searchResults[highlightedResult]);
                      else void lookupValue();
                    }
                    if (event.key === 'Escape') {
                      setQuery('');
                      setSearchResults([]);
                    }
                  }}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={searchResults.length > 0}
                  aria-controls="product-search-results"
                  aria-activedescendant={searchResults[highlightedResult] ? `product-result-${searchResults[highlightedResult].variantId}` : undefined}
                  placeholder={priceCheckMode ? 'Price check: scan or search…' : 'Scan barcode…'}
                />
                <button onClick={() => void lookupValue()}>Find</button>
              </div>
              {searchResults.length > 0 && (
                <div className="product-search-results" id="product-search-results" role="listbox" aria-label="Product search results">
                  {searchResults.map((item) => (
                    <button id={`product-result-${item.variantId}`} key={item.variantId} role="option" aria-selected={highlightedResult === searchResults.indexOf(item)} className={highlightedResult === searchResults.indexOf(item) ? 'highlighted' : ''} onMouseEnter={() => setHighlightedResult(searchResults.indexOf(item))} onClick={() => selectSearchResult(item)}>
                      <span><strong>{item.productName}</strong><small>{item.variantName} · {item.sku}{item.barcode ? ` · ${item.barcode}` : ''}</small></span>
                      <b>{item.priceMinor === null ? 'No price' : money(item.priceMinor)}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <section className="quick-keys" aria-label="Quick Add">
              <div className="quick-title"><h2>Quick Add</h2>{quickKeys.length === 0 && <small>No quick items configured.</small>}</div>
              {quickKeys.length > 0 && <>
                <div className="quick-groups"><button className={quickGroup === 'All' ? 'active' : ''} onClick={() => setQuickGroup('All')}>All</button>{[...new Set(quickKeys.map((key) => key.groupName))].map((group) => <button className={quickGroup === group ? 'active' : ''} key={group} onClick={() => setQuickGroup(group)}>{group}</button>)}</div>
                <div className="quick-grid">{quickKeys.filter((key) => quickGroup === 'All' || key.groupName === quickGroup).map((key) => <button key={key.id} disabled={!key.active || key.priceMinor === null} onClick={() => addItem(key)}><strong>{key.label}</strong><small>{key.priceMinor ? money(key.priceMinor) : 'No price'}</small></button>)}</div>
              </>}
            </section>
            <div className="cart-head">
              <h2>Current sale</h2>
              <button className="text" onClick={() => setCart([])}>
                Clear cart
              </button>
            </div>
            <div className="cart">
              {cart.length === 0 && (
                <div className="empty">
                  Your cart is empty.
                  <br />
                  <small>Scanned items appear here.</small>
                </div>
              )}
              {cart.map((line) => {
                const priced = quote?.lines.find((item) => item.variantId === line.variantId);
                return (
                  <article key={line.variantId} className="line">
                    <div>
                      <strong>{line.productName}</strong>
                      <small>
                        {line.variantName} · {line.sku}
                        {line.ageRestricted ? ' · 21+' : ''}
                      </small>
                      {priced?.promotionName && (
                        <small>
                          {priced.promotionName} · save {money(priced.discountMinor)}
                        </small>
                      )}
                    </div>
                    <div className="quantity">
                      <button onClick={() => setCart((rows) => rows.flatMap((row) => (row.variantId !== line.variantId ? [row] : row.quantity === 1 ? [] : [{ ...row, quantity: row.quantity - 1 }])))}>−</button>
                      <input
                        aria-label="Quantity"
                        value={line.quantity}
                        onChange={(event) => {
                          const quantity = Math.max(1, Number(event.target.value) || 1);
                          setCart((rows) => rows.map((row) => (row.variantId === line.variantId ? { ...row, quantity } : row)));
                        }}
                      />
                      <button onClick={() => setCart((rows) => rows.map((row) => (row.variantId === line.variantId ? { ...row, quantity: row.quantity + 1 } : row)))}>+</button>
                    </div>
                    <b>
                      {priced && BigInt(priced.discountMinor) > 0n ? (
                        <>
                          <s>{money(priced.subtotalMinor)}</s>
                          <br />
                          {money(priced.totalMinor)}
                        </>
                      ) : (
                        money(BigInt(line.priceMinor!) * BigInt(line.quantity))
                      )}
                    </b>
                  </article>
                );
              })}
            </div>
          </section>
          <aside className="checkout">
            <h2>Checkout</h2>
            <dl>
              <div>
                <dt>Subtotal</dt>
                <dd>{money(subtotal)}</dd>
              </div>
              {discount > 0n && (
                <div>
                  <dt>Promotions</dt>
                  <dd>−{money(discount)}</dd>
                </div>
              )}
              <div>
                <dt>Projected tax</dt>
                <dd>{money(projectedTax)}</dd>
              </div>
              <div className="total">
                <dt>Total</dt>
                <dd>{money(total)}</dd>
              </div>
            </dl>
            <section className="customer-panel">
              <strong>{customer ? customer.name : 'Walk-in customer'}</strong>
              {customer ? (
                <>
                  <small>
                    {customer.pointsBalance ?? 0} points · projected earn {loyaltyProgram?.enabled ? Math.floor(Number(total) / Number(loyaltyProgram.spendMinor)) * loyaltyProgram.pointsEarned : 0}
                  </small>
                  <button
                    className="text"
                    onClick={() => {
                      setCustomer(null);
                      setLoyaltyPoints(0);
                    }}
                  >
                    Remove customer
                  </button>
                </>
              ) : (
                <>
                  <div>
                    <input aria-label="Customer search" value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Find customer" />
                    <button onClick={() => void findCustomers()}>Find</button>
                  </div>
                  {customerResults.map((result) => (
                    <button className="customer-result" key={result.id} onClick={() => void selectCustomer(result)}>
                      {result.name} · {result.phone || result.email || 'No contact'}
                    </button>
                  ))}
                </>
              )}
            </section>
            {customer && loyaltyProgram?.enabled && (
              <label className="benefit-field">
                Redeem loyalty points
                <input aria-label="Loyalty points" type="number" min="0" max={customer.pointsBalance ?? 0} value={loyaltyPoints} onChange={(event) => setLoyaltyPoints(Number(event.target.value) || 0)} />
              </label>
            )}
            <div className="gift-fields">
              <label>
                Gift-card code
                <input aria-label="Gift-card code" value={giftCode} onChange={(event) => setGiftCode(event.target.value)} />
              </label>
              <label>
                Redeem cents
                <input aria-label="Gift-card amount" type="number" min="0" value={giftAmount} onChange={(event) => setGiftAmount(event.target.value)} />
              </label>
            </div>
            {cart.some((line) => line.ageRestricted) && (
              <label className="age">
                <input type="checkbox" checked={ageVerified} onChange={(event) => setAgeVerified(event.target.checked)} />I verified the customer is of legal age.
              </label>
            )}
            <div className="payment-row">
              <button className="pay card" disabled={!cart.length || !sessionId} onClick={() => void checkout('terminal')}>CARD</button>
              <button className="pay cash" disabled={!cart.length || !sessionId} onClick={() => void checkout('cash', cashTendered || total.toString())}>CASH</button>
              {[5, 10, 20, 50, 100].map((amount) => <button key={amount} disabled={!cart.length || !sessionId || BigInt(amount * 100) < total} onClick={() => { setCashTendered(String(amount * 100)); void checkout('cash', String(amount * 100)); }}>${amount}</button>)}
              <button disabled={!cart.length || !sessionId} onClick={() => void checkout('cash', total.toString())}>EXACT</button>
            </div>
            {(giftCode || loyaltyPoints > 0) && (
              <>
                <button className="pay cash" disabled={!cart.length || !sessionId} onClick={() => void mixedCheckout('CASH')}>
                  Split with cash
                </button>
                <button className="pay card" disabled={!cart.length || !sessionId} onClick={() => void mixedCheckout('TERMINAL')}>
                  Split with terminal
                </button>
              </>
            )}
            <small>Final pricing, benefits, and inventory are verified by the server.</small>
          </aside>
        </div>
        <div className="action-bar" aria-label="Register actions">
          <button onClick={() => setUtility('discount')}>Discount / Price</button>
          <button className={priceCheckMode ? 'confirmed' : ''} onClick={() => { setPriceCheckMode(true); scanInput.current?.focus(); setMessage('Price-check mode: scan or select an item. It will not be added to the cart.'); }}>Price Check</button>
          <button onClick={() => document.querySelector<HTMLInputElement>('[aria-label="Customer search"]')?.focus()}>Customer</button>
          <button disabled={!cart.some((line) => line.ageRestricted)} className={ageVerified ? 'confirmed' : ''} onClick={() => setAgeVerified((value) => !value)}>Age Check</button>
          <button disabled={!cart.length} onClick={() => void holdSale()}>Hold</button>
          <button onClick={() => void showHeld()}>Resume</button>
          <button disabled={!cart.length} className="danger" onClick={voidCart}>Void Cart</button>
          <button onClick={() => void showReturns()}>Return</button>
          <button disabled={!receipt} onClick={() => void printCurrentReceipt()}>Reprint</button>
          <button onClick={() => setUtility('drawer')}>Drawer</button>
          <button onClick={() => document.querySelector<HTMLInputElement>('[aria-label="Gift-card code"]')?.focus()}>Gift Card</button>
          <button disabled={!sessionId && !clockedIn} className="danger" onClick={() => void endShift()}>End Shift</button>
        </div>
      </>)}
      {view === 'inventory' && (
        <section className="management">
          <span className="eyebrow">Management</span>
          <h2>Inventory</h2>
          <p>Every opening balance and reason-coded adjustment creates a ledger movement and audit record.</p>
          {inventory.map((level) => (
            <article className="history" key={level.id}>
              <strong>
                {level.variant.product.name} · {level.variant.name}
              </strong>
              <span>{level.variant.sku}</span>
              <b>{level.onHand - level.reserved} available</b>
            </article>
          ))}
          <button onClick={() => setView('register')}>Back to register</button>
        </section>
      )}
      {view === 'orders' && (
        <section className="management">
          <span className="eyebrow">Sales history</span>
          <h2>Recent orders</h2>
          {history.map((order) => (
            <article className="history" key={order.id}>
              <strong>{order.orderNumber}</strong>
              <span>{order.status}</span>
              <b>{money(order.totalMinor)}</b>
            </article>
          ))}
          <button onClick={() => setView('register')}>Back to register</button>
        </section>
      )}
      {utility !== 'none' && (
        <div className="modal" role="dialog" aria-label={`${utility} utility`}>
          <section className="utility-modal">
            <button className="close" aria-label="Close" onClick={() => setUtility('none')}>×</button>
            {utility === 'resume' && <><h2>Resume a held sale</h2>{heldTransactions.length === 0 ? <p>No held sales on this register.</p> : heldTransactions.map((held) => <button className="held-sale" key={held.id} onClick={() => void resumeSale(held.id)}><strong>{held.label}</strong><span>{new Date(held.heldAt).toLocaleTimeString()} · {held.employee.firstName} {held.employee.lastName}</span><small>{held.cartJson.lines.length} lines{held.customer ? ` · ${held.customer.name}` : ''}</small></button>)}</>}
            {utility === 'return' && <><h2>Return items</h2>{!returnOrder ? <>{history.filter((order) => ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.status)).map((order) => <button className="held-sale" key={order.id} onClick={() => void selectReturnOrder(order.id)}><strong>{order.orderNumber}</strong><span>{order.status}</span><small>{money(order.totalMinor)}</small></button>)}{history.every((order) => !['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.status)) && <p>No refundable orders found.</p>}</> : <><button className="text" onClick={() => setReturnOrder(null)}>← Choose another order</button><p><strong>{returnOrder.orderNumber}</strong></p>{returnOrder.items.map((item) => { const remaining = item.quantity - refundedQuantity(returnOrder, item.id); return <label className="return-line" key={item.id}><span>{item.productNameSnapshot} · {item.variantNameSnapshot}<small>{remaining} available to return</small></span><input aria-label={`Return quantity for ${item.productNameSnapshot}`} type="number" min="0" max={remaining} disabled={remaining === 0} value={returnQuantities[item.id] ?? 0} onChange={(event) => setReturnQuantities((current) => ({ ...current, [item.id]: Math.min(remaining, Math.max(0, Number(event.target.value) || 0)) }))} /></label>; })}<label>Required reason<input aria-label="Return reason" value={returnReason} onChange={(event) => setReturnReason(event.target.value)} /></label><button className="danger" disabled={!returnReason.trim() || !Object.values(returnQuantities).some((quantity) => quantity > 0)} onClick={() => void submitReturn()}>Confirm refund and return to stock</button></>}</>}
            {utility === 'discount' && <><h2>Manager price override</h2><p>The server records the reason and manager identity.</p><label>Discount amount, cents<input inputMode="numeric" aria-label="Override discount cents" value={orderDiscount} onChange={(event) => setOrderDiscount(event.target.value.replace(/\D/g, ''))} /></label><label>Required reason<input aria-label="Override reason" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label><button className="primary" disabled={!orderDiscount || !overrideReason.trim()} onClick={() => { setUtility('none'); setMessage('Price override ready. It will be audited when payment completes.'); }}>Apply to sale</button></>}
            {utility === 'drawer' && <><h2>Manual drawer open</h2><p className="warning">Manager authorization and a reason are required. This action is audited.</p><label>Reason<input aria-label="Drawer reason" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label><button className="danger" onClick={() => void manualDrawerOpen()}>Authorize and open drawer</button></>}
          </section>
        </div>
      )}
      {receipt && (
        <div className="modal" role="dialog" aria-label="Receipt">
          <section className="receipt">
            <button className="close" onClick={() => setReceipt(null)}>
              ×
            </button>
            <span className="eyebrow">RJ POS · Downtown</span>
            <h2>Receipt</h2>
            <p>{receipt.orderNumber}</p>
            {receipt.items.map((item) => (
              <div className="receipt-line" key={item.id}>
                <span>
                  {item.quantity} × {item.productNameSnapshot} {item.variantNameSnapshot}
                  {item.promotionNameSnapshot && (
                    <small>
                      {item.promotionNameSnapshot} · saved {money(item.discountMinor)}
                    </small>
                  )}
                </span>
                <b>{money(item.totalMinor)}</b>
              </div>
            ))}
            <hr />
            <div className="receipt-line">
              <span>Subtotal</span>
              <b>{money(receipt.subtotalMinor)}</b>
            </div>
            {BigInt(receipt.discountMinor) > 0n && (
              <div className="receipt-line">
                <span>Promotions</span>
                <b>−{money(receipt.discountMinor)}</b>
              </div>
            )}
            <div className="receipt-line">
              <span>Tax</span>
              <b>{money(receipt.taxMinor)}</b>
            </div>
            <div className="receipt-line grand">
              <span>Total</span>
              <b>{money(receipt.totalMinor)}</b>
            </div>
            <button className="primary" onClick={() => void printCurrentReceipt()}>
              Print receipt
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
