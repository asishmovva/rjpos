export type ConfigProblem = { variable: string; problem: string };

/**
 * Refuses to start a production API that would be unsafe: no header identity, weak or missing secrets, unset tenant binding.
 * Returns the problems so they can be reported together and tested.
 */
export function productionConfigProblems(env: Record<string, string | undefined>): ConfigProblem[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: ConfigProblem[] = [];
  const need = (variable: string, problem: string) => { if (!env[variable]?.trim()) problems.push({ variable, problem }); };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  need('RJPOS_ELEVATION_SECRET', 'is required to sign PIN sessions and manager approvals');
  if (env.RJPOS_ELEVATION_SECRET && env.RJPOS_ELEVATION_SECRET.length < 32) problems.push({ variable: 'RJPOS_ELEVATION_SECRET', problem: 'must be at least 32 characters' });
  for (const variable of ['RJPOS_ORGANIZATION_ID', 'RJPOS_STORE_ID']) {
    need(variable, 'is required: production binds this server to one organization and store');
    if (env[variable] && !uuid.test(env[variable]!)) problems.push({ variable, problem: 'must be a UUID' });
  }
  if (env.RJPOS_REGISTER_ID && !uuid.test(env.RJPOS_REGISTER_ID)) problems.push({ variable: 'RJPOS_REGISTER_ID', problem: 'must be a UUID' });
  if ((env.RJPOS_ALLOWED_ORIGINS ?? '').split(',').some((origin) => origin.trim() === '*')) problems.push({ variable: 'RJPOS_ALLOWED_ORIGINS', problem: 'must list exact origins, not *' });
  if (env.RJPOS_TERMINAL_PROVIDER === 'simulated') problems.push({ variable: 'RJPOS_TERMINAL_PROVIDER', problem: 'simulated payments are not allowed in production' });
  if (env.RJPOS_TERMINAL_PROVIDER === 'http' && (!env.RJPOS_TERMINAL_ENDPOINT || !env.RJPOS_TERMINAL_TOKEN)) problems.push({ variable: 'RJPOS_TERMINAL_ENDPOINT', problem: 'and RJPOS_TERMINAL_TOKEN are required for the http terminal provider' });
  if (env.RJPOS_INVOICE_OCR_PROVIDER === 'fixture') problems.push({ variable: 'RJPOS_INVOICE_OCR_PROVIDER', problem: 'the fixture OCR provider is for development only' });
  return problems;
}

export function assertProductionConfig(env: Record<string, string | undefined> = process.env): void {
  const problems = productionConfigProblems(env);
  if (problems.length) throw new Error(`Unsafe production configuration:\n${problems.map((item) => `  - ${item.variable}: ${item.problem}`).join('\n')}`);
}
