import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'dotenv';

export const DEFAULT_RENDERER_URL = 'http://localhost:3000';
export const DEFAULT_RENDERER_STARTUP_ATTEMPTS = 120;
export const DEFAULT_RENDERER_RETRY_INTERVAL_MILLISECONDS = 500;
export const DEFAULT_RENDERER_REQUEST_TIMEOUT_MILLISECONDS = 2_000;

export type RegisterEnvironment = Record<string, string | undefined>;
export type RendererTarget =
  { type: 'url'; value: string } | { type: 'file'; value: string };

export function loadRegisterEnvironment(
  startDirectory = process.cwd(),
  processEnvironment: RegisterEnvironment = process.env,
): RegisterEnvironment {
  let directory = resolve(startDirectory);
  while (true) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      const envPath = join(directory, '.env');
      const fileValues = existsSync(envPath)
        ? parse(readFileSync(envPath, 'utf8'))
        : {};
      return { ...fileValues, ...processEnvironment };
    }
    const parent = dirname(directory);
    if (parent === directory) return { ...processEnvironment };
    directory = parent;
  }
}

export function resolveDevelopmentRendererUrl(
  environment: RegisterEnvironment,
): string {
  const value = environment.RJPOS_RENDERER_URL || DEFAULT_RENDERER_URL;
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'RJPOS_RENDERER_URL must be an HTTP(S) URL without embedded credentials',
    );
  }
  return url.href;
}

export function resolveRendererTarget(
  isPackaged: boolean,
  rendererFile: string,
  environment: RegisterEnvironment,
): RendererTarget {
  return isPackaged
    ? { type: 'file', value: rendererFile }
    : { type: 'url', value: resolveDevelopmentRendererUrl(environment) };
}

export async function waitForRenderer(
  rendererUrl: string,
  options: {
    attempts?: number;
    intervalMilliseconds?: number;
    requestTimeoutMilliseconds?: number;
    fetcher?: typeof fetch;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_RENDERER_STARTUP_ATTEMPTS;
  const intervalMilliseconds =
    options.intervalMilliseconds ??
    DEFAULT_RENDERER_RETRY_INTERVAL_MILLISECONDS;
  const requestTimeoutMilliseconds =
    options.requestTimeoutMilliseconds ??
    DEFAULT_RENDERER_REQUEST_TIMEOUT_MILLISECONDS;
  const fetcher = options.fetcher ?? fetch;
  let lastFailure = 'no response';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(rendererUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    if (attempt < attempts) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, intervalMilliseconds),
      );
    }
  }

  throw new Error(
    `Renderer unavailable at ${rendererUrl} after ${attempts} attempts: ${lastFailure}`,
  );
}
