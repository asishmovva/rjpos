# Architecture

RJ POS Phase 0 is a modular monolith. The API, worker, web portal, and Electron register are separate applications in one workspace. PostgreSQL is authoritative; Redis supports background work. Tenant context comes from authenticated identity and is required by tenant-scoped repositories. Provider-specific authentication and payment code remains behind interfaces. PostgreSQL audit records are append-only through a database trigger. Outbox delivery is at least once and uses idempotent handlers.
