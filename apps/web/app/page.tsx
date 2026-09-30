'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './register.css';
import './register-pos.css';
import { api, adjustmentToDiscount, friendlyError, getApiSessionToken, loadStoredSession, money, parseDollarsToMinor, setApiSession, storeSession, type DiscountBody, type PriceAdjustment, type RegisterSession } from './register-api';
import { CartLine } from './cart-line';
import { InventoryView } from './inventory-view';
import { LockScreen } from './register-lock';
import { AgeCheckDialog, CashOperationsDialog, cashKindNeedsApproval, CustomerCreateForm, CustomerDialog, DiscountDialog, ElevationDialog, GiftCardDialog, isElevationActive, OpenRegisterDialog, SaleCompleteDialog, ShiftReportView, TenderDialog, type CashKind, type Elevation, type SaleSummary, type ShiftReport } from './register-dialogs';
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
type ReturnDisposition = 'RETURN_TO_STOCK' | 'DAMAGED' | 'NON_RESELLABLE' | 'VENDOR_RETURN';
const DISPOSITION_LABELS: Record<ReturnDisposition, string> = { RETURN_TO_STOCK: 'Return to stock', DAMAGED: 'Damaged', NON_RESELLABLE: 'Non-resellable', VENDOR_RETURN: 'Vendor return' };
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

