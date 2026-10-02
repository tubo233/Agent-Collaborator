import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { DaemonClient } from '../src/adapters/client.js';
import type { Project, Snapshot } from '../src/shared/types.js';

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function start(dir: string, port: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/server/main.ts')], {
    env: {
      ...process.env,
      AGENT_COLLABORATOR_DATA_DIR: dir,
      AGENT_COLLABORATOR_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    output += String(chunk);
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk) => {
      if (String(chunk).includes('Agent-Collaborator v0.1.0')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Daemon exited ${code}: ${output}`)));
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  return { child, ready, exited, output: () => output };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill(signal);
  await exited;
}

test(
  'actual daemon excludes duplicate owners and survives crash/restart with persisted data',
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac daemon 数据 '));
    const port = await freePort();
    const children: ChildProcess[] = [];
    try {
      const first = start(dir, port);
      children.push(first.child);
      await first.ready;
      const client = new DaemonClient(`http://127.0.0.1:${port}`);
      const project = (await client.command('project.create', {
        name: 'Restart survives',
      })) as Project;
      await client.command('task.create', { projectId: project.id, title: 'Persisted task' });
      const duplicate = start(dir, await freePort());
      children.push(duplicate.child);
      await assert.rejects(duplicate.ready, /Another daemon/);
      assert.equal(await duplicate.exited, 1);
      await stop(first.child, 'SIGKILL');
      const restarted = start(dir, port);
      children.push(restarted.child);
      await restarted.ready;
      const snapshot = await client.request<Snapshot>('/api/snapshot');
      assert.equal(snapshot.tasks[0].title, 'Persisted task');
      await stop(restarted.child);
      const cleanRestart = start(dir, port);
      children.push(cleanRestart.child);
      await cleanRestart.ready;
      assert.equal((await client.request<Snapshot>('/api/snapshot')).projects[0].id, project.id);
      await stop(cleanRestart.child);
    } finally {
      for (const child of children) await stop(child);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
