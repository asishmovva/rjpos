import { Controller, ForbiddenException, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { REPORT_KINDS, accountingExport, getReport, reportCsv, type AdminActor, type ReportKind } from '@rjpos/database';
import type { Response } from 'express';
import { PRISMA } from './core-pos.js';
import { TenantContextService, type TenantRequest } from './tenant-context.js';

function integer(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const result = Number(value);
  return Number.isInteger(result) ? result : undefined;
}

@Controller('/api/v1/admin/reports')
export class ReportingController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient, @Inject(TenantContextService) private readonly tenants: TenantContextService) {}

  private async actor(request: TenantRequest, permission: 'report:read' | 'report:export'): Promise<AdminActor> {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has(permission)) throw new ForbiddenException();
    const employee = await this.prisma.employee.findFirst({ where: { id: context.userId, organizationId: context.organizationId, status: 'ACTIVE', ...(context.storeId ? { stores: { some: { storeId: context.storeId } } } : {}) }, select: { id: true } });
    if (!employee) throw new ForbiddenException();
    return { organizationId: context.organizationId, userId: context.userId, ...(context.storeId ? { storeId: context.storeId } : {}) };
  }

  private kind(value: string): ReportKind {
    if (!REPORT_KINDS.includes(value as ReportKind)) throw new ForbiddenException();
    return value as ReportKind;
  }

  private filters(query: Record<string, string>) {
    const page = integer(query.page); const pageSize = integer(query.pageSize);
    return { ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), ...(query.storeId ? { storeId: query.storeId } : {}), ...(query.timezone ? { timezone: query.timezone } : {}), ...(page ? { page } : {}), ...(pageSize ? { pageSize } : {}) };
  }

  @Get('accounting-export')
  async accounting(@Req() request: TenantRequest, @Query() query: Record<string, string>) {
    return accountingExport(this.prisma, await this.actor(request, 'report:export'), this.filters(query));
  }

  @Get(':kind/export.csv')
  async csv(@Req() request: TenantRequest, @Param('kind') kind: string, @Query() query: Record<string, string>, @Res() response: Response) {
    const report = await getReport(this.prisma, await this.actor(request, 'report:export'), this.kind(kind), this.filters(query));
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="rjpos-${kind}-report.csv"`);
    response.send(reportCsv(report));
  }

  @Get(':kind')
  async report(@Req() request: TenantRequest, @Param('kind') kind: string, @Query() query: Record<string, string>) {
    return getReport(this.prisma, await this.actor(request, 'report:read'), this.kind(kind), this.filters(query));
  }
}
