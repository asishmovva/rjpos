import { describe, expect, it } from 'vitest';
import { applyElevation, issueElevationToken } from '../src/elevation-token.js';
import { rolePermissions } from '../src/tenant-context.js';

const cashier = { organizationId: 'org-1', userId: 'cashier-1', storeId: 'store-1', registerId: 'register-1', permissions: new Set(rolePermissions.CASHIER!) };
const token = (overrides: Partial<Parameters<typeof issueElevationToken>[0]> = {}) => issueElevationToken({ org: 'org-1', reg: 'register-1', sub: 'manager-1', role: 'MANAGER', exp: Date.now() + 60_000, ...overrides });

describe('manager elevation tokens', () => {
  it('lets a cashier request carry the approver permissions and records who approved', () => {
    expect(cashier.permissions.has('discount:apply')).toBe(false);
    const elevated = applyElevation(cashier, token());
    expect(elevated.permissions.has('discount:apply')).toBe(true);
    expect(elevated.permissions.has('order:refund')).toBe(true);
    expect(elevated).toMatchObject({ userId: 'cashier-1', approvedByEmployeeId: 'manager-1' });
  });
  it('rejects tampered, expired, and other-register tokens', () => {
    const [body, signature] = token().split('.');
    const forged = Buffer.from(JSON.stringify({ org: 'org-1', reg: 'register-1', sub: 'cashier-1', role: 'OWNER', exp: Date.now() + 60_000 })).toString('base64url');
    expect(() => applyElevation(cashier, `${forged}.${signature}`)).toThrow('ELEVATION_INVALID');
    expect(() => applyElevation(cashier, `${body}.bad`)).toThrow('ELEVATION_INVALID');
    expect(() => applyElevation(cashier, 'garbage')).toThrow('ELEVATION_INVALID');
    expect(() => applyElevation(cashier, token({ exp: Date.now() - 1 }))).toThrow('ELEVATION_EXPIRED');
    expect(() => applyElevation({ ...cashier, registerId: 'register-2' }, token())).toThrow('ELEVATION_INVALID');
    expect(() => applyElevation({ ...cashier, organizationId: 'org-2' }, token())).toThrow('ELEVATION_INVALID');
  });
});
