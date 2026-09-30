'use client';
import { useEffect, useState } from 'react';
import { errorText, phaseNineApi, type BackupStatus } from '../phase9-client';
import '../admin.css';
import '../costing.css';

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Never');

/** Owner/Admin view of backup health. The status file holds times and names only, never credentials. */
export default function SystemPage(): React.ReactNode {
  const [status, setStatus] = useState<BackupStatus | null>(null); const [error, setError] = useState(''); const [checked, setChecked] = useState(''); const [showHelp, setShowHelp] = useState(false);
  const load = () => phaseNineApi.backupStatus().then((result) => { setStatus(result); return result; }).catch((cause) => { setError(errorText(cause)); return null; });
  useEffect(() => { void load(); }, []);
  async function verify(): Promise<void> {
    setChecked(''); const result = await load();
    if (!result) return;
    setChecked(!result.file ? 'No backup file is recorded yet.' : !result.fileExists ? 'The latest backup file could not be found in the backup folder.' : !result.fileSizeBytes ? 'The latest backup file is empty.' : `The latest backup file exists (${(result.fileSizeBytes / 1_048_576).toFixed(1)} MB). This checks the file only. To prove it restores, run the restore verification script (below).`);
  }
  return <main className="admin-main costing-page">
    <header className="admin-heading"><div><a href="/admin/">← Back Office</a><span className="eyebrow">Settings</span><h1>Backups</h1></div></header>
    {error && <p className="admin-alert error" role="alert">{error}</p>}
    {status && <>
      {(status.result !== 'SUCCESS' || status.stale) && <p className="admin-alert error" role="alert">{status.result === 'FAILURE' ? 'The last backup failed.' : !status.configured ? 'No backup has been recorded.' : 'The last successful backup is more than 36 hours old.'} Fix this before relying on your data.</p>}
      <section className="wizard-section" aria-label="Backup status"><h2>Backup status</h2>
        <dl className="calc"><div><dt>Last attempt</dt><dd>{when(status.lastAttemptAt)}</dd></div><div><dt>Last success</dt><dd>{when(status.lastSuccessAt)}</dd></div>
          <div><dt>Result</dt><dd>{status.result === 'SUCCESS' ? 'Success' : status.result === 'FAILURE' ? 'Failed' : 'Unknown'}</dd></div><div><dt>File</dt><dd>{status.file ?? '—'}</dd></div><div><dt>Saved to</dt><dd>{status.destination}</dd></div></dl>
        <div className="inline-form"><button onClick={() => void verify()}>Verify backup file</button><button onClick={() => setShowHelp((open) => !open)} aria-expanded={showHelp}>{showHelp ? 'Hide instructions' : 'View instructions'}</button></div>
        {checked && <p className="admin-alert success" role="status">{checked}</p>}
        {status.detail && <p className="hint">{status.detail}</p>}</section>
      {showHelp && <section className="wizard-section" aria-label="Restore instructions"><h2>How to restore</h2><ol>{status.restoreInstructions.map((step) => <li key={step}>{step}</li>)}</ol>
        <p className="hint">Backups are created by scripts\backup-database.ps1 (schedule it daily). A real restore replaces current data, so stop the API first.</p>
        <p className="hint"><strong>Restore verification is not a production restore.</strong> The script restores a copy into a separate test database and never changes live data.</p></section>}</>}
  </main>;
}
