import type { ApiError } from '../shared/types.js';

export class ClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}
export function daemonUrl(
  value = process.env.AGENT_COLLABORATOR_URL ?? 'http://127.0.0.1:4310',
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientError(
      'INVALID_DAEMON_URL',
      'AGENT_COLLABORATOR_URL must be a loopback HTTP URL',
    );
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new ClientError(
      'INVALID_DAEMON_URL',
      'v0.1 only supports loopback HTTP URLs without credentials or a path',
    );
  return url.origin;
}
export class DaemonClient {
  readonly baseUrl: string;
  constructor(url?: string) {
    this.baseUrl = daemonUrl(url);
  }
  async request<T = unknown>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new ClientError(
        'DAEMON_UNAVAILABLE',
        `Cannot reach Agent-Collaborator at ${this.baseUrl}. Start the daemon with npm start.`,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ClientError(
        'INVALID_RESPONSE',
        'The daemon returned an invalid response',
        response.status,
      );
    }
    if (!response.ok) {
      const error = (data as Partial<ApiError>)?.error;
      throw new ClientError(
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? `HTTP ${response.status}`,
        response.status,
        error?.details,
      );
    }
    return data as T;
  }
  command(command: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request('/api/commands', { command, input });
  }
}
