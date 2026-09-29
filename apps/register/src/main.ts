import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CallbackReceiptPrinter, SimulatedCashDrawer, UnavailableCashDrawer } from './hardware-adapters.js';
import type { ReceiptDocument } from '@rjpos/hardware-contracts';
import {
  loadRegisterEnvironment,
  resolveRendererTarget,
  waitForRenderer,
} from './renderer-config.js';
import { secureWebPreferences } from './security.js';

let mainWindow: BrowserWindow | null = null;
const PACKAGED_RENDERER_ORIGIN = 'rjpos://app';
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rjpos',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const environment = loadRegisterEnvironment();
const hardwareMode = environment.RJPOS_HARDWARE_MODE === 'simulated' ? 'simulated' : 'unavailable';
const apiUrl = (environment.RJPOS_API_URL || 'http://127.0.0.1:3001/api/v1').replace(/\/$/, '');
const drawer = hardwareMode === 'simulated' ? new SimulatedCashDrawer() : new UnavailableCashDrawer();

// Requests made from the main process act as the signed-in employee (session token from the renderer). Without a
// session they fall back to the least-privileged cashier identity; privileged actions also need an elevation token.
const registerEmployeeId = environment.RJPOS_REGISTER_EMPLOYEE_ID || '00000000-0000-0000-0000-000000000006';
function registerHeaders(sessionToken?: string, elevationToken?: string): Record<string, string> {
  return {
    ...(sessionToken ? { 'x-rjpos-session': sessionToken } : { 'x-rjpos-role': 'CASHIER', 'x-rjpos-employee-id': registerEmployeeId }),
    ...(elevationToken ? { 'x-rjpos-elevation': elevationToken } : {}),
  };
}
const tokenOf = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
async function fetchReceipt(orderId: string, sessionToken?: string): Promise<ReceiptDocument> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new Error('INVALID_ORDER_ID');
  const response = await fetch(`${apiUrl}/orders/${orderId}/receipt`, { headers: registerHeaders(sessionToken), signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`RECEIPT_API_${response.status}`);
  const receipt = await response.json() as { orderNumber: string; totalMinor: string; currency: string; store: { name: string }; items: Array<{ productNameSnapshot: string; variantNameSnapshot: string; quantity: number; totalMinor: string }> };
  return { orderNumber: receipt.orderNumber, storeName: receipt.store.name, totalMinor: receipt.totalMinor, currency: receipt.currency, lines: receipt.items.map((item) => ({ label: `${item.productNameSnapshot} ${item.variantNameSnapshot}`, quantity: item.quantity, totalMinor: item.totalMinor })) };
}
const printer = new CallbackReceiptPrinter(hardwareMode, async (receipt) => {
  if (hardwareMode === 'simulated') return;
  const printWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const lines = receipt.lines.map((line) => `<tr><td>${line.quantity} × ${escapeHtml(line.label)}</td><td>${escapeHtml(line.totalMinor)}</td></tr>`).join('');
  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body><h2>${escapeHtml(receipt.storeName)}</h2><p>${escapeHtml(receipt.orderNumber)}</p><table>${lines}</table><h3>Total ${escapeHtml(receipt.totalMinor)} ${escapeHtml(receipt.currency)}</h3></body></html>`)}`);
  await new Promise<void>((resolve, reject) => printWindow.webContents.print({ silent: true, printBackground: true }, (success, failureReason) => success ? resolve() : reject(new Error(failureReason || 'PRINTER_FAILED'))));
  printWindow.destroy();
});

function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`RJ POS register startup failed: ${message}`);
}

