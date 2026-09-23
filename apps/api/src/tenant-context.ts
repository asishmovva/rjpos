import { Injectable } from '@nestjs/common';

export type AuthenticatedTenantContext = {
  organizationId: string;
  userId: string;
  storeId?: string;
  registerId?: string;
  permissions: ReadonlySet<string>;
};

@Injectable()
export class TenantContextService {
  require(
    context: AuthenticatedTenantContext | undefined,
  ): AuthenticatedTenantContext {
    if (!context) throw new Error('UNAUTHORIZED');
    return context;
  }
}
