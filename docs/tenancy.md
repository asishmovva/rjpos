# Tenancy

`Organization` is the canonical tenant. Stores and registers belong to an organization. Tenant-owned records carry `organizationId`, and compound foreign keys preserve matching organization identity across relationships. API services must use scoped repository methods. Cross-tenant reads, updates, and relationship injection are rejected and covered by integration tests.
