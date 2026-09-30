'use client';
import { useEffect, useState } from 'react';
import { ADMIN_API } from './admin-client';
import { adminRegisterHeader, authRequired, saveAdminSession, storedAdminSession, type AdminSession } from './admin-auth';

const MESSAGES: Record<string, string> = {
  LOGIN_PIN_INVALID: 'That PIN is not correct.', LOGIN_LOCKED: 'Too many wrong PINs. Wait a minute and try again.', REGISTER_NOT_FOUND: 'This device is not set up for this store.',
  ROLE: 'Back office needs a Manager or Owner PIN.', SESSION_REVOKED: 'You were signed out. Enter your PIN again.',
};

/** Requires a Manager/Owner PIN session before any back-office page renders when production auth is on. */
export function AdminGate({ children }: { children: React.ReactNode }): React.ReactNode {
  const required = authRequired();
  const [session, setSession] = useState<AdminSession | null>(null); const [ready, setReady] = useState(!required);
  const [pin, setPin] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!required) return undefined;
    setSession(storedAdminSession()); setReady(true);
    const lost = () => { setSession(null); setError(MESSAGES.SESSION_REVOKED!); };
    window.addEventListener('rjpos-admin-session-lost', lost);
    return () => window.removeEventListener('rjpos-admin-session-lost', lost);
  }, [required]);
  if (!required) return children;
  if (!ready) return null;
  if (session) return <>
    <div className="admin-session-bar"><span>{session.employee.name} · {session.role.toLowerCase()}</span>
      <button type="button" onClick={() => { saveAdminSession(null); setSession(null); setPin(''); }}>Sign out</button></div>{children}</>;
  async function signIn(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch(`${ADMIN_API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...adminRegisterHeader() }, body: JSON.stringify({ pin }) });
      const body = await response.json() as AdminSession & { error?: { code?: string } };
      if (!response.ok) throw new Error(body.error?.code ?? 'LOGIN_FAILED');
      if (body.role === 'CASHIER') throw new Error('ROLE');
      saveAdminSession(body); setSession(body); setPin('');
    } catch (cause) { setError(MESSAGES[cause instanceof Error ? cause.message : ''] ?? 'Could not sign in. Check the connection and try again.'); } finally { setBusy(false); }
  }
  return <main className="admin-main admin-gate"><form onSubmit={(event) => void signIn(event)} className="wizard-section" aria-label="Back office sign in">
    <h1>Back Office</h1><p className="hint">Enter your Manager or Owner PIN.</p>
    <input aria-label="PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} autoFocus />
    {error && <p className="admin-alert error" role="alert">{error}</p>}
    <button className="primary" disabled={busy || pin.length < 4}>{busy ? 'Signing in…' : 'Sign in'}</button></form></main>;
}
