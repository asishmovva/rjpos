import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

export type AuthenticatedTenantContext = {
  organizationId: string;
  userId: string;
  storeId?: string;
  registerId?: string;
  permissions: ReadonlySet<string>;
  /** Set when a manager/owner PIN elevation authorized this request. */
  approvedByEmployeeId?: string;
};

export type TenantRequest = Request & { tenantContext?: AuthenticatedTenantContext };

export const rolePermissions: Record<string, readonly string[]> = {
  OWNER: ['cash:paid-in', 'cash:safe-drop', 'cash:paid-out', 'cash:adjust', 'dayclose:manage', 'quickkey:manage', 'drawer:open', 'price:override', 'report:read', 'report:export', 'catalog:read', 'catalog:manage', 'price:manage', 'inventory:read', 'inventory:adjust', 'inventory:transfer', 'inventory:count', 'replenishment:read', 'promotion:manage', 'employee:manage', 'store:manage', 'register:manage', 'register:open', 'register:close', 'sale:create', 'discount:apply', 'order:read', 'order:void', 'order:refund', 'audit:read', 'dashboard:read', 'settings:write', 'workforce:clock', 'workforce:manage', 'customer:read', 'customer:manage', 'loyalty:manage', 'giftcard:manage', 'giftcard:redeem', 'mastercatalog:manage', 'vendor:read', 'vendor:manage', 'purchase:read', 'purchase:manage', 'bulk:manage', 'import:manage', 'system:read'],
  MANAGER: ['cash:paid-in', 'cash:safe-drop', 'cash:paid-out', 'cash:adjust', 'dayclose:manage', 'quickkey:manage', 'drawer:open', 'price:override', 'report:read', 'report:export', 'catalog:read', 'catalog:manage', 'price:manage', 'inventory:read', 'inventory:adjust', 'inventory:transfer', 'inventory:count', 'replenishment:read', 'promotion:manage', 'employee:manage', 'register:manage', 'register:open', 'register:close', 'sale:create', 'discount:apply', 'order:read', 'order:void', 'order:refund', 'audit:read', 'dashboard:read', 'workforce:clock', 'workforce:manage', 'customer:read', 'customer:manage', 'loyalty:manage', 'giftcard:manage', 'giftcard:redeem', 'vendor:read', 'purchase:read', 'purchase:manage', 'bulk:manage'],
  CASHIER: ['cash:paid-in', 'cash:safe-drop', 'catalog:read', 'inventory:read', 'register:open', 'register:close', 'sale:create', 'order:read', 'workforce:clock', 'customer:read', 'customer:manage', 'giftcard:redeem'],
};

export function contextFromDevelopmentHeaders(request: Request): AuthenticatedTenantContext {
  const role = (request.header('x-rjpos-role') ?? 'OWNER').toUpperCase();
  return {
    organizationId: request.header('x-rjpos-organization-id') ?? '00000000-0000-0000-0000-000000000001',
    userId: request.header('x-rjpos-employee-id') ?? '00000000-0000-0000-0000-000000000004',
    storeId: request.header('x-rjpos-store-id') ?? '00000000-0000-0000-0000-000000000002',
    registerId: request.header('x-rjpos-register-id') ?? '00000000-0000-0000-0000-000000000003',
    permissions: new Set(rolePermissions[role] ?? []),
  };
}

export const productionMode = (): boolean => process.env.NODE_ENV === 'production';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Production has no header-based identity. An unauthenticated request is only a device binding (organization and store come from
 * the server environment, the register from the device) with no permissions; PIN login is the only way to obtain any.
 */
export function contextFromProductionDevice(request?: Request): AuthenticatedTenantContext {
  const organizationId = process.env.RJPOS_ORGANIZATION_ID; const storeId = process.env.RJPOS_STORE_ID;
  if (!organizationId || !storeId) throw new Error('RJPOS_ORGANIZATION_ID and RJPOS_STORE_ID are required in production');
  const registerHeader = request?.header('x-rjpos-register-id') ?? process.env.RJPOS_REGISTER_ID;
  return { organizationId, userId: '00000000-0000-0000-0000-000000000000', storeId, ...(registerHeader && UUID.test(registerHeader) ? { registerId: registerHeader } : {}), permissions: new Set<string>() };
}

@Injectable()
export class TenantContextService {
  require(
    context: AuthenticatedTenantContext | undefined,
  ): AuthenticatedTenantContext {
    if (!context) throw new Error('UNAUTHORIZED');
    return context;
  }
}
