import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rjpos', {
  hardwareStatus: (): Promise<{ status: 'simulated' }> =>
    ipcRenderer.invoke('hardware:status'),
});
