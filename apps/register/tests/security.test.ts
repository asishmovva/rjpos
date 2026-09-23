import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RENDERER_URL,
  resolveDevelopmentRendererUrl,
  resolveRendererTarget,
  waitForRenderer,
} from '../src/renderer-config.js';
import { secureWebPreferences } from '../src/security.js';

describe('Electron security boundary', () => {
  it('enables isolation, disables node integration, and enables sandbox', () => {
    expect(secureWebPreferences('preload.js')).toEqual({
      preload: 'preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  it('uses the configured web renderer URL during development', () => {
    expect(
      resolveRendererTarget(false, 'renderer.html', {
        RJPOS_RENDERER_URL: 'http://127.0.0.1:3000/register',
      }),
    ).toEqual({ type: 'url', value: 'http://127.0.0.1:3000/register' });
  });

  it('uses a sensible local renderer fallback', () => {
    expect(resolveDevelopmentRendererUrl({})).toBe(`${DEFAULT_RENDERER_URL}/`);
  });

  it('loads a packaged renderer file in production', () => {
    expect(
      resolveRendererTarget(true, 'renderer.html', {
        RJPOS_RENDERER_URL: 'http://localhost:3000',
      }),
    ).toEqual({ type: 'file', value: 'renderer.html' });
  });

  it('rejects renderer URLs that could expose credentials or local files', () => {
    expect(() =>
      resolveDevelopmentRendererUrl({
        RJPOS_RENDERER_URL: 'http://user:password@localhost:3000',
      }),
    ).toThrow();
    expect(() =>
      resolveDevelopmentRendererUrl({
        RJPOS_RENDERER_URL: 'file:///C:/sensitive.html',
      }),
    ).toThrow();
  });

  it('bounds web-server availability checks without an infinite loop', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    await expect(
      waitForRenderer('http://localhost:3000', {
        attempts: 3,
        intervalMilliseconds: 0,
        requestTimeoutMilliseconds: 10,
        fetcher,
      }),
    ).rejects.toThrow('after 3 attempts');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
