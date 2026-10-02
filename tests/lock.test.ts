import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { acquireDaemonLock } from '../src/server/lock.js';

test('daemon guard excludes another owner, releases safely, and supports Unicode paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac guard 空格 '));
  try {
    const path = join(dir, 'daemon-lock.sqlite');
    const release = acquireDaemonLock(path);
    assert.throws(() => acquireDaemonLock(path), /Another daemon/);
    release();
    release();
    acquireDaemonLock(path)();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OS releases guard after process termination; restart needs no lock deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-crash-'));
  try {
    const path = join(dir, 'daemon-lock.sqlite');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { acquireDaemonLock } from ${JSON.stringify(pathToFileURL(resolve('src/server/lock.ts')).href)}; acquireDaemonLock(${JSON.stringify(path)}); console.log('ready'); setInterval(()=>{},1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== null) reject(new Error(`Child exited ${code}`));
      });
    });
    assert.throws(() => acquireDaemonLock(path));
    const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await stopped;
    acquireDaemonLock(path)();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
