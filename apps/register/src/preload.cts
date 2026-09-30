import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rjpos', {
  hardwareStatus: () => ipcRenderer.invoke('hardware:status'),
  printReceipt: (orderId: string, sessionToken?: string) => ipcRenderer.invoke('hardware:print-receipt', orderId, sessionToken),
  toggleCustomerDisplay: () => ipcRenderer.invoke('display:toggle-customer'),
  printLabels: (document: unknown) => ipcRenderer.invoke('hardware:print-labels', document),
  testPrinter: () => ipcRenderer.invoke('hardware:test-printer'),
  openDrawer: (request: { reason?: string; orderId?: string; elevationToken?: string; sessionToken?: string }) => ipcRenderer.invoke('hardware:open-drawer', request),
});
