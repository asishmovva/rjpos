import { PosError } from '@rjpos/database';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rolePermissions, type AuthenticatedTenantContext } from './tenant-context.js';

export const TOKEN_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;

if (process.env.NODE_ENV === 'production' && !process.env.RJPOS_ELEVATION_SECRET) throw new Error('RJPOS_ELEVATION_SECRET is required in production');
// Without a configured secret, tokens are valid only for this process lifetime (development).
const secret = process.env.RJPOS_ELEVATION_SECRET ?? randomBytes(32).toString('hex');

type TokenPayload = { typ: 'elev' | 'sess'; org: string; reg: string; sub: string; role: string; exp: number; store?: string; sv?: number };
type Claims = Omit<TokenPayload, 'typ'>;

const sign = (body: string) => createHmac('sha256', secret).update(body).digest('base64url');
const encode = (payload: TokenPayload) => { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${body}.${sign(body)}`; };

function decode(token: string, typ: TokenPayload['typ'], invalid: string, expired: string): TokenPayload {
  const [body, signature] = token.split('.');
  const expected = body ? sign(body) : '';
  if (!body || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new PosError(invalid, 401);
  let payload: TokenPayload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload; } catch { throw new PosError(invalid, 401); }
  if (payload.typ !== typ) throw new PosError(invalid, 401);
  if (payload.exp < Date.now()) throw new PosError(expired, 401);
  return payload;
}

export const issueElevationToken = (claims: Claims): string => encode({ ...claims, typ: 'elev' });
export const issueSessionToken = (claims: Claims): string => encode({ ...claims, typ: 'sess' });

/** Returns the context with the approver's permissions if the token is authentic, unexpired, and bound to this register. */
export function applyElevation(context: AuthenticatedTenantContext, token: string): AuthenticatedTenantContext {
  const payload = decode(token, 'elev', 'ELEVATION_INVALID', 'ELEVATION_EXPIRED');
  if (payload.org !== context.organizationId || payload.reg !== context.registerId) throw new PosError('ELEVATION_INVALID', 401);
  return { ...context, permissions: new Set(rolePermissions[payload.role] ?? []), approvedByEmployeeId: payload.sub };
}

/** Builds the request identity from a PIN-login session token: the real employee and their role's permissions. */
export const decodeSession = (token: string): TokenPayload => decode(token, 'sess', 'SESSION_INVALID', 'SESSION_EXPIRED');
export function contextFromSession(token: string): AuthenticatedTenantContext {
  const payload = decodeSession(token);
  return { organizationId: payload.org, userId: payload.sub, ...(payload.store ? { storeId: payload.store } : {}), registerId: payload.reg, permissions: new Set(rolePermissions[payload.role] ?? []) };
}
