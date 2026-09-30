import { describe, expect, it } from 'vitest';
import { DevelopmentAuthMiddleware } from '../src/core-pos.js';
import { issueSessionToken } from '../src/elevation-token.js';
import { contextFromProductionDevice, rolePermissions } from '../src/tenant-context.js';

const claims = { org: 'org-1', store: 'store-1', reg: 'register-1', sub: 'employee-9', role: 'CASHIER', exp: Date.now() + 60_000 };
const requestOf = (headers: Record<string, string>) => ({ header: (name: string) => headers[name.toLowerCase()] }) as never;

describe('Phase 9 permissions', () => {
  it('keeps bulk, import, and system tools away from cashiers and system status to the owner only', () => {
    for (const permission of ['bulk:manage', 'import:manage', 'system:read']) expect(rolePermissions.CASHIER).not.toContain(permission);
    expect(rolePermissions.MANAGER).toContain('bulk:manage');
    expect(rolePermissions.MANAGER).not.toContain('import:manage');
    expect(rolePermissions.MANAGER).not.toContain('system:read');
    for (const permission of ['bulk:manage', 'import:manage', 'system:read']) expect(rolePermissions.OWNER).toContain(permission);
  });
});

describe('Session revocation', () => {
  const middleware = (employee: { sessionVersion: number } | null) => new DevelopmentAuthMiddleware({ employee: { findFirst: async () => employee } } as never);
  const run = async (instance: DevelopmentAuthMiddleware, request: never) => { let error: unknown; let called = false; await instance.use(request, {} as never, ((failure?: unknown) => { error = failure; called = true; }) as never); return { error, called }; };

  it('accepts a session whose version matches and rejects a revoked, bumped, or deactivated employee', async () => {
    const ok = requestOf({ 'x-rjpos-session': issueSessionToken({ ...claims, sub: 'ok-employee', sv: 3 }) });
    expect(await run(middleware({ sessionVersion: 3 }), ok)).toMatchObject({ error: undefined, called: true });
    const bumped = requestOf({ 'x-rjpos-session': issueSessionToken({ ...claims, sub: 'bumped-employee', sv: 3 }) });
    expect((await run(middleware({ sessionVersion: 4 }), bumped)).error).toMatchObject({ code: 'SESSION_REVOKED' });
    const gone = requestOf({ 'x-rjpos-session': issueSessionToken({ ...claims, sub: 'gone-employee', sv: 0 }) });
    expect((await run(middleware(null), gone)).error).toMatchObject({ code: 'SESSION_REVOKED' });
  });
});

describe('Production device binding', () => {
  it('ignores identity headers, takes the tenant from the environment, and grants no permissions without a PIN session', () => {
    const previous = { org: process.env.RJPOS_ORGANIZATION_ID, store: process.env.RJPOS_STORE_ID };
    process.env.RJPOS_ORGANIZATION_ID = '00000000-0000-0000-0000-0000000000aa'; process.env.RJPOS_STORE_ID = '00000000-0000-0000-0000-0000000000bb';
    try {
      const context = contextFromProductionDevice(requestOf({ 'x-rjpos-role': 'OWNER', 'x-rjpos-organization-id': 'attacker', 'x-rjpos-register-id': '11111111-1111-1111-1111-111111111111' }) as never);
      expect(context).toMatchObject({ organizationId: '00000000-0000-0000-0000-0000000000aa', storeId: '00000000-0000-0000-0000-0000000000bb', registerId: '11111111-1111-1111-1111-111111111111' });
      expect(context.permissions.size).toBe(0);
      expect(contextFromProductionDevice(requestOf({ 'x-rjpos-register-id': 'not-a-uuid' }) as never).registerId).toBeUndefined();
    } finally {
      if (previous.org === undefined) delete process.env.RJPOS_ORGANIZATION_ID; else process.env.RJPOS_ORGANIZATION_ID = previous.org;
      if (previous.store === undefined) delete process.env.RJPOS_STORE_ID; else process.env.RJPOS_STORE_ID = previous.store;
    }
  });
});

describe('Production configuration guard', () => {
  it('passes outside production and lists every unsafe production setting together', async () => {
    const { productionConfigProblems } = await import('../src/production-config.js');
    expect(productionConfigProblems({ NODE_ENV: 'development' })).toEqual([]);
    const uuid = '00000000-0000-0000-0000-0000000000aa';
    const variables = (problems: Array<{ variable: string }>) => problems.map((problem) => problem.variable);
    expect(variables(productionConfigProblems({ NODE_ENV: 'production' }))).toEqual(['RJPOS_ELEVATION_SECRET', 'RJPOS_ORGANIZATION_ID', 'RJPOS_STORE_ID']);
    const safe = { NODE_ENV: 'production', RJPOS_ELEVATION_SECRET: 'x'.repeat(40), RJPOS_ORGANIZATION_ID: uuid, RJPOS_STORE_ID: uuid, RJPOS_ALLOWED_ORIGINS: 'rjpos://app' };
    expect(productionConfigProblems(safe)).toEqual([]);
    expect(variables(productionConfigProblems({ ...safe, RJPOS_ELEVATION_SECRET: 'short', RJPOS_ALLOWED_ORIGINS: '*', RJPOS_TERMINAL_PROVIDER: 'simulated', RJPOS_INVOICE_OCR_PROVIDER: 'fixture', RJPOS_STORE_ID: 'nope' })))
      .toEqual(['RJPOS_ELEVATION_SECRET', 'RJPOS_STORE_ID', 'RJPOS_ALLOWED_ORIGINS', 'RJPOS_TERMINAL_PROVIDER', 'RJPOS_INVOICE_OCR_PROVIDER']);
    expect(variables(productionConfigProblems({ ...safe, RJPOS_TERMINAL_PROVIDER: 'http' }))).toEqual(['RJPOS_TERMINAL_ENDPOINT']);
  });
});
