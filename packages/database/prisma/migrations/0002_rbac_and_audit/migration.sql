CREATE TABLE "Role" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Permission" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "EmployeeRole" (
  "organizationId" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  CONSTRAINT "EmployeeRole_pkey" PRIMARY KEY ("organizationId", "employeeId", "roleId")
);
CREATE TABLE "RolePermission" (
  "organizationId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "permissionId" UUID NOT NULL,
  CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("organizationId", "roleId", "permissionId")
);
CREATE UNIQUE INDEX "Role_org_name" ON "Role" ("organizationId", "name");
CREATE UNIQUE INDEX "Permission_org_code" ON "Permission" ("organizationId", "code");
CREATE UNIQUE INDEX "Role_org_id" ON "Role" ("organizationId", "id");
CREATE UNIQUE INDEX "Permission_org_id" ON "Permission" ("organizationId", "id");
ALTER TABLE "Role" ADD CONSTRAINT "Role_org_fk" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id");
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_org_fk" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id");
ALTER TABLE "EmployeeRole" ADD CONSTRAINT "EmployeeRole_employee_fk" FOREIGN KEY ("organizationId", "employeeId") REFERENCES "Employee"("organizationId", "id");
ALTER TABLE "EmployeeRole" ADD CONSTRAINT "EmployeeRole_role_fk" FOREIGN KEY ("organizationId", "roleId") REFERENCES "Role"("organizationId", "id");
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_role_fk" FOREIGN KEY ("organizationId", "roleId") REFERENCES "Role"("organizationId", "id");
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permission_fk" FOREIGN KEY ("organizationId", "permissionId") REFERENCES "Permission"("organizationId", "id");

CREATE UNIQUE INDEX IF NOT EXISTS price_org_effective_start
  ON "Price" ("organizationId", "variantId", "effectiveFrom") WHERE "storeId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS price_store_effective_start
  ON "Price" ("organizationId", "storeId", "variantId", "effectiveFrom") WHERE "storeId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_reservation_active_order
  ON "InventoryReservation" ("organizationId", "orderId") WHERE "status" = 'ACTIVE';
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'AUDIT_IMMUTABLE'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_record_immutable ON "AuditRecord";
CREATE TRIGGER audit_record_immutable BEFORE UPDATE OR DELETE ON "AuditRecord" FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
