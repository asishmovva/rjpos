import type { RegisterRole } from '../app/register-api.js';

/** Seeds the stored PIN-login session so a test can start on the register screen instead of the lock screen. */
export function signInAs(role: RegisterRole = 'CASHIER', name = role === 'CASHIER' ? 'Casey Cashier' : 'Morgan Manager'): void {
  window.sessionStorage.setItem('rjpos.session', JSON.stringify({ token: 'session-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), employee: { id: 'employee-1', name }, role }));
}
