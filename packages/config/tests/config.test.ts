import { describe, expect, it } from 'vitest';
import { loadEnvironment } from '../src/index.js';

describe('environment configuration', () => {
  it('loads valid required configuration', () => {
    expect(loadEnvironment({ DATABASE_URL: 'postgresql://localhost/db', REDIS_URL: 'redis://localhost' }).AUTH_PROVIDER).toBe('development');
  });

  it('fails clearly when required configuration is invalid', () => {
    expect(() => loadEnvironment({ REDIS_URL: 'redis://localhost' })).toThrow();
  });
});
