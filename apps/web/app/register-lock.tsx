'use client';

import { useState } from 'react';
import { BrandMark } from './brand';
import { SupportButton } from './support';
import { api, friendlyError, type RegisterSession } from './register-api';

/** PIN sign-in shown whenever nobody is signed in. The PIN is verified by the API; nothing is checked here. */
export function LockScreen({ onSignedIn }: { onSignedIn: (session: RegisterSession) => void }): React.ReactNode {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(): Promise<void> {
    if (pin.length < 4 || busy) return;
    setBusy(true); setError('');
    try { onSignedIn(await api<RegisterSession>('/auth/login', { method: 'POST', anonymous: true, body: JSON.stringify({ pin }) })); }
    catch (cause) { setError(friendlyError(cause, 'Could not sign in. Try again.')); setPin(''); }
    finally { setBusy(false); }
  }
  return <main className="lock-screen">
    <form className="lock-card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <BrandMark size={40} />
      <h1>Downtown Register</h1>
      <p>Enter your PIN to sign in.</p>
      <div className="pin-dots" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <span key={index} className={index < pin.length ? 'filled' : ''} />)}</div>
      <input aria-label="Employee PIN" type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={8} value={pin} onChange={(event) => { setPin(event.target.value.replace(/\D/g, '')); setError(''); }} />
      {error && <p className="lock-error" role="alert">{error}</p>}
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => <button type="button" key={digit} onClick={() => setPin((value) => (value + digit).slice(0, 8))}>{digit}</button>)}
        <button type="button" aria-label="Clear PIN" onClick={() => setPin('')}>Clear</button>
        <button type="button" onClick={() => setPin((value) => (value + '0').slice(0, 8))}>0</button>
        <button type="button" aria-label="Delete last digit" onClick={() => setPin((value) => value.slice(0, -1))}>⌫</button>
      </div>
      <button className="primary" disabled={pin.length < 4 || busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <div className="lock-support"><SupportButton /></div>
  </main>;
}
