'use client';
import { useState } from 'react';
import { ElevationDialog } from '../../register-dialogs';
import '../admin.css';
import { HardwarePanel } from './hardware-panel';
import { QuickKeyManager } from './quick-keys';

export default function RegisterSettingsPage(): React.ReactNode {
  const [message, setMessage] = useState('');
  const [approvingDrawerTest, setApprovingDrawerTest] = useState(false);
  const electron = typeof window === 'undefined' ? undefined : window.rjpos;
  return <main className="admin-main"><header className="admin-heading"><div><span className="eyebrow">RJ POS register</span><h1>Register &amp; hardware settings</h1></div><a href="/admin/">Back to administration</a></header>{message && <p role="status" className="admin-alert success">{message}</p>}
    <HardwarePanel onMessage={setMessage} onDrawerTest={() => setApprovingDrawerTest(true)} />
    {approvingDrawerTest && <section className="admin-form"><ElevationDialog reason="Approve a test drawer open." onGranted={(elevation) => { setApprovingDrawerTest(false); void electron?.openDrawer({ reason: 'Authorized hardware settings test', elevationToken: elevation.token }).then((result) => setMessage(result.message)); }} /><button onClick={() => setApprovingDrawerTest(false)}>Cancel</button></section>}
    <QuickKeyManager onMessage={setMessage} />
  </main>;
}
