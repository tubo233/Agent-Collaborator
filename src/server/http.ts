import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store, DomainError } from '../core/store.js';

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
export interface ServerOptions {
  port?: number;
  dev?: boolean;
  webDir?: string;
  host?: '127.0.0.1';
}

function localAuthority(authority: string, port: number): boolean {
  try {
    const url = new URL(`http://${authority}`);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      Number(url.port || 80) === port &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      url.host === authority
    );
  } catch {
    return false;
  }
}

async function jsonBody(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) throw new DomainError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be valid JSON', 400);
  }
}

export function createApp(store: Store, options: ServerOptions = {}) {
  const clients = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    try {
      const address = server.address() as AddressInfo | null;
      const port = address?.port ?? options.port ?? 4310;
      if (!req.headers.host || !localAuthority(req.headers.host, port))
        throw new DomainError('INVALID_HOST', 'Only this loopback host and port are allowed', 403);
      const origin = req.headers.origin;
      if (origin) {
        let allowed = false;
        try {
          const url = new URL(origin);
          allowed =
            url.origin === origin &&
            url.protocol === 'http:' &&
            (localAuthority(url.host, port) ||
              (options.dev === true && localAuthority(url.host, 5173)));
        } catch {
          /* reject invalid origins */
        }
        if (!allowed)
          throw new DomainError('INVALID_ORIGIN', 'Cross-origin requests are not allowed', 403);
      }
      if (req.headers['sec-fetch-site'] === 'cross-site')
        throw new DomainError('CROSS_SITE_REQUEST', 'Cross-site requests are not allowed', 403);
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/api/health')
          return reply(200, {
            ok: true,
            version: '0.1.0',
            mode: 'local',
            serverTime: new Date().toISOString(),
          });
        if (req.method === 'GET' && url.pathname === '/api/snapshot')
          return reply(200, store.snapshot());
        if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
          const id = decodeURIComponent(url.pathname.slice('/api/tasks/'.length));
          const snapshot = store.snapshot();
          const task = snapshot.tasks.find((t) => t.id === id);
          if (!task) throw new DomainError('NOT_FOUND', 'Task not found', 404);
          return reply(200, {
            task,
            attempts: snapshot.attempts.filter((a) => a.taskId === id),
            handoffs: snapshot.handoffs.filter((h) => h.taskId === id),
            comments: snapshot.comments.filter((c) => c.taskId === id),
            sessions: snapshot.sessions.filter((s) => s.taskId === id),
            events: snapshot.events.filter((e) => e.taskId === id),
            serverTime: snapshot.serverTime,
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/export') {
          const backup = JSON.stringify(store.exportData());
          if (Buffer.byteLength(backup, 'utf8') > MAX_BACKUP_BYTES)
            throw new DomainError(
              'BACKUP_TOO_LARGE',
              'Portable JSON backup exceeds 64 MiB. Stop the daemon and copy its complete data directory instead; see docs/operations.md.',
              413,
            );
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="agent-collaborator-backup.json"',
            'Cache-Control': 'no-store',
          });
          res.end(backup);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/commands') {
          const body = await jsonBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new DomainError('VALIDATION_ERROR', 'Expected a command object', 400);
          const { command, input } = body as Record<string, unknown>;
          if (
            typeof command !== 'string' ||
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input)
          )
            throw new DomainError(
              'VALIDATION_ERROR',
              'Expected command string and input object',
              400,
            );
          const result = store.execute(command, input as Record<string, unknown>);
          for (const client of clients)
            client.write(
              `event: change\ndata: ${JSON.stringify({ command, at: new Date().toISOString() })}\n\n`,
            );
          return reply(200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/restore') {
          const data = await jsonBody(req, MAX_BACKUP_BYTES);
          const result = store.restoreData(data);
          for (const client of clients)
            client.write('event: change\ndata: {"command":"backup.restore"}\n\n');
          return reply(200, result ?? { ok: true });
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          res.write('event: hello\ndata: {"connected":true}\n\n');
          clients.add(res);
          const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
          res.on('close', () => {
            clearInterval(keepalive);
            clients.delete(res);
          });
          return;
        }
        return reply(req.method === 'GET' ? 404 : 405, {
          error: { code: 'NOT_FOUND', message: 'API route not found or method not allowed' },
        });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return reply(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
      if (!options.webDir)
        return reply(404, {
          error: {
            code: 'UI_NOT_BUILT',
            message: 'Run npm run build, or use the Vite development server',
          },
        });
      const root = resolve(options.webDir);
      let requested: string;
      try {
        requested = decodeURIComponent(url.pathname);
      } catch {
        throw new DomainError('INVALID_PATH', 'Invalid URL path', 400);
      }
      let file = resolve(root, `.${requested}`);
      if (!file.startsWith(`${root}${sep}`) && file !== root)
        throw new DomainError('INVALID_PATH', 'Invalid URL path', 400);
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
      } catch {
        if (extname(requested))
          return reply(404, { error: { code: 'NOT_FOUND', message: 'File not found' } });
        file = resolve(root, 'index.html');
      }
      let content: Buffer;
      try {
        content = await readFile(file);
      } catch {
        return reply(404, {
          error: { code: 'UI_NOT_BUILT', message: 'Run npm run build to build the browser UI' },
        });
      }
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof DomainError)
        reply(error.status, {
          error: { code: error.code, message: error.message, details: error.details },
        });
      else if (error instanceof URIError)
        reply(400, { error: { code: 'INVALID_PATH', message: 'Invalid URL encoding' } });
      else {
        console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
        reply(500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
      }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    closeClients: () => {
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}