async function runSmokeVerification(
  window: BrowserWindow,
  securityPreferences: ReturnType<typeof secureWebPreferences>,
): Promise<void> {
  if (!process.argv.includes('--smoke-test') && process.env.RJPOS_SMOKE_TEST !== '1') return;

  const result = (await window.webContents.executeJavaScript(`
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return {
        heading: document.querySelector('h1')?.textContent ?? null,
        rendererOrigin: location.origin,
        serverStatus: Array.from(document.querySelectorAll('.status')).map((element) => element.textContent?.trim()).find((value) => value?.startsWith('Server')) ?? null,
        hardwareStatus: (await window.rjpos.hardwareStatus()).printer,
      };
    })()
  `)) as { heading: string | null; rendererOrigin: string; serverStatus: string | null; hardwareStatus: string };
  const smokeResult = {
    ...result,
    bounds: window.getBounds(),
    minimumSize: window.getMinimumSize(),
    security: {
      contextIsolation: securityPreferences.contextIsolation,
      nodeIntegration: securityPreferences.nodeIntegration,
      sandbox: securityPreferences.sandbox,
    },
  };
  const smokeResultPath = process.env.RJPOS_SMOKE_RESULT_PATH;
  if (smokeResultPath) {
    writeFileSync(smokeResultPath, `${JSON.stringify(smokeResult)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    });
  }
  console.log(`RJPOS_REGISTER_SMOKE ${JSON.stringify(smokeResult)}`);
  app.exit(
    result.heading === 'Downtown Register' &&
      result.rendererOrigin === PACKAGED_RENDERER_ORIGIN &&
      result.serverStatus === 'Server online' &&
      ['simulated', 'unavailable'].includes(result.hardwareStatus) &&
      securityPreferences.contextIsolation === true &&
      securityPreferences.nodeIntegration === false &&
      securityPreferences.sandbox === true
      ? 0
      : 1,
  );
}

async function createWindow(): Promise<void> {
  const securityPreferences = secureWebPreferences(
    path.join(import.meta.dirname, 'preload.cjs'),
  );
  const window = new BrowserWindow({
    title: 'RJ POS Register',
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#f5f1e8',
    webPreferences: securityPreferences,
  });
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const rendererFile = app.isPackaged ? path.join(process.resourcesPath, 'renderer', 'index.html') : path.join(import.meta.dirname, 'renderer.html');
  const rendererTarget = resolveRendererTarget(
    app.isPackaged,
    rendererFile,
    environment,
  );
  if (rendererTarget.type === 'file') {
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      if (!navigationUrl.startsWith(`${PACKAGED_RENDERER_ORIGIN}/`)) event.preventDefault();
    });
    await window.loadURL(`${PACKAGED_RENDERER_ORIGIN}/index.html`);
  } else {
    const allowedOrigin = new URL(rendererTarget.value).origin;
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      if (new URL(navigationUrl).origin !== allowedOrigin)
        event.preventDefault();
    });
    try {
      await waitForRenderer(rendererTarget.value);
      await window.loadURL(rendererTarget.value);
    } catch (error) {
      reportStartupFailure(error);
      await window.loadFile(
        path.join(import.meta.dirname, 'renderer-unavailable.html'),
      );
    }
  }

  await runSmokeVerification(window, securityPreferences);
}

ipcMain.handle('hardware:status', async () => ({ scanner: 'ready' as const, printer: await printer.status(), drawer: await drawer.status(), terminal: hardwareMode }));
ipcMain.handle('hardware:print-receipt', async (_event, orderId: unknown, sessionToken: unknown) => {
  try { return await printer.print(await fetchReceipt(String(orderId), tokenOf(sessionToken))); }
  catch (error) { reportStartupFailure(error); return { ok: false, status: 'error', code: 'PRINT_FAILED', message: 'Receipt could not be printed. Check the printer and try again.', retryable: true }; }
});
ipcMain.handle('hardware:test-printer', async () => printer.print({ orderNumber: 'HARDWARE-TEST', storeName: 'RJ POS', totalMinor: '0', currency: 'USD', lines: [{ label: 'Printer test successful', quantity: 1, totalMinor: '0' }] }));
ipcMain.handle('hardware:open-drawer', async (_event, request: unknown) => {
  try {
    const value = request && typeof request === 'object' ? request as { reason?: unknown; orderId?: unknown; elevationToken?: unknown; sessionToken?: unknown } : {};
    if (typeof value.orderId === 'string') {
      const response = await fetch(`${apiUrl}/orders/${value.orderId}/receipt`, { headers: registerHeaders(tokenOf(value.sessionToken)), signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error('DRAWER_SALE_NOT_FOUND');
      const receipt = await response.json() as { payments?: Array<{ kind: string; status: string }> };
      if (!receipt.payments?.some((payment) => payment.kind === 'CASH' && ['CAPTURED', 'REFUNDED'].includes(payment.status))) throw new Error('DRAWER_CASH_SALE_REQUIRED');
    } else {
      const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
      if (!reason) throw new Error('DRAWER_REASON_REQUIRED');
      const authorization = await fetch(`${apiUrl}/register/manual-drawer-open`, { method: 'POST', headers: { 'content-type': 'application/json', ...registerHeaders(tokenOf(value.sessionToken), tokenOf(value.elevationToken)) }, body: JSON.stringify({ reason }), signal: AbortSignal.timeout(5_000) });
      if (!authorization.ok) throw new Error('DRAWER_NOT_AUTHORIZED');
    }
    return drawer.open();
  } catch (error) { reportStartupFailure(error); return { ok: false, status: 'error', code: 'DRAWER_FAILED', message: 'Drawer could not be opened.', retryable: false }; }
});

void app
  .whenReady()
  .then(async () => {
    if (app.isPackaged) {
      const rendererRoot = path.resolve(process.resourcesPath, 'renderer');
      protocol.handle('rjpos', (request) => {
        const requestUrl = new URL(request.url);
        const decoded = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
        const relativePath = !decoded || decoded.endsWith('/') ? `${decoded}index.html` : decoded;
        const rendererPath = path.resolve(rendererRoot, relativePath);
        if (rendererPath !== rendererRoot && !rendererPath.startsWith(`${rendererRoot}${path.sep}`)) {
          return new Response('Not found', { status: 404 });
        }
        return net.fetch(pathToFileURL(rendererPath).toString());
      });
    }
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch(reportStartupFailure);
      }
    });
  })
  .catch((error: unknown) => {
    reportStartupFailure(error);
    app.exit(1);
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
