import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/core/store.js';
import { createApp } from '../src/server/http.js';
import { DaemonClient, daemonUrl } from '../src/adapters/client.js';
import type { Project, Task, ClaimResult } from '../src/shared/types.js';

const exec = promisify(execFile);
test('adapter URL only permits a loopback daemon', () => {
  assert.equal(daemonUrl('http://localhost:4310'), 'http://localhost:4310');
  for (const url of [
    'https://example.org',
    'http://192.168.1.2:4310',
    'http://127.0.0.1:4310/path',
    'http://user:secret@127.0.0.1:4310',
    'http://127.0.0.1:4310?x=1',
  ])
    assert.throws(() => daemonUrl(url));
});

test('two real MCP stdio adapters share the daemon; CLI reads same state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-mcp-'));
  const store = new Store(join(dir, 'board.sqlite'));
  const app = createApp(store);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  try {
    for (const name of ['agent-a', 'agent-b']) {
      const client = new Client({ name, version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', resolve('src/adapters/mcp.ts')],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          AGENT_COLLABORATOR_URL: url,
        },
        stderr: 'pipe',
      });
      clients.push(client);
      transports.push(transport);
      await client.connect(transport);
    }
    const toolList = await clients[0].listTools();
    assert(toolList.tools.some((t) => t.name === 'ac_claim_task'));
    assert(!toolList.tools.some((t) => /accept|reclaim/.test(t.name)));
    async function call<T>(client: Client, name: string, input: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: input });
      const content = result.content as { type: string; text: string }[];
      return { isError: result.isError, value: JSON.parse(content[0].text) as T };
    }
    const p = (
      await call<Project>(clients[0], 'ac_create_project', { name: 'Cross-adapter project' })
    ).value;
    const t = (
      await call<Task>(clients[0], 'ac_create_task', { projectId: p.id, title: 'Shared task' })
    ).value;
    const claims = await Promise.all(
      clients.map((client, i) =>
        call<ClaimResult>(client, 'ac_claim_task', {
          taskId: t.id,
          expectedVersion: t.version,
          agent: { name: `agent-${i}`, kind: 'agent' },
        }),
      ),
    );
    assert.equal(claims.filter((c) => !c.isError).length, 1);
    assert.equal(claims.filter((c) => c.isError).length, 1);
    const env = { ...process.env, AGENT_COLLABORATOR_URL: url };
    const cli = await exec(
      process.execPath,
      ['--import', 'tsx', resolve('src/adapters/cli.ts'), 'tasks', p.id],
      { env },
    );
    const tasks = JSON.parse(cli.stdout) as Task[];
    assert.equal(tasks[0].status, 'running');
    const backupFile = join(dir, '备份 with spaces.json');
    await exec(
      process.execPath,
      ['--import', 'tsx', resolve('src/adapters/cli.ts'), 'export', backupFile],
      { env },
    );
    await assert.rejects(
      exec(
        process.execPath,
        ['--import', 'tsx', resolve('src/adapters/cli.ts'), 'export', backupFile],
        { env },
      ),
    );
    const reader = new DaemonClient(url);
    assert.equal((await reader.request<{ ok: boolean }>('/api/health')).ok, true);
  } finally {
    for (const client of clients) await client.close();
    for (const transport of transports) await transport.close();
    app.closeClients();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
