import { Body, Controller, ForbiddenException, Get, Inject, Post, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PosError, recordAudit, verifyPin } from '@rjpos/database';
import { PRISMA } from './core-pos.js';
import { issueElevationToken, issueSessionToken, SESSION_TTL_MS, TOKEN_TTL_MS } from './elevation-token.js';
import { TenantContextService, type AuthenticatedTenantContext, type TenantRequest } from './tenant-context.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const APPROVER_ROLES = ['OWNER', 'MANAGER'] as const;

const attempts = new Map<string, { failures: number; lockedUntil: number }>();
const ROLE_ORDER = ['OWNER', 'MANAGER', 'CASHIER'] as const;
const highestRole = (names: string[]) => ROLE_ORDER.find((role) => names.some((name) => name.toUpperCase() === role));

/** Counts a failure against `key` and locks it after too many; returns true when the key is locked. */
function registerFailure(key: string): void {
  const state = attempts.get(key);
  const failures = (state && state.lockedUntil <= Date.now() ? state.failures : 0) + 1;
  attempts.set(key, { failures: failures >= MAX_FAILED_ATTEMPTS ? 0 : failures, lockedUntil: failures >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0 });
}
const isLocked = (key: string) => (attempts.get(key)?.lockedUntil ?? 0) > Date.now();

@Controller('/api/v1/auth')
export class ElevationController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient, @Inject(TenantContextService) private readonly tenants: TenantContextService) {}
  private context(request: TenantRequest) {
    const context = this.tenants.require(request.tenantContext);
    if (!context.permissions.has('sale:create') || !context.storeId || !context.registerId) throw new ForbiddenException();
    return context as AuthenticatedTenantContext & { storeId: string; registerId: string };
  }
  private async approvers(organizationId: string, storeId: string, employeeId?: string) {
    const employees = await this.prisma.employee.findMany({
      where: { ...(employeeId ? { id: employeeId } : {}), organizationId, status: 'ACTIVE', pinHash: { not: null }, stores: { some: { storeId } }, roles: { some: { role: { name: { in: ['Owner', 'Manager'] } } } } },
      include: { roles: { include: { role: true } } }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }], take: 50,
    });
    return employees.map((employee) => ({ id: employee.id, name: `${employee.firstName} ${employee.lastName}`, pinHash: employee.pinHash, role: APPROVER_ROLES.find((role) => employee.roles.some((assignment) => assignment.role.name.toUpperCase() === role)) ?? 'MANAGER' }));
  }

  /** PIN login: the PIN identifies an active employee of this store; the token carries their real role. */
  @Post('login')
  async login(@Req() request: TenantRequest, @Body() body: { pin?: string }) {
    const context = this.tenants.require(request.tenantContext);
    if (!context.storeId || !context.registerId) throw new ForbiddenException();
    const lockKey = `login:${context.registerId}`;
    if (isLocked(lockKey)) throw new PosError('LOGIN_LOCKED', 429);
    if (typeof body.pin !== 'string' || !/^\d{4,8}$/.test(body.pin)) throw new PosError('LOGIN_PIN_INVALID', 401);
    const employees = await this.prisma.employee.findMany({
      where: { organizationId: context.organizationId, status: 'ACTIVE', pinHash: { not: null }, stores: { some: { storeId: context.storeId } } },
      include: { roles: { include: { role: true } } }, take: 500,
    });
    const match = employees.find((employee) => verifyPin(body.pin!, employee.pinHash));
    const role = match ? highestRole(match.roles.map((assignment) => assignment.role.name)) : undefined;
    if (!match || !role) {
      registerFailure(lockKey);
      await recordAudit(this.prisma, { organizationId: context.organizationId, action: 'LOGIN_FAILED', entityType: 'Register', entityId: context.registerId, afterJson: { reason: match ? 'NO_ROLE' : 'BAD_PIN' } });
      throw new PosError('LOGIN_PIN_INVALID', 401);
    }
    attempts.delete(lockKey);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await recordAudit(this.prisma, { organizationId: context.organizationId, action: 'LOGIN_SUCCEEDED', entityType: 'Employee', entityId: match.id, afterJson: { registerId: context.registerId, role } });
    return { token: issueSessionToken({ org: context.organizationId, store: context.storeId, reg: context.registerId, sub: match.id, role, exp: expiresAt }), expiresAt: new Date(expiresAt).toISOString(), employee: { id: match.id, name: `${match.firstName} ${match.lastName}` }, role };
  }

  @Post('logout')
  async logout(@Req() request: TenantRequest) {
    const context = this.tenants.require(request.tenantContext);
    if (context.registerId) await recordAudit(this.prisma, { organizationId: context.organizationId, action: 'LOGOUT', entityType: 'Employee', entityId: context.userId, afterJson: { registerId: context.registerId } });
    return { ok: true };
  }

  @Get('approvers')
  async list(@Req() request: TenantRequest) {
    const context = this.context(request);
    return (await this.approvers(context.organizationId, context.storeId)).map(({ id, name, role }) => ({ id, name, role }));
  }

  @Post('elevate')
  async elevate(@Req() request: TenantRequest, @Body() body: { employeeId?: string; pin?: string }) {
    const context = this.context(request);
    if (typeof body.employeeId !== 'string' || typeof body.pin !== 'string' || !/^\d{4,8}$/.test(body.pin)) throw new PosError('ELEVATION_CREDENTIALS_INVALID');
    if (isLocked(body.employeeId)) throw new PosError('ELEVATION_LOCKED', 429);
    const [approver] = await this.approvers(context.organizationId, context.storeId, body.employeeId);
    if (!approver || !verifyPin(body.pin, approver.pinHash)) {
      registerFailure(body.employeeId);
      await recordAudit(this.prisma, { organizationId: context.organizationId, action: 'ELEVATION_FAILED', entityType: 'Register', entityId: context.registerId, afterJson: { cashierId: context.userId, approverId: body.employeeId } });
      throw new PosError('ELEVATION_CREDENTIALS_INVALID', 401);
    }
    attempts.delete(body.employeeId);
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    await recordAudit(this.prisma, { organizationId: context.organizationId, action: 'ELEVATION_GRANTED', entityType: 'Register', entityId: context.registerId, afterJson: { cashierId: context.userId, approverId: approver.id, role: approver.role } });
    return { token: issueElevationToken({ org: context.organizationId, reg: context.registerId, sub: approver.id, role: approver.role, exp: expiresAt }), expiresAt: new Date(expiresAt).toISOString(), approver: { id: approver.id, name: approver.name, role: approver.role } };
  }
}
