import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rjpos', {
  hardwareStatus: () => ipcRenderer.invoke('hardware:status'),
  printReceipt: (orderId: string) => ipcRenderer.invoke('hardware:print-receipt', orderId),
  testPrinter: () => ipcRenderer.invoke('hardware:test-printer'),
  openDrawer: (request: { reason?: string; orderId?: string }) => ipcRenderer.invoke('hardware:open-drawer', request),
});
