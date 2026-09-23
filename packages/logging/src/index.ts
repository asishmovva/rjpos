export type LogContext = {
  requestId?: string;
  organizationId?: string;
  storeId?: string;
  registerId?: string;
  userId?: string;
};

export function redact(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    result[key] =
      key.toLowerCase().includes('password') ||
      key.toLowerCase().includes('token') ||
      key.toLowerCase().includes('secret') ||
      key.toLowerCase().includes('card') ||
      key.toLowerCase().includes('cvv')
        ? '[REDACTED]'
        : entry;
  return result;
}

export function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  context: LogContext = {},
): void {
  console.log(
    JSON.stringify({
      level,
      message,
      ...context,
      timestamp: new Date().toISOString(),
    }),
  );
}
