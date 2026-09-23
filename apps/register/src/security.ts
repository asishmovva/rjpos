export function secureWebPreferences(preload: string) {
  return { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } as const;
}