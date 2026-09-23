import { z } from 'zod';

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

export type Environment = z.infer<typeof environmentSchema>;

export type EnvironmentInput = Record<string, string | undefined>;

export function loadEnvironment(input: EnvironmentInput): Environment {
  return environmentSchema.parse(input);
}
