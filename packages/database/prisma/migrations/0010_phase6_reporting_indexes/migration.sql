-- Phase 6 reporting adds an employee/register report that filters register
-- sessions by store and open date range. This index supports that query.
CREATE INDEX "RegisterSession_reporting_period_idx" ON "RegisterSession"("organizationId", "storeId", "openedAt");
