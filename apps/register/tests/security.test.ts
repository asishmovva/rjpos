import { describe, expect, it } from 'vitest';
import { secureWebPreferences } from '../src/security.js';

describe('Electron security boundary', () => {
  it('enables isolation, disables node integration, and enables sandbox', () => {
    expect(secureWebPreferences('preload.js')).toEqual({ preload: 'preload.js', contextIsolation: true, nodeIntegration: false, sandbox: true });
  });
});
