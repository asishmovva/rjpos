import { describe, expect, it } from 'vitest';
import { DevelopmentAuthProvider, requireOrganization, requirePermission } from '../src/index.js';

describe('development authentication and authorization', () => {
  it('authenticates through the provider abstraction', async () => {
    const identity = await new DevelopmentAuthProvider().authenticate({ subject: 'dev-owner', organizationId: 'org-a', userId: 'user-a' });
    expect(identity.organizationId).toBe('org-a');
    expect(identity.permissions.has('product.read')).toBe(true);
  });

  it('allows assigned permissions and rejects direct unauthorized calls', async () => {
    const identity = await new DevelopmentAuthProvider().authenticate({ subject: 'dev-cashier', organizationId: 'org-a', userId: 'user-a' });
    expect(() => requirePermission({ ...identity, permissions: identity.permissions }, 'product.read')).not.toThrow();
    expect(() => requirePermission({ ...identity, permissions: identity.permissions }, 'employee.manage')).toThrow('FORBIDDEN');
    expect(() => requireOrganization({ ...identity, permissions: identity.permissions }, 'org-b')).toThrow('TENANT_ACCESS_DENIED');
  });
});
