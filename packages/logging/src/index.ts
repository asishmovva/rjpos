export type LogContext = {
  requestId?: string;
  organizationId?: string;
  storeId?: string;
  registerId?: string;
  userId?: string;
  errorName?: string;
  errorMessage?: string;
};

export function sanitizeLogText(value: string): string {
  return value
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
      '$1[REDACTED]@',
    )
    .replace(
      /\b(password|access[_-]?token|token|secret|api[_-]?key|authorization|cookie)(\s*[:=]\s*)([^\s,;]+)/gi,
      '$1$2[REDACTED]',
    );
}

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeLogText(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    result[key] = /password|token|secret|card|cvv|authorization|cookie|apikey/.test(
      normalizedKey,
    )
      ? '[REDACTED]'
      : redact(entry);
  }
  return result;
}

export function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  context: LogContext = {},
): void {
  const safeContext = redact(context) as LogContext;
  console.log(
    JSON.stringify({
      level,
      message: sanitizeLogText(message),
      ...safeContext,
      timestamp: new Date().toISOString(),
    }),
  );
}
