import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import {
  loadRegisterEnvironment,
  resolveRendererTarget,
  waitForRenderer,
} from './renderer-config.js';
import { secureWebPreferences } from './security.js';

let mainWindow: BrowserWindow | null = null;

function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`RJ POS register startup failed: ${message}`);
}

async function runSmokeVerification(
  window: BrowserWindow,
  securityPreferences: ReturnType<typeof secureWebPreferences>,
): Promise<void> {
  if (!process.argv.includes('--smoke-test')) return;

  const result = (await window.webContents.executeJavaScript(`
    (async () => ({
      heading: document.querySelector('h1')?.textContent ?? null,
      hardwareStatus: (await window.rjpos.hardwareStatus()).status,
    }))()
  `)) as { heading: string | null; hardwareStatus: string };
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
  console.log(`RJPOS_REGISTER_SMOKE ${JSON.stringify(smokeResult)}`);
  app.exit(
    result.heading === 'RJ POS' &&
      result.hardwareStatus === 'simulated' &&
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

  const rendererTarget = resolveRendererTarget(
    app.isPackaged,
    path.join(import.meta.dirname, 'renderer.html'),
    loadRegisterEnvironment(),
  );
  if (rendererTarget.type === 'file') {
    await window.loadFile(rendererTarget.value);
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

ipcMain.handle('hardware:status', () => ({ status: 'simulated' as const }));

void app
  .whenReady()
  .then(async () => {
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
