/**
 * Back-office identity. In development the API accepts a header-based owner identity; in production
 * (NEXT_PUBLIC_RJPOS_AUTH_MODE=production) every admin request must carry a PIN-login session from an Owner or Manager.
 */
const SESSION_KEY = 'rjpos.admin.session';
export const authRequired = (): boolean => process.env.NEXT_PUBLIC_RJPOS_AUTH_MODE === 'production';
export type AdminSession = { token: string; expiresAt: string; employee: { id: string; name: string }; role: 'OWNER' | 'MANAGER' | 'CASHIER' };

let memoryToken: string | null = null;
export function storedAdminSession(): AdminSession | null {
  try {
    const session = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? 'null') as AdminSession | null;
    if (session && new Date(session.expiresAt).getTime() > Date.now()) { memoryToken = session.token; return session; }
  } catch { /* storage unavailable or corrupt */ }
  return null;
}
export function saveAdminSession(session: AdminSession | null): void {
  memoryToken = session?.token ?? null;
  try { if (session) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); else window.sessionStorage.removeItem(SESSION_KEY); } catch { /* keep in memory only */ }
}
export const adminRegisterHeader = (): Record<string, string> => (process.env.NEXT_PUBLIC_RJPOS_REGISTER_ID ? { 'x-rjpos-register-id': process.env.NEXT_PUBLIC_RJPOS_REGISTER_ID } : {});

/** Headers for back-office requests. Never sends the development owner header when production auth is required. */
export function adminHeaders(): Record<string, string> {
  if (memoryToken) return { 'x-rjpos-session': memoryToken, ...adminRegisterHeader() };
  return authRequired() ? adminRegisterHeader() : { 'x-rjpos-role': 'OWNER' };
}
/** Called when the API says the session is gone so the gate can ask for the PIN again. */
export function handleAdminAuthError(code: string): void {
  if (['SESSION_EXPIRED', 'SESSION_INVALID', 'SESSION_REVOKED'].includes(code)) { saveAdminSession(null); if (typeof window !== 'undefined') window.dispatchEvent(new Event('rjpos-admin-session-lost')); }
}
