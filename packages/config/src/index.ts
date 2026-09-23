import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'dotenv';

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AUTH_PROVIDER: z
    .enum(['development', 'auth0', 'cognito'])
    .default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal('')),
  SENTRY_DSN: z.string().url().optional().or(z.literal('')),
});

const databaseUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const testEnvironmentSchema = z.object({
  TEST_DATABASE_URL: z.string().url(),
  TEST_REDIS_URL: z.string().url(),
  TEST_ORGANIZATION_ID: databaseUuid,
  TEST_STORE_ID: databaseUuid,
  TEST_VARIANT_ID: databaseUuid,
  TEST_ORDER_ID_ONE: databaseUuid,
  TEST_ORDER_ID_TWO: databaseUuid,
});

export type Environment = z.infer<typeof environmentSchema>;
export type TestEnvironment = z.infer<typeof testEnvironmentSchema>;
export type DatabaseIdentity = {
  host: string;
  port: number;
  database: string;
};

export type EnvironmentInput = Record<string, string | undefined>;

function normalizeHost(hostname: string): string {
  const host = decodeURIComponent(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host === 'ip6-localhost' ||
    host === 'ip6-loopback' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.[0-9]{1,3}){0,3}$/.test(host)
  ) {
    return 'loopback';
  }
  return host;
}

export function normalizeDatabaseIdentity(value: string): DatabaseIdentity {
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('TEST_DATABASE_URL must use PostgreSQL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!database || database.includes('/')) {
    throw new Error('Database URL must contain exactly one database name');
  }
  return {
    host: normalizeHost(url.hostname),
    port: url.port ? Number(url.port) : 5432,
    database,
  };
}

function databaseIdentitiesMatch(
  left: DatabaseIdentity,
  right: DatabaseIdentity,
): boolean {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database
  );
}

export function assertTestDatabaseIsolation(
  testDatabaseUrl: string,
  developmentDatabaseUrl?: string,
): DatabaseIdentity {
  const testIdentity = normalizeDatabaseIdentity(testDatabaseUrl);
  if (!/(?:^test(?:_|-)|(?:_|-)test$)/i.test(testIdentity.database)) {
    throw new Error(
      'TEST_DATABASE_URL must name an explicitly test-designated database such as rjpos_test',
    );
  }
  if (
    developmentDatabaseUrl &&
    databaseIdentitiesMatch(
      testIdentity,
      normalizeDatabaseIdentity(developmentDatabaseUrl),
    )
  ) {
    throw new Error(
      'TEST_DATABASE_URL resolves to the same host, port, and database as DATABASE_URL',
    );
  }
  return testIdentity;
}

export function findWorkspaceRoot(startDirectory = process.cwd()): string {
  let directory = resolve(startDirectory);
  while (true) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error('RJ POS workspace root not found');
    directory = parent;
  }
}

export function loadEnvironment(input?: EnvironmentInput): Environment {
  if (input) return environmentSchema.parse(input);

  const rootEnvPath = join(findWorkspaceRoot(), '.env');
  const fileValues = existsSync(rootEnvPath)
    ? parse(readFileSync(rootEnvPath, 'utf8'))
    : {};
  return environmentSchema.parse({ ...fileValues, ...process.env });
}

export function loadTestEnvironment(input?: EnvironmentInput): TestEnvironment {
  if (input) {
    const values = testEnvironmentSchema.parse(input);
    assertTestDatabaseIsolation(values.TEST_DATABASE_URL);
    return values;
  }

  const workspaceRoot = findWorkspaceRoot();
  const testEnvPath = join(workspaceRoot, '.env.test');
  if (!existsSync(testEnvPath)) {
    throw new Error(
      'RJ POS test configuration not found. Copy .env.test.example to .env.test.',
    );
  }

  const testValues = parse(readFileSync(testEnvPath, 'utf8'));
  const values = testEnvironmentSchema.parse({
    ...testValues,
    ...process.env,
  });
  const developmentEnvPath = join(workspaceRoot, '.env');
  let developmentDatabaseUrl = process.env.DATABASE_URL;
  if (existsSync(developmentEnvPath)) {
    const developmentValues = parse(readFileSync(developmentEnvPath, 'utf8'));
    developmentDatabaseUrl ??= developmentValues.DATABASE_URL;
    if (values.TEST_REDIS_URL === developmentValues.REDIS_URL) {
      throw new Error('TEST_REDIS_URL must not equal REDIS_URL');
    }
  }
  assertTestDatabaseIsolation(values.TEST_DATABASE_URL, developmentDatabaseUrl);
  return values;
}
