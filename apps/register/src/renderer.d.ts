declare global {
  interface Window {
    rjpos: { hardwareStatus: () => Promise<{ status: 'simulated' }> };
  }
}
export {};
