import type { PrismaClient } from '@prisma/client';
import { listAuditRecords, type AdminActor } from './back-office.js';

const SENSITIVE = /pin|hash|secret|token|password|cvv|pan|cardnumber/i;
export type AuditChange = { field: string; before: string | null; after: string | null };

const show = (value: unknown): string | null => (value === undefined || value === null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value));
function changesOf(before: unknown, after: unknown): AuditChange[] {
  const left = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
  const right = after && typeof after === 'object' && !Array.isArray(after) ? (after as Record<string, unknown>) : {};
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((field) => show(left[field]) !== show(right[field]))
    .map((field) => (SENSITIVE.test(field) ? { field, before: left[field] === undefined ? null : '[hidden]', after: right[field] === undefined ? null : '[hidden]' } : { field, before: show(left[field]), after: show(right[field]) }));
}

/** Audit records made readable for owners: who, what action, on which object, old/new values, when, and where (store/register). */
export async function listAuditView(prisma: PrismaClient, actor: AdminActor, input: Parameters<typeof listAuditRecords>[2]) {
  const page = await listAuditRecords(prisma, actor, input);
  const ids = (pick: (record: (typeof page.items)[number]) => string | null) => [...new Set(page.items.map(pick).filter((value): value is string => Boolean(value)))];
  const [employees, stores, registers] = await Promise.all([
    prisma.employee.findMany({ where: { organizationId: actor.organizationId, id: { in: ids((record) => record.userId) } }, select: { id: true, firstName: true, lastName: true } }),
    prisma.store.findMany({ where: { organizationId: actor.organizationId, id: { in: ids((record) => record.storeId) } }, select: { id: true, name: true } }),
    prisma.register.findMany({ where: { organizationId: actor.organizationId, id: { in: ids((record) => record.registerId) } }, select: { id: true, name: true } }),
  ]);
  const employeeName = new Map(employees.map((row) => [row.id, `${row.firstName} ${row.lastName}`.trim()])); const storeName = new Map(stores.map((row) => [row.id, row.name])); const registerName = new Map(registers.map((row) => [row.id, row.name]));
  return { ...page, items: page.items.map((record) => ({
    id: record.id, at: record.createdAt, action: record.action, actionLabel: record.action.toLowerCase().replace(/_/g, ' '), entityType: record.entityType, entityId: record.entityId,
    user: record.userId ? { id: record.userId, name: employeeName.get(record.userId) ?? 'Unknown user' } : null,
    store: record.storeId ? { id: record.storeId, name: storeName.get(record.storeId) ?? null } : null, register: record.registerId ? { id: record.registerId, name: registerName.get(record.registerId) ?? null } : null,
    changes: changesOf(record.beforeJson, record.afterJson),
  })) };
}
