'use client';
import { useEffect, useState } from 'react';
import { ElevationDialog } from '../../register-dialogs';
import '../admin.css';
import { QuickKeyManager } from './quick-keys';

export default function RegisterSettingsPage(): React.ReactNode {
  const [hardware, setHardware] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [approvingDrawerTest, setApprovingDrawerTest] = useState(false);
  const electron = typeof window === 'undefined' ? undefined : window.rjpos;
  useEffect(() => { if (electron) void electron.hardwareStatus().then(setHardware); }, [electron]);
  return <main className="admin-main"><header className="admin-heading"><div><span className="eyebrow">RJ POS register</span><h1>Register &amp; hardware settings</h1></div><a href="/admin/">Back to administration</a></header>{message && <p role="status" className="admin-alert success">{message}</p>}
    <section className="settings-grid">{['scanner','printer','drawer','terminal'].map((device) => <article key={device}><h2>{device[0]!.toUpperCase()+device.slice(1)}</h2><p><span className="pill">{hardware[device] ?? (electron ? 'checking' : 'browser only')}</span></p>{device === 'printer' && <button disabled={!electron} onClick={() => void electron?.testPrinter().then((result) => setMessage(result.message))}>Test printer</button>}{device === 'drawer' && <button disabled={!electron} onClick={() => setApprovingDrawerTest(true)}>Test drawer</button>}</article>)}</section>
    {approvingDrawerTest && <section className="admin-form"><ElevationDialog reason="Approve a test drawer open." onGranted={(elevation) => { setApprovingDrawerTest(false); void electron?.openDrawer({ reason: 'Authorized hardware settings test', elevationToken: elevation.token }).then((result) => setMessage(result.message)); }} /><button onClick={() => setApprovingDrawerTest(false)}>Cancel</button></section>}
    <QuickKeyManager onMessage={setMessage} />
  </main>;
}
