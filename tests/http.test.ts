import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/core/store.js';
import { createApp } from '../src/server/http.js';
import type { Task, Project, ClaimResult } from '../src/shared/types.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ac-http-'));
  const store = new Store(join(dir, 'board.sqlite'));
  const app = createApp(store, { webDir: dir });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    store,
    dir,
    port,
    url,
    command: async <T>(command: string, input: object) => {
      const res = await fetch(`${url}/api/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, input }),
      });
      return { response: res, data: (await res.json()) as T };
    },
    close: async () => {
      app.closeClients();
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('HTTP supports shared atomic claims, handoff review, audit and export without tokens', async () => {
  const f = await fixture();
  try {
    const p = (await f.command<Project>('project.create', { name: '共享项目' })).data;
    const task = (
      await f.command<Task>('task.create', {
        projectId: p.id,
        title: 'Test shared claim',
        acceptanceCriteria: 'Tests pass',
      })
    ).data;
    const race = await Promise.all(
      ['Claude', 'Codex'].map((name) =>
        f.command<ClaimResult>('task.claim', {
          taskId: task.id,
          expectedVersion: task.version,
          agent: { name, kind: 'agent' },
        }),
      ),
    );
    assert.equal(race.filter((r) => r.response.ok).length, 1);
    assert.equal(race.filter((r) => r.response.status === 409).length, 1);
    const claim = race.find((r) => r.response.ok)!.data;
    const snapshot = await (await fetch(`${f.url}/api/snapshot`)).text();
    assert(!snapshot.includes(claim.token));
    const result = await f.command<{ task: Task }>('task.submit', {
      taskId: task.id,
      expectedVersion: claim.task.version,
      attemptId: claim.attempt.id,
      token: claim.token,
      summary: 'Passed checks',
      evidence: [{ label: 'Tests', uri: 'npm test', kind: 'test' }],
    });
    assert.equal(result.data.task.status, 'review');
    const done = await f.command<Task>('task.accept', {
      taskId: task.id,
      expectedVersion: result.data.task.version,
      actor: { name: 'Reviewer', kind: 'human' },
    });
    assert.equal(done.data.status, 'done');
    const backup = await (await fetch(`${f.url}/api/export`)).text();
    assert(!backup.includes(claim.token));
    assert(backup.includes('schemaVersion'));
    const restore = await fetch(`${f.url}/api/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: backup,
    });
    assert.equal(restore.status, 409);
  } finally {
    await f.close();
  }
});

test('HTTP rejects hostile Host, Origin, cross-site fetch and non-JSON mutations', async () => {
  const f = await fixture();
  try {
    for (const origin of [
      'https://attacker.example',
      'null',
      'http://127.0.0.1:9999',
      'http://localhost.evil:4310',
    ]) {
      const res = await fetch(`${f.url}/api/snapshot`, { headers: { Origin: origin } });
      assert.equal(res.status, 403, origin);
    }
    const same = await fetch(`${f.url}/api/health`, { headers: { Origin: f.url } });
    assert.equal(same.status, 200);
    const cross = await fetch(`${f.url}/api/health`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(cross.status, 403);
    const rebinding = await new Promise<number>((resolve) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: f.port,
          path: '/api/health',
          headers: { Host: `evil.example:${f.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end();
    });
    assert.equal(rebinding, 403);
    const plain = await fetch(`${f.url}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(plain.status, 415);
    const oversized = await fetch(`${f.url}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'project.create', input: { name: 'x'.repeat(1100000) } }),
    });
    assert.equal(oversized.status, 413);
    const malformed = await fetch(`${f.url}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    const options = await fetch(`${f.url}/api/commands`, { method: 'OPTIONS' });
    assert.equal(options.headers.get('access-control-allow-origin'), null);
  } finally {
    await f.close();
  }
});

test('SSE signals mutations and reconnect gives hello; static files have security headers', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    await writeFile(join(f.dir, 'index.html'), '<!doctype html><title>Board</title>');
    const page = await fetch(f.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const response = await fetch(`${f.url}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: hello/);
    await f.command('project.create', { name: 'SSE project' });
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /event: change/);
    controller.abort();
    const second = await fetch(`${f.url}/api/events`);
    const reader2 = second.body!.getReader();
    assert.match(new TextDecoder().decode((await reader2.read()).value), /event: hello/);
    await reader2.cancel();
  } finally {
    controller.abort();
    await f.close();
  }
});

test('portable backup over 20 MiB restores intact through HTTP', async () => {
  const source = await fixture();
  const target = await fixture();
  try {
    const p = source.store.execute('project.create', { name: 'Large export' }) as Project;
    for (let i = 0; i < 425; i++)
      source.store.execute('task.create', {
        projectId: p.id,
        title: `Task ${i}`,
        description: 'x'.repeat(50000),
      });
    const exported = await fetch(`${source.url}/api/export`);
    assert.equal(exported.status, 200);
    const backup = await exported.text();
    assert(Buffer.byteLength(backup) > 20 * 1024 * 1024);
    const restored = await fetch(`${target.url}/api/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: backup,
    });
    assert.equal(restored.status, 200, await restored.text());
    assert.equal(target.store.snapshot().tasks.length, 425);
  } finally {
    await source.close();
    await target.close();
  }
});
