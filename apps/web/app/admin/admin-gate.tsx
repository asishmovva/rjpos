'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { BrandMark } from '../brand';
import { SupportButton } from '../support';
import { ADMIN_GROUPS, linkHref } from './admin-links';
import { ADMIN_API } from './admin-client';
import { adminRegisterHeader, authRequired, saveAdminSession, storedAdminSession, type AdminSession } from './admin-auth';

const MESSAGES: Record<string, string> = {
  LOGIN_PIN_INVALID: 'That PIN is not correct.', LOGIN_LOCKED: 'Too many wrong PINs. Wait a minute and try again.', REGISTER_NOT_FOUND: 'This device is not set up for this store.',
  ROLE: 'Back office needs a Manager or Owner PIN.', SESSION_REVOKED: 'You were signed out. Enter your PIN again.',
};

/** Top bar for back-office sub-pages: brand, a jump menu to every section, help, and (in production) who is signed in. Also resets scroll on navigation. */
function AdminChrome({ session, onSignOut }: { session: AdminSession | null; onSignOut: () => void }): React.ReactNode {
  const pathname = usePathname();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  if ((pathname ?? '').replace(/\/+$/, '') === '/admin') return session ? <div className="admin-session-bar"><span>{session.employee.name} · {session.role.toLowerCase()}</span><button type="button" onClick={onSignOut}>Sign out</button></div> : null;
  return <div className="admin-chrome">
    <a className="admin-chrome-brand" href="/admin/"><BrandMark size={26} /><span>Back Office</span></a>
    <details className="admin-jump"><summary>Go to…</summary>
      <div className="admin-jump-menu">{ADMIN_GROUPS.map((group) => <div key={group.title}><strong>{group.title}</strong>{group.items.map((item) => <a key={item.label} href={linkHref(item)}>{item.label}</a>)}</div>)}</div></details>
    <span className="admin-chrome-space" />
    {session && <span className="admin-chrome-user">{session.employee.name} · {session.role.toLowerCase()} <button type="button" onClick={onSignOut}>Sign out</button></span>}
    <SupportButton className="support-btn on-light" />
    <a className="admin-chrome-register" href="/">Register</a>
  </div>;
}

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
  const signOut = () => { saveAdminSession(null); setSession(null); setPin(''); };
  if (!required) return <><AdminChrome session={null} onSignOut={signOut} />{children}</>;
  if (!ready) return null;
  if (session) return <><AdminChrome session={session} onSignOut={signOut} />{children}</>;
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
    <BrandMark size={36} /><h1>Back Office</h1><p className="hint">Enter your Manager or Owner PIN.</p>
    <input aria-label="PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} autoFocus />
    {error && <p className="admin-alert error" role="alert">{error}</p>}
    <button className="primary" disabled={busy || pin.length < 4}>{busy ? 'Signing in…' : 'Sign in'}</button></form><div className="lock-support"><SupportButton className="support-btn on-light" /></div></main>;
}
