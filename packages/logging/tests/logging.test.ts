import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, redact, sanitizeLogText } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logging helpers', () => {
  it('sanitizes credentials and named secrets in text', () => {
    const input =
      'postgresql://db-user:db-credential@db/rjpos password=password-value token=token-value accessToken=access-value authorization=auth-value cookie=cookie-value apiKey=api-value secret=secret-value';
    const output = sanitizeLogText(input);

    for (const secret of [
      'db-user',
      'db-credential',
      'password-value',
      'token-value',
      'access-value',
      'auth-value',
      'cookie-value',
      'api-value',
      'secret-value',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output.match(/\[REDACTED\]/g)?.length).toBe(8);
  });

  it('redacts supported sensitive keys recursively', () => {
    const result = redact({
      password: 'one',
      accessToken: 'two',
      nested: {
        authorization: 'three',
        cookie: 'four',
        api_key: 'five',
        cardNumber: 'six',
        cvv: 'seven',
        safe: 'visible',
      },
    });

    expect(result).toEqual({
      password: '[REDACTED]',
      accessToken: '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        api_key: '[REDACTED]',
        cardNumber: '[REDACTED]',
        cvv: '[REDACTED]',
        safe: 'visible',
      },
    });
  });

  it('emits structured JSON with correlation context and a timestamp', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('warn', 'Dependency unavailable', { requestId: 'request-123' });

    expect(output).toHaveBeenCalledOnce();
    const record = JSON.parse(String(output.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      level: 'warn',
      message: 'Dependency unavailable',
      requestId: 'request-123',
    });
    expect(Number.isNaN(Date.parse(String(record.timestamp)))).toBe(false);
  });

  it('does not leak secrets passed through message or context values', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('error', 'authorization=Bearer-secret', {
      requestId: 'request-456',
      errorMessage: 'password=database-secret',
    });

    const serialized = String(output.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('Bearer-secret');
    expect(serialized).not.toContain('database-secret');
    expect(serialized).toContain('[REDACTED]');
  });
});
