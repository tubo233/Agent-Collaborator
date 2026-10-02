import type { ApiError, Snapshot } from '../src/shared/types.js';

export const HUMAN = { name: '本机用户', kind: 'human' as const };
export class RequestError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data as ApiError | null;
    throw new RequestError(
      error?.error?.message || `请求失败 (${response.status})`,
      error?.error?.code || 'HTTP_ERROR',
      response.status,
    );
  }
  return data as T;
}
export async function fetchSnapshot(): Promise<Snapshot> {
  return readResponse<Snapshot>(
    await fetch('/api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(15000) }),
  );
}
export async function sendCommand<T>(command: string, input: Record<string, unknown>): Promise<T> {
  return readResponse<T>(
    await fetch('/api/commands', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, input }),
    }),
  );
}
export interface Ownership {
  attemptId: string;
  token: string;
}
const KEY = 'agent-collaborator.ownership.v1';
export function readOwnership(): Record<string, Ownership> {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(KEY) || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(
      Object.entries(data).filter(
        ([, v]) =>
          v &&
          typeof v === 'object' &&
          typeof v.attemptId === 'string' &&
          typeof v.token === 'string',
      ),
    );
  } catch {
    return {};
  }
}
export function saveOwnership(value: Record<string, Ownership>) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* Ownership remains in memory when storage is unavailable. */
  }
}
export function safeUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
