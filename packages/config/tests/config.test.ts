import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  assertTestDatabaseIsolation,
  findWorkspaceRoot,
  loadEnvironment,
  loadTestEnvironment,
  normalizeDatabaseIdentity,
} from '../src/index.js';

describe('environment configuration', () => {
  it('loads valid required configuration', () => {
    expect(
      loadEnvironment({
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost',
      }).AUTH_PROVIDER,
    ).toBe('development');
  });

  it('fails clearly when required configuration is invalid', () => {
    expect(() => loadEnvironment({ REDIS_URL: 'redis://localhost' })).toThrow();
  });

  it('fails clearly when a required URL is malformed', () => {
    expect(() =>
      loadEnvironment({
        DATABASE_URL: 'not-a-url',
        REDIS_URL: 'redis://localhost',
      }),
    ).toThrow();
  });

  it('finds the repository root from a workspace package directory', () => {
    expect(findWorkspaceRoot()).toBe(resolve(process.cwd(), '../..'));
  });

  it('loads all required test configuration values', () => {
    expect(
      loadTestEnvironment({
        TEST_DATABASE_URL: 'postgresql://localhost/rjpos_test',
        TEST_REDIS_URL: 'redis://localhost:6380',
        TEST_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000001',
        TEST_STORE_ID: '00000000-0000-0000-0000-000000000002',
        TEST_VARIANT_ID: '00000000-0000-0000-0000-000000000009',
        TEST_ORDER_ID_ONE: '00000000-0000-0000-0000-000000000010',
        TEST_ORDER_ID_TWO: '00000000-0000-0000-0000-000000000011',
      }),
    ).toMatchObject({ TEST_REDIS_URL: 'redis://localhost:6380' });
  });

  it('rejects incomplete test configuration', () => {
    expect(() =>
      loadTestEnvironment({
        TEST_DATABASE_URL: 'postgresql://localhost/rjpos_test',
      }),
    ).toThrow();
  });

  it('normalizes PostgreSQL host aliases, default ports, encoding, and query strings', () => {
    expect(
      normalizeDatabaseIdentity(
        'postgresql://user:password@LOCALHOST./rjpos%5Ftest?schema=one',
      ),
    ).toEqual({ host: 'loopback', port: 5432, database: 'rjpos_test' });
    expect(
      normalizeDatabaseIdentity(
        'postgres://other:credentials@127.0.0.1:5432/rjpos_test?schema=two',
      ),
    ).toEqual({ host: 'loopback', port: 5432, database: 'rjpos_test' });
  });

  it('rejects an equivalent development database identity', () => {
    expect(() =>
      assertTestDatabaseIsolation(
        'postgresql://test:test@127.0.0.1:5432/rjpos%5Ftest?schema=test',
        'postgres://dev:dev@localhost/rjpos_test?schema=public',
      ),
    ).toThrow('same host, port, and database');
  });

  it('rejects a database without an explicit test designation', () => {
    expect(() =>
      assertTestDatabaseIsolation(
        'postgresql://test:test@127.0.0.1:15433/rjpos',
      ),
    ).toThrow('explicitly test-designated database');
  });

  it('allows a distinct explicitly test-designated database', () => {
    expect(
      assertTestDatabaseIsolation(
        'postgresql://test:test@127.0.0.1:15433/rjpos_test',
        'postgresql://dev:dev@localhost:15432/rjpos',
      ),
    ).toEqual({ host: 'loopback', port: 15433, database: 'rjpos_test' });
  });
});
