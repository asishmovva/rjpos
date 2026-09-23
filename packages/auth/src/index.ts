export type TenantContext = {
  organizationId: string;
  userId: string;
  storeId?: string;
  registerId?: string;
  permissions: ReadonlySet<string>;
};

export type AuthIdentity = {
  subject: string;
  organizationId: string;
  userId: string;
  permissions: ReadonlySet<string>;
};

export interface AuthProvider {
  authenticate(input: { subject: string; organizationId: string; userId: string }): Promise<AuthIdentity>;
}

export class DevelopmentAuthProvider implements AuthProvider {
  async authenticate(input: { subject: string; organizationId: string; userId: string }): Promise<AuthIdentity> {
    return { ...input, permissions: new Set(['product.read', 'product.update', 'register.open', 'register.close']) };
  }
}

export function requirePermission(
  context: TenantContext,
  permission: string,
): void {
  if (!context.permissions.has(permission)) throw new Error('FORBIDDEN');
}

export function requireOrganization(context: TenantContext, organizationId: string): void {
  if (context.organizationId !== organizationId) throw new Error('TENANT_ACCESS_DENIED');
}
