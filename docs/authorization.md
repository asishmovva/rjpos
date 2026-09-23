# Authorization

Authentication produces an identity and tenant context. Authorization is permission-based through centralized guards and `requirePermission`; frontend role strings are not authoritative. The development provider is isolated behind `AuthProvider`. Production provider selection remains external to Phase 0.
