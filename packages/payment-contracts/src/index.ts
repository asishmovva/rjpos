export const paymentAttemptStatuses = [
  'CREATED',
  'PROCESSING',
  'SUCCEEDED',
  'DECLINED',
  'CANCELLED',
  'UNKNOWN',
  'FAILED',
] as const;
export type PaymentAttemptStatus = (typeof paymentAttemptStatuses)[number];

export type TerminalPaymentCommand = {
  attemptId: string;
  amountMinor: string;
  currency: 'USD';
  idempotencyKey: string;
};

export type TerminalPaymentResult = {
  status: 'SUCCEEDED' | 'DECLINED' | 'CANCELLED' | 'UNKNOWN' | 'FAILED';
  providerTransactionId?: string;
  failureCode?: string;
};

export interface TerminalPaymentProvider {
  authorize(command: TerminalPaymentCommand): Promise<TerminalPaymentResult>;
  cancel(
    attemptId: string,
    idempotencyKey: string,
  ): Promise<TerminalPaymentResult>;
  getStatus(
    attemptId: string,
    providerTransactionId?: string,
  ): Promise<TerminalPaymentResult>;
  refund(
    providerTransactionId: string,
    amountMinor: string,
    idempotencyKey: string,
  ): Promise<TerminalPaymentResult>;
}

export type TerminalProviderConfiguration = { endpoint: string; token: string; timeoutMilliseconds?: number };
export class HttpTerminalProvider implements TerminalPaymentProvider {
  private readonly endpoint: string;
  constructor(private readonly configuration: TerminalProviderConfiguration, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(configuration.endpoint);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('TERMINAL_ENDPOINT_HTTPS_REQUIRED');
    if (!configuration.token) throw new Error('TERMINAL_CREDENTIAL_REQUIRED');
    this.endpoint = url.href.replace(/\/$/, '');
  }
  private async command(path: string, body: Record<string, string | undefined>): Promise<TerminalPaymentResult> {
    try {
      const response = await this.fetcher(`${this.endpoint}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.configuration.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.configuration.timeoutMilliseconds ?? 30_000) });
      if (!response.ok) return { status: response.status >= 500 ? 'UNKNOWN' : 'FAILED', failureCode: `PROVIDER_HTTP_${response.status}` };
      const value = await response.json() as TerminalPaymentResult;
      if (!['SUCCEEDED', 'DECLINED', 'CANCELLED', 'UNKNOWN', 'FAILED'].includes(value.status)) return { status: 'UNKNOWN', failureCode: 'PROVIDER_RESPONSE_INVALID' };
      return value;
    } catch { return { status: 'UNKNOWN', failureCode: 'PROVIDER_UNREACHABLE' }; }
  }
  authorize(command: TerminalPaymentCommand) { return this.command('/authorize', command); }
  cancel(attemptId: string, idempotencyKey: string) { return this.command('/cancel', { attemptId, idempotencyKey }); }
  getStatus(attemptId: string, providerTransactionId?: string) { return this.command('/status', { attemptId, providerTransactionId }); }
  refund(providerTransactionId: string, amountMinor: string, idempotencyKey: string) { return this.command('/refund', { providerTransactionId, amountMinor, idempotencyKey }); }
}

export class UnavailableTerminalProvider implements TerminalPaymentProvider {
  private unavailable(): TerminalPaymentResult { return { status: 'FAILED', failureCode: 'TERMINAL_PROVIDER_NOT_CONFIGURED' }; }
  async authorize() { return this.unavailable(); }
  async cancel() { return this.unavailable(); }
  async getStatus() { return this.unavailable(); }
  async refund() { return this.unavailable(); }
}

export const simulatedTerminalOutcomes = [
  'APPROVED',
  'DECLINED',
  'CANCELLED',
  'TIMEOUT',
  'UNKNOWN',
  'NETWORK_LOST',
  'DUPLICATE_CALLBACK',
  'LATE_CALLBACK',
] as const;
export type SimulatedTerminalOutcome =
  (typeof simulatedTerminalOutcomes)[number];

export class SimulatedTerminalProvider implements TerminalPaymentProvider {
  readonly callbackResults: TerminalPaymentResult[] = [];
  authorizeCallCount = 0;
  private readonly results = new Map<string, TerminalPaymentResult>();

  constructor(private outcome: SimulatedTerminalOutcome = 'APPROVED') {}

  setOutcome(outcome: SimulatedTerminalOutcome): void {
    this.outcome = outcome;
  }

  async authorize(
    command: TerminalPaymentCommand,
  ): Promise<TerminalPaymentResult> {
    const existing = this.results.get(command.idempotencyKey);
    if (existing) return existing;
    this.authorizeCallCount += 1;
    const result = this.resultFor(command.attemptId, this.outcome);
    this.results.set(command.idempotencyKey, result);
    if (this.outcome === 'DUPLICATE_CALLBACK') {
      this.callbackResults.push(result, result);
    } else if (this.outcome !== 'LATE_CALLBACK') {
      this.callbackResults.push(result);
    }
    return result;
  }

  async cancel(
    attemptId: string,
    _idempotencyKey: string,
  ): Promise<TerminalPaymentResult> {
    return { status: 'CANCELLED', providerTransactionId: `sim-${attemptId}` };
  }

  async getStatus(
    attemptId: string,
    providerTransactionId?: string,
  ): Promise<TerminalPaymentResult> {
    return (
      this.callbackResults.at(-1) ?? {
        status: 'UNKNOWN',
        providerTransactionId: providerTransactionId ?? `sim-${attemptId}`,
        failureCode: 'PENDING_RECONCILIATION',
      }
    );
  }

  async refund(
    providerTransactionId: string,
    _amountMinor: string,
    idempotencyKey: string,
  ): Promise<TerminalPaymentResult> {
    const existing = this.results.get(`refund:${idempotencyKey}`);
    if (existing) return existing;
    const result = this.resultFor(providerTransactionId, this.outcome);
    this.results.set(`refund:${idempotencyKey}`, result);
    return result;
  }

  deliverLateCallback(attemptId: string): TerminalPaymentResult {
    const result: TerminalPaymentResult = {
      status: 'SUCCEEDED',
      providerTransactionId: `sim-${attemptId}`,
    };
    this.callbackResults.push(result);
    return result;
  }

  private resultFor(
    attemptId: string,
    outcome: SimulatedTerminalOutcome,
  ): TerminalPaymentResult {
    switch (outcome) {
      case 'APPROVED':
      case 'DUPLICATE_CALLBACK':
        return {
          status: 'SUCCEEDED',
          providerTransactionId: `sim-${attemptId}`,
        };
      case 'DECLINED':
        return { status: 'DECLINED', failureCode: 'SIMULATED_DECLINE' };
      case 'CANCELLED':
        return { status: 'CANCELLED', failureCode: 'SIMULATED_CANCEL' };
      case 'TIMEOUT':
      case 'UNKNOWN':
      case 'NETWORK_LOST':
      case 'LATE_CALLBACK':
        return { status: 'UNKNOWN', failureCode: outcome };
    }
  }
}
