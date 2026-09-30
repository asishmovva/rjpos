import { hashPin } from '@rjpos/database';
import { describe, expect, it } from 'vitest';
import { applyElevation, contextFromSession, issueElevationToken, issueSessionToken } from '../src/elevation-token.js';
import { ElevationController } from '../src/elevation.js';
import { rolePermissions } from '../src/tenant-context.js';

const cashier = { organizationId: 'org-1', userId: 'cashier-1', storeId: 'store-1', registerId: 'register-1', permissions: new Set(rolePermissions.CASHIER!) };
const claims = { org: 'org-1', store: 'store-1', reg: 'register-1', sub: 'employee-9', role: 'MANAGER', exp: Date.now() + 60_000 };

describe('PIN login sessions', () => {
  it('builds the real employee identity and role permissions from a session token, and never accepts an elevation token as a session', () => {
    const context = contextFromSession(issueSessionToken(claims));
    expect(context).toMatchObject({ organizationId: 'org-1', userId: 'employee-9', storeId: 'store-1', registerId: 'register-1' });
    expect(context.permissions.has('order:refund')).toBe(true);
    expect(() => contextFromSession(issueElevationToken(claims))).toThrow('SESSION_INVALID');
    expect(() => contextFromSession(issueSessionToken({ ...claims, exp: Date.now() - 1 }))).toThrow('SESSION_EXPIRED');
    expect(() => contextFromSession('garbage.value')).toThrow('SESSION_INVALID');
    expect(() => applyElevation(cashier, issueSessionToken(claims))).toThrow('ELEVATION_INVALID');
  });

  it('logs in by PIN against stored hashes, audits, rate-limits repeated failures, and never returns the PIN or hash', async () => {
    const audits: unknown[] = [];
    const prisma = { register: { findFirst: async () => ({ id: 'register-login-test' }) }, employee: { findMany: async () => [
      { id: 'e-1', firstName: 'Casey', lastName: 'Cashier', pinHash: hashPin('1111'), roles: [{ role: { name: 'Cashier' } }] },
      { id: 'e-2', firstName: 'Riley', lastName: 'Reed', pinHash: hashPin('2222'), roles: [{ role: { name: 'Manager' } }, { role: { name: 'Cashier' } }] },
      { id: 'e-3', firstName: 'No', lastName: 'Role', pinHash: hashPin('3333'), roles: [] },
    ] }, auditRecord: { create: async (args: unknown) => { audits.push(args); } } };
    const controller = new ElevationController(prisma as never, { require: (context: unknown) => context } as never);
    const request = { tenantContext: { ...cashier, registerId: 'register-login-test' } } as never;
    const success = await controller.login(request, { pin: '2222' });
    expect(success).toMatchObject({ role: 'MANAGER', employee: { id: 'e-2', name: 'Riley Reed' } });
    expect(JSON.stringify(success)).not.toMatch(/2222|scrypt/);
    expect(contextFromSession(success.token)).toMatchObject({ userId: 'e-2' });
    await expect(controller.login(request, { pin: '3333' })).rejects.toThrow('LOGIN_PIN_INVALID');
    for (let attempt = 0; attempt < 4; attempt += 1) await expect(controller.login(request, { pin: '9999' })).rejects.toThrow('LOGIN_PIN_INVALID');
    await expect(controller.login(request, { pin: '1111' })).rejects.toThrow('LOGIN_LOCKED');
    expect(audits.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(audits)).not.toMatch(/2222|9999/);
  });
});
