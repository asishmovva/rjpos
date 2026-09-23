import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

export type AuthenticatedTenantContext = {
  organizationId: string;
  userId: string;
  storeId?: string;
  registerId?: string;
  permissions: ReadonlySet<string>;
};

export type TenantRequest = Request & { tenantContext?: AuthenticatedTenantContext };

export const rolePermissions: Record<string, readonly string[]> = {
  OWNER: ['catalog:read', 'inventory:read', 'inventory:adjust', 'register:open', 'register:close', 'sale:create', 'discount:apply', 'order:read', 'order:void', 'order:refund', 'settings:write'],
  MANAGER: ['catalog:read', 'inventory:read', 'inventory:adjust', 'register:open', 'register:close', 'sale:create', 'discount:apply', 'order:read', 'order:void', 'order:refund'],
  CASHIER: ['catalog:read', 'inventory:read', 'register:open', 'sale:create', 'order:read'],
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

@Injectable()
export class TenantContextService {
  require(
    context: AuthenticatedTenantContext | undefined,
  ): AuthenticatedTenantContext {
    if (!context) throw new Error('UNAUTHORIZED');
    return context;
  }
}
