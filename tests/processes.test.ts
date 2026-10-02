import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Store } from '../src/core/store.js';
import type { Project, Task } from '../src/shared/types.js';

test(
  'simultaneous independent processes cannot double-claim one task',
  { timeout: 25000 },
  async () => {
    const phase = (message: string) => process.stderr.write(`[claim-race] ${message}\n`);
    phase('creating Unicode database fixture');
    const directory = await mkdtemp(join(tmpdir(), 'collaborator-空 間-'));
    const dbPath = join(directory, 'board Ω.sqlite');
    const store = new Store(dbPath);
    const project = store.execute('project.create', { name: 'Concurrent claim' }) as Project;
    const task = store.execute('task.create', {
      projectId: project.id,
      title: 'Four-worker claim',
    }) as Task;
    const worker = fileURLToPath(new URL('./fixtures/claim-worker.ts', import.meta.url));
    function launch(index: number) {
      phase(`starting worker ${index}`);
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', worker, dbPath, task.id, String(task.version)],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      phase(`worker ${index} spawned`);
      let reportedReady = false;
      let stdout = '';
      let stderr = '';
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      const timeout = setTimeout(
        () => readyReject(new Error(`Worker ${index} did not become ready`)),
        15000,
      );
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (!reportedReady && stdout.includes('"phase":"ready"')) {
          reportedReady = true;
          phase(`worker ${index} database opened`);
          clearTimeout(timeout);
          readyResolve();
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        process.stderr.write(`[claim-worker ${index}] ${String(chunk)}`);
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        readyReject(error);
      });
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        child.once('close', (code, signal) => {
          clearTimeout(timeout);
          readyReject(
            new Error(`Worker ${index} exited before readiness: ${code}, ${signal}, ${stderr}`),
          );
          resolve({ code, signal, stdout, stderr });
        });
      });
      return { child, ready, exited };
    }
    const workers = Array.from({ length: 4 }, (_, index) => launch(index + 1));
    try {
      await Promise.all(workers.map((worker) => worker.ready));
      phase('all four workers ready; releasing claim barrier');
      for (const worker of workers) worker.child.stdin.end('claim\n');
      const exits = await Promise.all(workers.map((worker) => worker.exited));
      phase('all workers exited; validating results');
      for (const exit of exits) {
        assert.equal(
          exit.code,
          0,
          JSON.stringify({
            ...exit,
            hex: exit.code === null ? null : `0x${(exit.code >>> 0).toString(16)}`,
          }),
        );
        assert.equal(exit.signal, null);
      }
      const results = exits.map((exit) => {
        const messages = exit.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { phase: string; ok?: boolean; code?: string });
        const result = messages.find((message) => message.phase === 'result');
        assert(result, `Worker returned no result: ${exit.stdout}`);
        return result;
      });
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.deepEqual(
        results.filter((result) => !result.ok).map((result) => result.code),
        ['VERSION_CONFLICT', 'VERSION_CONFLICT', 'VERSION_CONFLICT'],
      );
      assert.equal(store.snapshot().attempts.length, 1);
      assert.equal(
        store.snapshot().events.filter((event) => event.type === 'task.claim').length,
        1,
      );
      phase('exclusive claim and audit verified');
    } finally {
      for (const worker of workers)
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill('SIGTERM');
      await Promise.all(workers.map((worker) => worker.exited));
      phase('closing parent store and removing fixture');
      store.close();
      phase('parent store closed');
      await rm(directory, { recursive: true, force: true });
      phase('fixture removed');
    }
  },
);
