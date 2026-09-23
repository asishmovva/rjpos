import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { secureWebPreferences } from './security.js';

function createWindow(): void {
  const window = new BrowserWindow({
    webPreferences: secureWebPreferences(path.join(import.meta.dirname, 'preload.js')),
  });
  void window.loadFile(path.join(import.meta.dirname, 'renderer.html'));
}

ipcMain.handle('hardware:status', () => ({ status: 'simulated' as const }));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
