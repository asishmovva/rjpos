export const API = process.env.NEXT_PUBLIC_RJPOS_API_URL ?? 'http://127.0.0.1:3001/api/v1';
export type RegisterRole = 'OWNER' | 'MANAGER' | 'CASHIER';
export type RegisterSession = { token: string; expiresAt: string; employee: { id: string; name: string }; role: RegisterRole };
const SESSION_KEY = 'rjpos.session';

// The PIN-login session token identifies the real employee to the API. It lives in memory for requests and in
// sessionStorage (cleared when the window closes) so a renderer reload does not sign the employee out.
let sessionToken: string | null = null;
let onSessionLost: (() => void) | null = null;
export const getApiSessionToken = (): string | null => sessionToken;
export function setApiSession(token: string | null, lost?: () => void): void { sessionToken = token; onSessionLost = token ? lost ?? null : null; }
export function loadStoredSession(): RegisterSession | null {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? 'null') as RegisterSession | null;
    return stored && new Date(stored.expiresAt).getTime() > Date.now() ? stored : null;
  } catch { return null; }
}
export function storeSession(session: RegisterSession | null): void {
  try { if (session) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); else window.sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable: session stays in memory only */ }
}

export function money(value: bigint | string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(BigInt(value)) / 100);
}

export async function api<T>(path: string, init?: RequestInit & { elevationToken?: string; anonymous?: boolean }): Promise<T> {
  const { elevationToken, anonymous, ...request } = init ?? {};
  try {
    const response = await fetch(`${API}${path}`, { ...request, headers: {
      'content-type': 'application/json', ...(sessionToken && !anonymous ? { 'x-rjpos-session': sessionToken } : {}),
      ...(elevationToken ? { 'x-rjpos-elevation': elevationToken } : {}), ...request.headers,
    }, signal: request.signal ?? AbortSignal.timeout(10_000) });
    const body = (typeof response.text === 'function'
      ? await response.text().then((text) => text ? JSON.parse(text) : null)
      : await response.json()) as T & { error?: { code: string } } | null;
    if (!response.ok) {
      const code = body?.error?.code ?? `HTTP_${response.status}`;
      if (code === 'SESSION_EXPIRED' || code === 'SESSION_INVALID') onSessionLost?.();
      throw new Error(code);
    }
    return body as T;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) throw new Error('Register cannot reach the server. No sale was recorded.');
    throw error;
  }
}

const FRIENDLY_ERRORS: Record<string, string> = {
  FORBIDDEN: 'A manager or owner must approve this action.',
  ELEVATION_CREDENTIALS_INVALID: 'That PIN is not correct.',
  LOGIN_PIN_INVALID: 'That PIN is not correct.',
  LOGIN_LOCKED: 'Too many wrong PINs. Wait a minute and try again.',
  SESSION_EXPIRED: 'Your session ended. Sign in again.',
  SESSION_INVALID: 'Your session ended. Sign in again.',
  ELEVATION_LOCKED: 'Too many wrong PINs. Wait a minute and try again.',
  ELEVATION_EXPIRED: 'Manager approval expired. Approve again.',
  ELEVATION_INVALID: 'Manager approval is no longer valid. Approve again.',
  INSUFFICIENT_DRAWER_CASH: 'The drawer does not have that much cash.',
  CASH_REASON_REQUIRED: 'Enter a reason for this cash movement.',
  REGISTER_SESSION_NOT_OPEN: 'Open the register first.',
  QUICK_KEY_POSITION_TAKEN: 'That position is already used. Leave it blank to add at the end.',
};
export const friendlyError = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : '';
  return FRIENDLY_ERRORS[message] ?? (message && !/^[A-Z0-9_]+$/.test(message) ? message : fallback);
};

/** "3.25", "$3", ".5" → integer cents. Returns null for empty, negative, or malformed text. */
export function parseDollarsToMinor(text: string): bigint | null {
  const match = /^\$?\s*(\d*)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match || (!match[1] && !match[2])) return null;
  return BigInt(match[1] || '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}

/** "10", "12.5", "10%" → basis points (0–10000). Returns null when invalid or above 100%. */
export function parsePercentToBasisPoints(text: string): number | null {
  const match = /^(\d{0,3})(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const basisPoints = Number(match[1] || '0') * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  return basisPoints <= 10_000 ? basisPoints : null;
}

export type DiscountBody = { kind: 'FIXED'; amountMinor: string } | { kind: 'PERCENTAGE'; basisPoints: number };
/** How the cashier described a manual price change; converted to a server discount at quote/checkout time. */
export type PriceAdjustment = { mode: 'percent'; basisPoints: number } | { mode: 'amount'; amountMinor: bigint } | { mode: 'price'; priceMinor: bigint };

export function adjustmentToDiscount(adjustment: PriceAdjustment, unitPriceMinor: bigint, quantity: number): DiscountBody {
  if (adjustment.mode === 'percent') return { kind: 'PERCENTAGE', basisPoints: adjustment.basisPoints };
  const perUnit = adjustment.mode === 'price' ? (unitPriceMinor > adjustment.priceMinor ? unitPriceMinor - adjustment.priceMinor : 0n) : adjustment.amountMinor;
  // Fixed line amounts are per line, so a per-unit change scales with quantity. A flat amount is one deduction.
  return { kind: 'FIXED', amountMinor: (adjustment.mode === 'price' ? perUnit * BigInt(quantity) : perUnit).toString() };
}
