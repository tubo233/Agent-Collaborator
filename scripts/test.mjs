import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'tests');
const files = readdirSync(directory)
  .filter((file) => /\.test\.tsx?$/.test(file))
  .sort();
if (files.length === 0) throw new Error('No test files found');

// Keep each file in a separate OS process, without Node's nested test-runner
// child/IPC teardown path. Node 24 has a reported Windows native crash there:
// https://github.com/nodejs/node/issues/65756
// This is a runner workaround, not a skipped test or a retry on failure.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
let failed = false;
for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-isolation=none',
      '--test-reporter=tap',
      join(directory, file),
    ],
    { cwd: root, env, stdio: 'inherit', timeout: 120000 },
  );
  if (result.error || result.status !== 0 || result.signal !== null) {
    failed = true;
    // Preserve the raw Windows NTSTATUS instead of collapsing it to "test failed".
    const hexadecimal = result.status === null ? null : `0x${(result.status >>> 0).toString(16)}`;
    process.stderr.write(
      `${file} failed: ${JSON.stringify({ exitCode: result.status, hexadecimal, signal: result.signal, error: result.error?.message })}\n`,
    );
  }
}
process.stdout.write(
  `\n${files.length} test files executed; ${failed ? 'at least one failed' : 'all passed'}.\n`,
);
process.exitCode = failed ? 1 : 0;
