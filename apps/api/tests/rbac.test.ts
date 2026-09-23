import { describe, expect, it } from 'vitest';
import { contextFromDevelopmentHeaders, rolePermissions } from '../src/tenant-context.js';

function request(role: string) {
  return { header: (name: string) => name === 'x-rjpos-role' ? role : undefined } as never;
}

describe('Phase 1 API role permissions', () => {
  it('allows Owner and Manager to perform sensitive Core POS operations', () => {
    for (const role of ['OWNER', 'MANAGER']) {
      const permissions = contextFromDevelopmentHeaders(request(role)).permissions;
      expect(permissions.has('inventory:adjust')).toBe(true);
      expect(permissions.has('register:close')).toBe(true);
      expect(permissions.has('order:void')).toBe(true);
      expect(permissions.has('order:refund')).toBe(true);
      expect(permissions.has('discount:apply')).toBe(true);
    }
  });

  it('denies sensitive operations to Cashier while retaining selling access', () => {
    const permissions = contextFromDevelopmentHeaders(request('CASHIER')).permissions;
    expect(permissions.has('sale:create')).toBe(true);
    expect(permissions.has('inventory:adjust')).toBe(false);
    expect(permissions.has('register:close')).toBe(false);
    expect(permissions.has('order:void')).toBe(false);
    expect(permissions.has('order:refund')).toBe(false);
    expect(permissions.has('discount:apply')).toBe(false);
  });

  it('keeps settings changes Owner-only', () => {
    expect(rolePermissions.OWNER).toContain('settings:write');
    expect(rolePermissions.MANAGER).not.toContain('settings:write');
    expect(rolePermissions.CASHIER).not.toContain('settings:write');
  });
});
