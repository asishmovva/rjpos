import { describe, expect, it, vi } from 'vitest';
import { BackOfficeController } from '../src/back-office.js';
import { PhaseThreeController } from '../src/phase-three.js';
import { contextFromDevelopmentHeaders, rolePermissions, TenantContextService } from '../src/tenant-context.js';

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
    expect(permissions.has('register:close')).toBe(true);
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

describe('Phase 8 cash and day-close authorization', () => {
  it('limits cashiers to paid in and safe drops; paid out, adjustments, no-sale, and day close need a manager', () => {
    const cashier = contextFromDevelopmentHeaders(request('CASHIER')).permissions;
    expect(cashier.has('cash:paid-in')).toBe(true); expect(cashier.has('cash:safe-drop')).toBe(true);
    for (const permission of ['cash:paid-out', 'cash:adjust', 'drawer:open', 'dayclose:manage', 'report:read']) expect(cashier.has(permission)).toBe(false);
    for (const role of ['MANAGER', 'OWNER']) {
      const permissions = contextFromDevelopmentHeaders(request(role)).permissions;
      for (const permission of ['cash:paid-in', 'cash:safe-drop', 'cash:paid-out', 'cash:adjust', 'drawer:open', 'dayclose:manage']) expect(permissions.has(permission)).toBe(true);
    }
  });
});

describe('Phase 2 back-office authorization', () => {
  it('gives Owner the complete administrative boundary and keeps settings/store management Owner-only', () => {
    expect(rolePermissions.OWNER).toEqual(expect.arrayContaining(['catalog:manage', 'price:manage', 'inventory:adjust', 'employee:manage', 'store:manage', 'register:manage', 'order:refund', 'audit:read', 'dashboard:read', 'settings:write']));
    expect(rolePermissions.MANAGER).toEqual(expect.arrayContaining(['catalog:manage', 'price:manage', 'inventory:adjust', 'employee:manage', 'register:manage', 'order:refund', 'audit:read', 'dashboard:read']));
    expect(rolePermissions.MANAGER).not.toContain('store:manage');
    expect(rolePermissions.MANAGER).not.toContain('settings:write');
  });

  it('does not grant Cashier access to administrative APIs', () => {
    const permissions = contextFromDevelopmentHeaders(request('CASHIER')).permissions;
    for (const permission of ['catalog:manage', 'price:manage', 'inventory:adjust', 'employee:manage', 'store:manage', 'register:manage', 'audit:read', 'dashboard:read', 'settings:write']) {
      expect(permissions.has(permission)).toBe(false);
    }
  });

  it('separates self-service workforce/customer selling permissions from manager-only corrections and value administration', () => {
    expect(rolePermissions.CASHIER).toEqual(expect.arrayContaining(['workforce:clock', 'customer:read', 'customer:manage', 'giftcard:redeem']));
    expect(rolePermissions.CASHIER).not.toEqual(expect.arrayContaining(['workforce:manage', 'loyalty:manage', 'giftcard:manage']));
    for (const role of ['OWNER', 'MANAGER']) {
      expect(rolePermissions[role]).toEqual(expect.arrayContaining(['workforce:manage', 'loyalty:manage', 'giftcard:manage']));
    }
  });

  it('grants Owner full supplier/catalog purchasing access, Manager operational purchasing, and no purchasing access to Cashier', () => {
    expect(rolePermissions.OWNER).toEqual(expect.arrayContaining([
      'mastercatalog:manage', 'vendor:read', 'vendor:manage', 'purchase:read', 'purchase:manage',
    ]));
    expect(rolePermissions.MANAGER).toEqual(expect.arrayContaining(['vendor:read', 'purchase:read', 'purchase:manage']));
    for (const permission of ['mastercatalog:manage', 'vendor:manage']) expect(rolePermissions.MANAGER).not.toContain(permission);
    for (const permission of ['mastercatalog:manage', 'vendor:read', 'vendor:manage', 'purchase:read', 'purchase:manage']) {
      expect(rolePermissions.CASHIER).not.toContain(permission);
    }
  });

  it('rejects inactive employees even when a supplied role header claims Owner', async () => {
    const prisma = { employee: { findFirst: vi.fn(async () => null) } };
    const controller = new BackOfficeController(prisma as never, new TenantContextService());
    const tenantContext = contextFromDevelopmentHeaders(request('OWNER'));
    await expect(controller.dashboard({ tenantContext } as never)).rejects.toMatchObject({ status: 403 });
    expect(prisma.employee.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }));
  });
});

describe('Phase 3 query validation', () => {
  it('returns a 400-style error for malformed pagination query values', async () => {
    const controller = new PhaseThreeController({} as never, new TenantContextService());
    await expect(controller.shifts({} as never, { page: 'abc' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('Phase 6 reporting authorization', () => {
  it('allows Owner and Manager reporting/export while denying Cashier', () => {
    for (const role of ['OWNER', 'MANAGER']) expect(rolePermissions[role]).toEqual(expect.arrayContaining(['report:read', 'report:export']));
    expect(rolePermissions.CASHIER).not.toContain('report:read');
    expect(rolePermissions.CASHIER).not.toContain('report:export');
  });
});

describe('Phase 7 register-operation authorization', () => {
  it('limits Quick Key configuration, manual drawer opens, and price overrides to managers and owners', () => {
    for (const role of ['OWNER', 'MANAGER']) {
      expect(rolePermissions[role]).toEqual(expect.arrayContaining([
        'quickkey:manage',
        'drawer:open',
        'price:override',
      ]));
    }
    expect(rolePermissions.CASHIER).not.toContain('quickkey:manage');
    expect(rolePermissions.CASHIER).not.toContain('drawer:open');
    expect(rolePermissions.CASHIER).not.toContain('price:override');
  });
});
