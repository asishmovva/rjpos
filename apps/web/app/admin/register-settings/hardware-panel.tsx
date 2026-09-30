'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type Device = 'scanner' | 'printer' | 'labelPrinter' | 'drawer' | 'terminal';
type Result = 'passed' | 'failed';
const LABELS: Record<Device, string> = { scanner: 'Barcode scanner', printer: 'Receipt printer', labelPrinter: 'Label printer', drawer: 'Cash drawer', terminal: 'Payment terminal' };
// Nothing is certified until real devices pass the procedure in docs/phase-9/hardware-validation.md; flip an entry only after sign-off.
const CERTIFIED: Record<Device, boolean> = { scanner: false, printer: false, labelPrinter: false, drawer: false, terminal: false };

/** The status people see: honest about simulation, about what cannot be detected, and about certification. */
function describe(device: Device, raw: string | undefined, hasApp: boolean, tested: Result | undefined): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (!hasApp) return { text: 'Open in the register app to check hardware', tone: 'muted' };
  if (tested === 'passed') return { text: 'Test passed', tone: 'ok' };
  if (tested === 'failed') return { text: 'Test failed', tone: 'bad' };
  if (device === 'scanner') return { text: 'Keyboard device: use Test scan to confirm', tone: 'muted' };
  if (device === 'terminal') return raw === 'simulated' ? { text: 'Simulated card payments (not real)', tone: 'warn' } : raw === 'ready' ? { text: 'Provider connected', tone: 'ok' } : { text: 'No payment provider: card unavailable', tone: 'muted' };
  if (raw === 'simulated') return { text: 'Simulated (nothing is really printed or opened)', tone: 'warn' };
  if (raw === 'ready') return { text: 'Connected', tone: 'ok' };
  if (raw === 'error') return { text: 'Test failed', tone: 'bad' };
  if (raw === 'unavailable') return { text: 'Not configured', tone: 'muted' };
  return { text: 'Checking…', tone: 'muted' };
}

export function HardwarePanel({ onDrawerTest, onMessage }: { onDrawerTest: () => void; onMessage: (text: string) => void }): React.ReactNode {
  const electron = typeof window === 'undefined' ? undefined : window.rjpos;
  const [raw, setRaw] = useState<Record<string, string>>({}); const [tests, setTests] = useState<Partial<Record<Device, Result>>>({});
  const [scanning, setScanning] = useState(false); const [scanned, setScanned] = useState('');
  const scanBuffer = useRef('');
  const refresh = useCallback(() => { if (electron) void electron.hardwareStatus().then(setRaw).catch(() => undefined); }, [electron]);
  useEffect(() => { refresh(); }, [refresh]);

  // Test scan: a scanner types its code quickly and presses Enter. Capture the next burst and show exactly what arrived.
  useEffect(() => {
    if (!scanning) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setScanning(false); return; }
      if (event.key === 'Enter') { if (scanBuffer.current.length >= 4) { setScanned(scanBuffer.current); setTests((current) => ({ ...current, scanner: 'passed' })); setScanning(false); } scanBuffer.current = ''; return; }
      if (event.key.length === 1) scanBuffer.current += event.key;
      event.preventDefault();
    };
    scanBuffer.current = '';
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [scanning]);

  async function run(device: Device, action: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    try { const result = await action(); setTests((current) => ({ ...current, [device]: result.ok ? 'passed' : 'failed' })); onMessage(result.message); }
    catch { setTests((current) => ({ ...current, [device]: 'failed' })); onMessage(`${LABELS[device]} test could not run.`); }
    refresh();
  }
  const testLabel = () => electron!.printLabels({ kind: 'BARCODE', widthMm: 50, heightMm: 30, items: [{ name: 'RJ POS TEST LABEL', barcode: '012345678905', copies: 1 }] });

  return <section className="settings-grid hardware-grid" aria-label="Hardware diagnostics">
    {(Object.keys(LABELS) as Device[]).map((device) => {
      const status = describe(device, raw[device], Boolean(electron), tests[device]);
      return <article key={device}>
        <h2>{LABELS[device]}</h2>
        <p><span className={`pill tone-${status.tone}`}>{status.text}</span> <span className={`pill ${CERTIFIED[device] ? 'tone-ok' : 'tone-muted'}`}>{CERTIFIED[device] ? 'Certified' : 'Not certified'}</span></p>
        {device === 'scanner' && <><button disabled={scanning} onClick={() => { setScanned(''); setScanning(true); }}>{scanning ? 'Scan a barcode now… (Esc to cancel)' : 'Test scan'}</button>{scanned && <p className="hint">Received: <strong>{scanned}</strong></p>}</>}
        {device === 'printer' && <button disabled={!electron} onClick={() => void run('printer', () => electron!.testPrinter())}>Print test receipt</button>}
        {device === 'labelPrinter' && <button disabled={!electron?.printLabels} onClick={() => void run('labelPrinter', testLabel)}>Print test label</button>}
        {device === 'drawer' && <button disabled={!electron} onClick={onDrawerTest}>Open drawer (manager approval)</button>}
        {device === 'terminal' && <p className="hint">No card provider is integrated. Cash is fully available. Card buttons stay unavailable or simulated until a provider is selected and certified.</p>}
      </article>;
    })}
    <p className="hint hardware-note">A passed test only means the action ran. Devices are marked certified after the store-level procedure in the hardware validation guide is completed.</p>
  </section>;
}