function RegisterWorkspace({ session, onLock }: { session: RegisterSession; onLock: () => void }): React.ReactNode {
  const [sessionId, setSessionId] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CatalogItem[]>([]);
  const [highlightedResult, setHighlightedResult] = useState(0);
  const [priceCheckMode, setPriceCheckMode] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [message, setMessage] = useState('Open the register to begin selling.');
  const [ageVerified, setAgeState] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      orderNumber: string;
      status: string;
      totalMinor: string;
    }>
  >([]);
  const [storeName, setStoreName] = useState('Downtown');
  const endedShift = useRef(false);
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
  const [utility, setUtility] = useState<'none' | 'resume' | 'discount' | 'drawer' | 'hardware' | 'return' | 'approve' | 'open' | 'customer' | 'close' | 'report' | 'age' | 'tender' | 'customerPanel' | 'gift' | 'cash'>('none');
  const [returnDispositions, setReturnDispositions] = useState<Record<string, ReturnDisposition>>({});
  const [quickPage, setQuickPage] = useState(0);
  const [saleSummary, setSaleSummary] = useState<SaleSummary | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [storeTimezone, setStoreTimezone] = useState<string | undefined>(undefined);
  const ageRef = useRef(false);
  const [elevation, setElevation] = useState<Elevation | null>(null);
  const [approveReason, setApproveReason] = useState('');
  const pendingAction = useRef<(() => void) | null>(null);
  const elevationRef = useRef<Elevation | null>(null);
  const [cartAdjustment, setCartAdjustment] = useState<PriceAdjustment | null>(null);
  const [lineAdjustments, setLineAdjustments] = useState<Record<string, PriceAdjustment>>({});
  const [closeCash, setCloseCash] = useState('');
  const [closeWithClockOut, setCloseWithClockOut] = useState(false);
  const [shiftReport, setShiftReport] = useState<ShiftReport | null>(null);
  const [returnOrder, setReturnOrder] = useState<Receipt | null>(null);
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [returnReason, setReturnReason] = useState('');
  const [cashTendered, setCashTendered] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
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
  // Manual discounts/custom prices are described client-side but always priced by the server (quote and checkout).
  const adjustments = useMemo(() => {
    const lines: Array<{ variantId: string; quantity: number; discount?: DiscountBody }> = cart.map((line) => {
      const adjustment = lineAdjustments[line.variantId];
      return { variantId: line.variantId, quantity: line.quantity, ...(adjustment && line.priceMinor !== null ? { discount: adjustmentToDiscount(adjustment, BigInt(line.priceMinor), line.quantity) } : {}) };
    });
    const orderDiscount = cartAdjustment ? adjustmentToDiscount(cartAdjustment, 0n, 1) : undefined;
    return { lines, orderDiscount, active: Boolean(orderDiscount) || lines.some((line) => line.discount) };
  }, [cart, lineAdjustments, cartAdjustment]);
  function currentElevation(): Elevation | null { return isElevationActive(elevationRef.current) ? elevationRef.current : null; }
  function sessionHint(): { sessionToken?: string } { const token = getApiSessionToken(); return token ? { sessionToken: token } : {}; }
  function withApproval(): { elevationToken?: string } { const approval = currentElevation(); return approval ? { elevationToken: approval.token } : {}; }
  function grantElevation(granted: Elevation | null): void { elevationRef.current = granted; setElevation(granted); }
  function requireElevation(reason: string, action: () => void): void {
    if (session.role !== 'CASHIER' || currentElevation()) { action(); return; }
    pendingAction.current = action; setApproveReason(reason); setUtility('approve');
  }
  function closeUtility(): void {
    pendingAction.current = null;
    // Closing the end-of-shift report finishes the shift: the employee is signed out.
    if (utility === 'report' && endedShift.current) { onLock(); return; }
    setUtility('none');
  }
  function removeLine(variantId: string): void {
    setCart((rows) => rows.filter((row) => row.variantId !== variantId));
    setLineAdjustments((current) => { const { [variantId]: _removed, ...rest } = current; return rest; });
  }
  function setQuantity(variantId: string, quantity: number): void {
    if (quantity <= 0) { removeLine(variantId); return; }
    setCart((rows) => rows.map((row) => (row.variantId === variantId ? { ...row, quantity } : row)));
  }
  function clearAdjustments(): void { setCartAdjustment(null); setLineAdjustments({}); }

  useEffect(() => {
    void (async () => {
      const [shiftResult, sessionResult, storeResult, keysResult] = await Promise.allSettled([api<{ clockedOutAt: string | null } | null>('/workforce/current'), api<{ id: string; status: 'OPEN' | 'CLOSING' } | null>('/register-sessions/current'), api<{ taxRateBasisPoints: number; name?: string; timezone?: string }>('/store/current'), api<QuickKey[]>('/quick-keys')]);
      if (shiftResult.status === 'fulfilled') setClockedIn(Boolean(shiftResult.value && shiftResult.value.clockedOutAt === null));
      if (sessionResult.status === 'fulfilled' && sessionResult.value?.status === 'OPEN') {
        setSessionId(sessionResult.value.id);
        setMessage('Existing register session restored. Ready to sell.');
      }
      if (storeResult.status === 'fulfilled') { setTaxRate(storeResult.value.taxRateBasisPoints); if (storeResult.value.name) setStoreName(storeResult.value.name); if (storeResult.value.timezone) setStoreTimezone(storeResult.value.timezone); }
      if (keysResult.status === 'fulfilled' && Array.isArray(keysResult.value)) setQuickKeys(keysResult.value);
      setOnline([shiftResult, sessionResult, storeResult].some((result) => result.status === 'fulfilled'));
    })();
  }, []);
  useEffect(() => {
    let active = true;
    if (!adjustments.lines.length) {
      setQuote(null);
      return () => {
        active = false;
      };
    }
    const timer = window.setTimeout(() => {
      void api<CheckoutQuote>('/checkout/quote', {
        method: 'POST',
        body: JSON.stringify({ lines: adjustments.lines, ...(adjustments.orderDiscount ? { orderDiscount: adjustments.orderDiscount } : {}) }),
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
  }, [adjustments]);

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
  async function openRegister(openingCashMinor = 10000n, note = ''): Promise<void> {
    try {
      const existing = await api<{ id: string; status: 'OPEN' | 'CLOSING' } | null>('/register-sessions/current');
      if (existing?.status === 'OPEN') {
        setSessionId(existing.id);
        setUtility('none');
        setMessage('Existing register session restored. Ready to sell.');
        return;
      }
      const [session, store] = await Promise.all([
        api<{ id: string }>('/register-sessions/open', {
          method: 'POST',
          body: JSON.stringify({ openingCashMinor: openingCashMinor.toString(), ...(note.trim() ? { note: note.trim() } : {}) }),
        }),
        api<{ taxRateBasisPoints: number }>('/store/current'),
      ]);
      setSessionId(session.id);
      setTaxRate(store.taxRateBasisPoints);
      setUtility('none');
      setMessage('Register open. Ready to sell.');
    } catch (error) {
      setMessage(friendlyError(error, 'Could not open register'));
    }
  }
  async function checkout(kind: 'cash' | 'terminal', tendered = total.toString()): Promise<void> {
    if (!sessionId) {
      setMessage('Open the register before checkout.');
      return;
    }
    if (cart.some((line) => line.ageRestricted) && !ageRef.current) { pendingAction.current = () => void checkout(kind, tendered); setUtility('age'); return; }
    if (adjustments.active && session.role === 'CASHIER' && !currentElevation()) { requireElevation('Approve the discount to complete this sale.', () => void checkout(kind, tendered)); return; }
    try {
      const result = await api<{ orderId: string; tenderedMinor?: string; changeDueMinor?: string }>(`/checkout/${kind}`, {
        method: 'POST',
        ...(adjustments.active ? withApproval() : {}),
        body: JSON.stringify({
          registerSessionId: sessionId,
          idempotencyKey: crypto.randomUUID(),
          lines: adjustments.lines,
          ...(adjustments.orderDiscount ? { orderDiscount: adjustments.orderDiscount } : {}),
          ageVerified: ageRef.current,
          ...(customer ? { customerId: customer.id } : {}),
          ...(kind === 'cash' ? { tenderedMinor: tendered } : { simulatedOutcome: 'APPROVED' }),
        }),
      });
      await finishSale(result.orderId, kind === 'cash' ? { tenderedMinor: result.tenderedMinor ?? tendered, changeDueMinor: result.changeDueMinor ?? (BigInt(tendered) > total ? (BigInt(tendered) - total).toString() : '0') } : undefined);
      if (kind === 'cash' && window.rjpos) {
        const drawerResult = await window.rjpos.openDrawer({ orderId: result.orderId, ...sessionHint() });
        if (!drawerResult.ok) setMessage(`Sale complete. ${drawerResult.message}`);
      }
    } catch (error) {
      setMessage(kind === 'terminal' && error instanceof Error && error.message.includes('cannot reach') ? 'Payment status is unknown. Do not retry until the order is checked.' : error instanceof Error ? error.message : 'Checkout failed');
    }
  }
  async function finishSale(orderId: string, cash?: { tenderedMinor: string; changeDueMinor: string }): Promise<void> {
    const sold = await api<Receipt>(`/orders/${orderId}/receipt`);
    setReceipt(sold);
    setReceiptOpen(!cash);
    setSaleSummary(cash ? { totalMinor: sold.totalMinor, ...cash } : null);
    setCashTendered('');
    setCart([]);
    setAge(false);
    setCustomer(null);
    setLoyaltyPoints(0);
    setGiftCode('');
    setGiftAmount('0');
    clearAdjustments();
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
    if (cart.some((line) => line.ageRestricted) && !ageRef.current) { pendingAction.current = () => void mixedCheckout(kind); setUtility('age'); return; }
    if (adjustments.active && session.role === 'CASHIER' && !currentElevation()) { requireElevation('Approve the discount to complete this sale.', () => void mixedCheckout(kind)); return; }
    try {
      const amount = BigInt(giftAmount || '0');
      const benefit = amount + BigInt(loyaltyPoints) * BigInt(loyaltyProgram?.redeemMinorPerPoint ?? '0');
      const rawRemainder = total - benefit;
      if (kind === 'TERMINAL' && rawRemainder <= 0n) throw new Error('TERMINAL_AMOUNT_REQUIRED');
      const remainder = rawRemainder < 0n ? 0n : rawRemainder;
      const result = await api<{ orderId: string; tenderedMinor?: string; changeDueMinor?: string }>('/checkout/mixed', {
        method: 'POST',
        ...(adjustments.active ? withApproval() : {}),
        body: JSON.stringify({
          registerSessionId: sessionId,
          idempotencyKey: crypto.randomUUID(),
          lines: adjustments.lines,
          ...(adjustments.orderDiscount ? { orderDiscount: adjustments.orderDiscount } : {}),
          ageVerified: ageRef.current,
          ...(customer ? { customerId: customer.id } : {}),
          ...(giftCode && amount > 0n
            ? {
                giftCards: [{ code: giftCode, amountMinor: amount.toString() }],
              }
            : {}),
          ...(loyaltyPoints > 0 ? { loyaltyPoints } : {}),
          remainder: kind === 'CASH' ? { kind, tenderedMinor: cashTendered && /^\d+$/.test(cashTendered) && BigInt(cashTendered) > remainder ? cashTendered : remainder.toString() } : { kind, simulatedOutcome: 'APPROVED' },
        }),
      });
      await finishSale(result.orderId, kind === 'CASH' ? { tenderedMinor: result.tenderedMinor ?? remainder.toString(), changeDueMinor: result.changeDueMinor ?? '0' } : undefined);
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
      setReturnDispositions({});
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
      return quantity > 0 ? [{ orderItemId: item.id, quantity, disposition: returnDispositions[item.id] ?? 'RETURN_TO_STOCK' }] : [];
    });
    if (!returnReason.trim() || items.length === 0) {
      setMessage('Choose at least one item and enter a return reason.');
      return;
    }
    try {
      await api(`/orders/${returnOrder.id}/refund`, { method: 'POST', ...withApproval(), body: JSON.stringify({ reason: returnReason, idempotencyKey: crypto.randomUUID(), items }) });
      setUtility('none');
      setReturnOrder(null);
      setMessage('Return completed. The refund and each item\u2019s disposition were recorded.');
    } catch (error) {
      setMessage(friendlyError(error, 'Return could not be completed.'));
    }
  }
  function beginClose(clockOut: boolean): void { setCloseCash(''); setCloseWithClockOut(clockOut); setUtility('close'); }
  async function loadShiftReport(id: string): Promise<void> {
    setShiftReport(await api<ShiftReport>(`/register-sessions/${id}/report`, withApproval()));
    setUtility('report');
  }
  async function confirmClose(): Promise<void> {
    const counted = parseDollarsToMinor(closeCash);
    if (counted === null) { setMessage('Enter the counted cash, for example 100.00.'); return; }
    try {
      const closingId = sessionId;
      if (closingId) {
        await api(`/register-sessions/${closingId}/close`, { method: 'POST', body: JSON.stringify({ countedCashMinor: counted.toString() }) });
        setSessionId('');
      }
      if (closeWithClockOut && clockedIn) {
        await api('/workforce/clock-out', { method: 'POST', body: '{}' });
        setClockedIn(false);
      }
      setMessage(closeWithClockOut ? 'Shift ended. Register closed and cashier clocked out.' : 'Register closed. Cash difference is recorded.');
      endedShift.current = closeWithClockOut;
      if (closingId) await loadShiftReport(closingId);
      else { setUtility('none'); if (closeWithClockOut) onLock(); }
    } catch (error) { setMessage(friendlyError(error, 'Could not close the register.')); }
  }
  function voidCart(): void {
    if (!cart.length) return;
    setCart([]); setCustomer(null); setAge(false); clearAdjustments(); setOverrideReason(''); setCashTendered('');
    setMessage('Current cart cleared. No sale was recorded.');
  }
  async function holdSale(): Promise<void> {
    if (!cart.length) { setMessage('Add an item before holding this sale.'); return; }
    try {
      await api('/held-transactions', { method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), label: customer?.name || `Cart · ${cart.length} item${cart.length === 1 ? '' : 's'}`, cart: { lines: cart, ...(customer ? { customerId: customer.id } : {}), ageVerified } }) });
      setCart([]); setCustomer(null); setAge(false); clearAdjustments(); setMessage('Sale held. You can resume it from this register.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not hold sale.'); }
  }
  async function showHeld(): Promise<void> {
    try { setHeldTransactions(await api('/held-transactions')); setUtility('resume'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load held sales.'); }
  }
  async function resumeSale(id: string): Promise<void> {
    try {
      const result = await api<{ cart: { lines: CartLine[]; customerId?: string; ageVerified?: boolean }; pricingRevalidated: boolean }>(`/held-transactions/${id}/resume`, { method: 'POST', body: '{}' });
      setCart(result.cart.lines); setAge(Boolean(result.cart.ageVerified)); setUtility('none'); setMessage('Held sale resumed. Prices and promotions were rechecked.');
      if (result.cart.customerId) await selectCustomer({ id: result.cart.customerId, name: '', email: null, phone: null });
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not resume sale.'); }
  }
  async function submitCash(kind: CashKind, amountMinor: bigint, reason: string): Promise<void> {
    if (cashKindNeedsApproval(kind) && session.role === 'CASHIER' && !currentElevation()) { requireElevation('Approve this cash adjustment.', () => void submitCash(kind, amountMinor, reason)); return; }
    try {
      await api('/register/cash-movements', { method: 'POST', ...withApproval(), body: JSON.stringify({ kind, amountMinor: amountMinor.toString(), ...(reason ? { reason } : {}) }) });
      setUtility('none'); setMessage(`${kind.replace('_', ' ').toLowerCase()} of ${money(amountMinor)} recorded.`);
    } catch (error) { setMessage(friendlyError(error, 'Could not record the cash movement.')); }
  }
  async function manualDrawerOpen(): Promise<void> {
    const reason = overrideReason.trim();
    if (!reason) { setMessage('Enter a reason for the manual drawer open.'); return; }
    if (!window.rjpos) { setMessage('Cash drawer controls are available in the register application.'); return; }
    const approval = currentElevation();
    if (!approval && session.role === 'CASHIER') { setMessage('Manager approval expired. Approve again.'); return; }
    const result = await window.rjpos.openDrawer({ reason, ...(approval ? { elevationToken: approval.token } : {}), ...sessionHint() });
    setMessage(result.message); if (result.ok) { setUtility('none'); setOverrideReason(''); }
  }
  async function printCurrentReceipt(): Promise<void> {
    if (!receipt) return;
    if (!window.rjpos) { window.print(); return; }
    const result = await window.rjpos.printReceipt(receipt.id, getApiSessionToken() ?? undefined); setMessage(result.message);
  }

  function setAge(value: boolean): void { ageRef.current = value; setAgeState(value); }
  const restricted = cart.some((line) => line.ageRestricted);
  const giftKeyed = /^\d+$/.test(giftAmount || '0') ? BigInt(giftAmount || '0') : 0n;
  const splitActive = Boolean(giftCode) || loyaltyPoints > 0;
  const benefit = splitActive ? giftKeyed + BigInt(loyaltyPoints) * BigInt(loyaltyProgram?.redeemMinorPerPoint ?? '0') : 0n;
  const giftApplied = Boolean(giftCode) && giftKeyed > 0n;
  const dueNow = benefit >= total ? 0n : total - benefit;
  const tenderedAmount = cashTendered && /^\d+$/.test(cashTendered) ? BigInt(cashTendered) : null;
  const shortBy = tenderedAmount !== null && tenderedAmount < dueNow ? dueNow - tenderedAmount : 0n;
  const changeDue = tenderedAmount !== null && tenderedAmount >= dueNow ? tenderedAmount - dueNow : 0n;
  const QUICK_PAGE_SIZE = 36;
  const groupKeys = quickKeys.filter((key) => quickGroup === 'All' || key.groupName === quickGroup);
  const quickPages = Math.max(1, Math.ceil(groupKeys.length / QUICK_PAGE_SIZE));
  const activeQuickPage = Math.min(quickPage, quickPages - 1);
  const pageKeys = groupKeys.slice(activeQuickPage * QUICK_PAGE_SIZE, (activeQuickPage + 1) * QUICK_PAGE_SIZE);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">RJ POS</span>
          <h1>{storeName} Register</h1>
        </div>
        <div className={`status ${sessionId ? 'open' : ''}`}>
          <span />
          {sessionId ? 'Register open' : 'Register closed'}
        </div>
        <div className={`status ${online ? 'open' : 'offline'}`}><span />{online ? 'Server online' : 'Server unavailable'}</div>
        <div className="cashier-summary"><strong>{session.employee.name}</strong><small>{session.role === 'OWNER' ? 'Owner' : session.role === 'MANAGER' ? 'Manager' : 'Cashier'} · {clockedIn ? 'Clocked in' : 'Clocked out'} · {customer?.name ?? 'Walk-in'}</small>{isElevationActive(elevation) && <button className="text" onClick={() => grantElevation(null)}>Approved by {elevation.approver.name} · tap to lock</button>}</div>
        <div className="header-actions">
          {!sessionId ? <button className="hdr-btn primary" onClick={() => setUtility('open')}>Open register</button> : <button className="hdr-btn" onClick={() => beginClose(false)}>Close register</button>}
          <button className="hdr-btn" onClick={() => void toggleClock()}>{clockedIn ? 'Clock out' : 'Clock in'}</button>
        </div>
        <nav>
          <button onClick={() => setView('register')}>Register</button>
          <button onClick={() => setView('inventory')}>Inventory</button>
          <button onClick={() => void loadHistory()}>Orders</button>
          <button onClick={onLock}>Lock</button>
        </nav>
      </header>
      {view === 'register' && (<>
        <div className="pos">
          <section className="pos-left">
            <div className="scanbox">
              <div className="scan-label"><label htmlFor="scan">Scan UPC, enter SKU, or search products</label><p role="status">{message}</p></div>
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
                      <strong className="result-name">{item.productName}</strong>
                      <span className="result-meta">{item.variantName}</span>
                      <span className="result-code">UPC {item.barcode ?? '—'} · SKU {item.sku}</span>
                      <b className="result-price">{item.priceMinor === null ? 'No price' : money(item.priceMinor)}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="cart-head">
              <h2>Current sale <small>{cart.reduce((sum, line) => sum + line.quantity, 0)} items</small></h2>
              {restricted && <button className={`age-banner${ageVerified ? ' ok' : ''}`} onClick={() => setUtility('age')}>{ageVerified ? '✓ Age verified' : '21+ items · check age'}</button>}
              <button className="text" onClick={() => { setCart([]); clearAdjustments(); setCashTendered(''); }}>Clear cart</button>
            </div>
            <div className="cart">
              {cart.length === 0 && (
                <div className="empty">
                  Your cart is empty.
                  <br />
                  <small>Scanned items appear here.</small>
                </div>
              )}
              {cart.map((line) => (
                <CartLine key={line.variantId} line={line} priced={quote?.lines.find((item) => item.variantId === line.variantId)} manualDiscount={Boolean(lineAdjustments[line.variantId])} onQuantity={(quantity) => setQuantity(line.variantId, quantity)} onRemove={() => removeLine(line.variantId)} />
              ))}
            </div>
          </section>
          <aside className="pos-right">
            <section className="quick-keys" aria-label="Quick Add">
              <div className="quick-title">
                <h2>Quick Add</h2>
                <div className="quick-groups">
                  <button className={quickGroup === 'All' ? 'active' : ''} onClick={() => { setQuickGroup('All'); setQuickPage(0); }}>All</button>
                  {[...new Set(quickKeys.map((key) => key.groupName))].map((group) => <button className={quickGroup === group ? 'active' : ''} key={group} onClick={() => { setQuickGroup(group); setQuickPage(0); }}>{group}</button>)}
                </div>
                <button className="text" onClick={() => requireElevation('Approve managing Quick Add buttons.', () => window.location.assign('/admin/register-settings/'))}>Manage</button>
              </div>
              {quickKeys.length === 0 && <small className="quick-empty">No quick items yet.</small>}
              <div className="qa-grid">
                {Array.from({ length: QUICK_PAGE_SIZE }, (_, index) => {
                  const key = pageKeys[index];
                  return key
                    ? <button key={key.id} disabled={!key.active || key.priceMinor === null} onClick={() => addItem(key)}><strong>{key.label}</strong><small>{key.priceMinor ? money(key.priceMinor) : 'No price'}</small></button>
                    : <span key={`empty-${index}`} className="qa-empty" aria-hidden="true" />;
                })}
              </div>
              {quickPages > 1 && (
                <div className="qa-pager">
                  <button aria-label="Previous Quick Add page" disabled={activeQuickPage === 0} onClick={() => setQuickPage(activeQuickPage - 1)}>‹ Prev</button>
                  <span aria-live="polite">Page {activeQuickPage + 1} of {quickPages}</span>
                  <button aria-label="Next Quick Add page" disabled={activeQuickPage >= quickPages - 1} onClick={() => setQuickPage(activeQuickPage + 1)}>Next ›</button>
                </div>
              )}
            </section>
            <section className="payment" aria-label="Payment">
              {(customer || giftApplied || loyaltyPoints > 0) && (
                <div className="applied-row">
                  {customer && <button onClick={() => setUtility('customerPanel')}>{customer.name}{loyaltyPoints > 0 ? ` · ${loyaltyPoints} pts` : ''} ✎</button>}
                  {giftApplied && <button onClick={() => setUtility('gift')}>Gift card {money(giftKeyed)} ✎</button>}
                </div>
              )}
              <div className="totals" aria-label="Sale totals">
                <div className="totals-detail">
                  <span>Subtotal <b>{money(subtotal)}</b></span>
                  {discount > 0n && <span>{adjustments.active ? 'Discounts' : 'Promotions'} <b>−{money(discount)}</b></span>}
                  <span>Tax <b>{money(projectedTax)}</b></span>
                </div>
                <div className="total"><span>Total</span><b>{money(total)}</b></div>
              </div>
              <div className="tender-row" role="group" aria-label="Cash tendered">
                {[5, 10, 20, 50, 100].map((amount) => <button key={amount} disabled={!cart.length || !sessionId} className={tenderedAmount === BigInt(amount * 100) ? 'active' : ''} onClick={() => setCashTendered(String(amount * 100))}>${amount}</button>)}
                <button disabled={!cart.length || !sessionId} className={tenderedAmount !== null && tenderedAmount === dueNow ? 'active' : ''} onClick={() => setCashTendered(dueNow.toString())}>EXACT</button>
                <button disabled={!cart.length || !sessionId} onClick={() => setUtility('tender')}>Other</button>
              </div>
              <div className="change-panel" aria-label="Cash change">
                <div><span>Amount due</span><b>{money(dueNow)}</b></div>
                <div><span>Tendered</span><b>{tenderedAmount === null ? '—' : money(tenderedAmount)}</b></div>
                <div className={`change${shortBy > 0n ? ' short' : ''}`}><span>{shortBy > 0n ? 'Still due' : 'Change due'}</span><b>{money(shortBy > 0n ? shortBy : changeDue)}</b></div>
              </div>
              <div className="pay-buttons">
                <button className="pay card" disabled={!cart.length || !sessionId} onClick={() => void checkout('terminal')}>CARD</button>
                <button className="pay cash" disabled={!cart.length || !sessionId || shortBy > 0n} onClick={() => void checkout('cash', cashTendered || total.toString())}>CASH</button>
              </div>
              {splitActive && (
                <div className="pay-buttons">
                  <button className="pay cash" disabled={!cart.length || !sessionId} onClick={() => void mixedCheckout('CASH')}>Split with cash</button>
                  <button className="pay card" disabled={!cart.length || !sessionId} onClick={() => void mixedCheckout('TERMINAL')}>Split with terminal</button>
                </div>
              )}
            </section>
          </aside>
        </div>
        <div className="action-bar" aria-label="Register actions">
          <button onClick={() => requireElevation('Approve a discount or custom price.', () => setUtility('discount'))}>Discount / Price</button>
          <button className={priceCheckMode ? 'confirmed' : ''} onClick={() => { setPriceCheckMode(true); scanInput.current?.focus(); setMessage('Price-check mode: scan or select an item. It will not be added to the cart.'); }}>Price Check</button>
          <button className={customer ? 'confirmed' : ''} onClick={() => setUtility('customerPanel')}>Customer</button>
          <button className={ageVerified ? 'confirmed' : ''} onClick={() => setUtility('age')}>Age Check</button>
          <button disabled={!cart.length} onClick={() => void holdSale()}>Hold</button>
          <button onClick={() => void showHeld()}>Resume</button>
          <button disabled={!cart.length} className="danger" onClick={voidCart}>Void Cart</button>
          <button onClick={() => requireElevation('Approve a return.', () => void showReturns())}>Return</button>
          <button disabled={!receipt} onClick={() => void printCurrentReceipt()}>Reprint</button>
          <button onClick={() => setUtility('cash')}>Cash / Drawer</button>
          <button className={giftApplied ? 'confirmed' : ''} onClick={() => setUtility('gift')}>Gift Card</button>
          <button disabled={!sessionId && !clockedIn} className="danger" onClick={() => beginClose(true)}>End Shift</button>
        </div>
      </>)}
      {view === 'inventory' && <InventoryView storeName={storeName} onBack={() => setView('register')} />}
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
      {utility === 'age' && (
        <div className="modal" role="dialog" aria-label="age utility">
          <section className="age-modal">
            <AgeCheckDialog timeZone={storeTimezone} needsVerification={cart.some((line) => line.ageRestricted)} alreadyVerified={ageVerified} onClose={closeUtility} onVerified={() => { setAge(true); const action = pendingAction.current; pendingAction.current = null; setUtility('none'); setMessage('Age verified for this sale.'); action?.(); }} />
          </section>
        </div>
      )}
      {utility !== 'none' && utility !== 'age' && (
        <div className="modal" role="dialog" aria-label={`${utility} utility`}>
          <section className="utility-modal">
            <button className="close" aria-label="Close" onClick={closeUtility}>×</button>
            {utility === 'resume' && <><h2>Resume a held sale</h2>{heldTransactions.length === 0 ? <p>No held sales on this register.</p> : heldTransactions.map((held) => <button className="held-sale" key={held.id} onClick={() => void resumeSale(held.id)}><strong>{held.label}</strong><span>{new Date(held.heldAt).toLocaleTimeString()} · {held.employee.firstName} {held.employee.lastName}</span><small>{held.cartJson.lines.length} lines{held.customer ? ` · ${held.customer.name}` : ''}</small></button>)}</>}
            {utility === 'return' && <><h2>Return items</h2>{!returnOrder ? <>{history.filter((order) => ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.status)).map((order) => <button className="held-sale" key={order.id} onClick={() => void selectReturnOrder(order.id)}><strong>{order.orderNumber}</strong><span>{order.status}</span><small>{money(order.totalMinor)}</small></button>)}{history.every((order) => !['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.status)) && <p>No refundable orders found.</p>}</> : <><button className="text" onClick={() => setReturnOrder(null)}>← Choose another order</button><p><strong>{returnOrder.orderNumber}</strong></p>{returnOrder.items.map((item) => { const remaining = item.quantity - refundedQuantity(returnOrder, item.id); return <label className="return-line" key={item.id}><span>{item.productNameSnapshot} · {item.variantNameSnapshot}<small>{remaining} available to return</small></span><input aria-label={`Return quantity for ${item.productNameSnapshot}`} type="number" min="0" max={remaining} disabled={remaining === 0} value={returnQuantities[item.id] ?? 0} onChange={(event) => setReturnQuantities((current) => ({ ...current, [item.id]: Math.min(remaining, Math.max(0, Number(event.target.value) || 0)) }))} /><select aria-label={`Disposition for ${item.productNameSnapshot}`} value={returnDispositions[item.id] ?? 'RETURN_TO_STOCK'} disabled={remaining === 0} onChange={(event) => setReturnDispositions((current) => ({ ...current, [item.id]: event.target.value as ReturnDisposition }))}>{(Object.keys(DISPOSITION_LABELS) as ReturnDisposition[]).map((value) => <option key={value} value={value}>{DISPOSITION_LABELS[value]}</option>)}</select></label>; })}<label>Required reason<input aria-label="Return reason" value={returnReason} onChange={(event) => setReturnReason(event.target.value)} /></label><button className="danger" disabled={!returnReason.trim() || !Object.values(returnQuantities).some((quantity) => quantity > 0)} onClick={() => void submitReturn()}>Confirm refund</button></>}</>}
            {utility === 'approve' && <ElevationDialog reason={approveReason} onGranted={(granted) => { grantElevation(granted); const action = pendingAction.current; pendingAction.current = null; setUtility('none'); action?.(); }} />}
            {utility === 'cash' && <CashOperationsDialog isManager={session.role !== 'CASHIER'} onSubmit={(kind, amount, reason) => void submitCash(kind, amount, reason)} onNoSale={() => requireElevation('Approve opening the cash drawer.', () => setUtility('drawer'))} />}
            {utility === 'customerPanel' && <CustomerDialog customer={customer} program={loyaltyProgram} points={loyaltyPoints} projectedEarn={loyaltyProgram?.enabled ? Math.floor(Number(total) / Number(loyaltyProgram.spendMinor)) * loyaltyProgram.pointsEarned : 0} search={customerSearch} results={customerResults} onSearch={setCustomerSearch} onFind={() => void findCustomers()} onSelect={(picked) => { setUtility('none'); void selectCustomer(picked); }} onNew={() => setUtility('customer')} onRemove={() => { setCustomer(null); setLoyaltyPoints(0); }} onPoints={setLoyaltyPoints} onClose={closeUtility} />}
            {utility === 'gift' && <GiftCardDialog code={giftCode} amountMinor={giftAmount} onApply={(code, amountMinor) => { setGiftCode(code); setGiftAmount(amountMinor); setUtility('none'); setMessage('Gift card applied. Use Split with cash or terminal for the remainder.'); }} onClear={() => { setGiftCode(''); setGiftAmount('0'); setUtility('none'); }} />}
            {utility === 'tender' && <TenderDialog dueMinor={dueNow} onSet={(amount) => { setCashTendered(amount.toString()); setUtility('none'); }} />}
            {utility === 'open' && <OpenRegisterDialog onOpen={(cash, note) => void openRegister(cash, note)} />}
            {utility === 'customer' && <CustomerCreateForm onCreated={(created) => { setUtility('none'); void selectCustomer(created); setMessage(`${created.name} added and selected.`); }} />}
            {utility === 'discount' && <DiscountDialog hasAdjustments={adjustments.active} lines={cart.map((line) => ({ variantId: line.variantId, productName: line.productName, variantName: line.variantName, priceMinor: line.priceMinor, quantity: line.quantity }))} onClear={() => { clearAdjustments(); setUtility('none'); setMessage('Discounts removed.'); }} onApply={(target, adjustment) => { if (target.scope === 'cart') setCartAdjustment(adjustment); else setLineAdjustments((current) => ({ ...current, [target.variantId]: adjustment })); setUtility('none'); setMessage('Discount applied. Totals updated.'); }} />}
            {utility === 'close' && <><h2>{closeWithClockOut ? 'End shift' : 'Close register'}</h2><p>Count the cash in the drawer and enter the total.</p><form onSubmit={(event) => { event.preventDefault(); void confirmClose(); }}><label>Counted cash<input aria-label="Counted cash" inputMode="decimal" autoFocus value={closeCash} onChange={(event) => setCloseCash(event.target.value.replace(/[^\d.$]/g, ''))} /></label><button className="danger" disabled={parseDollarsToMinor(closeCash) === null}>{closeWithClockOut ? 'Close register and clock out' : 'Close register'}</button></form></>}
            {utility === 'report' && shiftReport && <><ShiftReportView report={shiftReport} />{!shiftReport.detail && <button className="quiet" onClick={() => requireElevation('Manager approval is needed to view the detailed shift report.', () => void loadShiftReport(shiftReport.sessionId).catch((error) => setMessage(friendlyError(error, 'Could not load the report.'))))}>Manager: detailed report</button>}<button className="primary" onClick={closeUtility}>Done</button></>}
            {utility === 'drawer' && <><h2>Manual drawer open</h2><p className="warning">Manager authorization and a reason are required. This action is audited.</p><label>Reason<input aria-label="Drawer reason" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label><button className="danger" onClick={() => void manualDrawerOpen()}>Authorize and open drawer</button></>}
          </section>
        </div>
      )}
      {saleSummary && (
        <div className="modal" role="dialog" aria-label="Sale complete">
          <SaleCompleteDialog summary={saleSummary} onDone={() => { setSaleSummary(null); scanInput.current?.focus(); }} onReceipt={() => { setSaleSummary(null); setReceiptOpen(true); }} />
        </div>
      )}
      {receipt && receiptOpen && (
        <div className="modal" role="dialog" aria-label="Receipt">
          <section className="receipt">
            <button className="close" aria-label="Close receipt" onClick={() => setReceiptOpen(false)}>
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

export default function Register(): React.ReactNode {
  const [session, setSession] = useState<RegisterSession | null>(null);
  const [ready, setReady] = useState(false);
  const lock = useCallback(() => {
    // Best-effort audit of the sign-out; the local session is cleared regardless.
    if (getApiSessionToken()) void api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    setApiSession(null); storeSession(null); setSession(null);
  }, []);
  const signIn = useCallback((next: RegisterSession) => { setApiSession(next.token, lock); storeSession(next); setSession(next); }, [lock]);
  useEffect(() => {
    const stored = loadStoredSession();
    if (stored) { setApiSession(stored.token, lock); setSession(stored); }
    setReady(true);
  }, [lock]);
  if (!ready) return null;
  return session ? <RegisterWorkspace key={session.employee.id} session={session} onLock={lock} /> : <LockScreen onSignedIn={signIn} />;
}
