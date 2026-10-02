import { Store, DomainError } from '../../src/core/store.js';

const [dbPath, taskId, expectedVersion] = process.argv.slice(2);
if (!dbPath || !taskId || !expectedVersion) throw new Error('Missing claim fixture arguments');
process.stderr.write('opening database\n');
const store = new Store(dbPath);
process.stderr.write('database opened\n');
try {
  process.stdout.write(JSON.stringify({ phase: 'ready' }) + '\n');
  // Every peer opens the same database before the parent releases this barrier.
  let instruction = '';
  for await (const chunk of process.stdin) instruction += String(chunk);
  if (instruction.trim() !== 'claim') throw new Error('Invalid claim fixture instruction');
  process.stderr.write('claiming task\n');
  try {
    const result = store.execute('task.claim', {
      taskId,
      expectedVersion: Number(expectedVersion),
      agent: { name: 'Concurrent worker', kind: 'agent', provider: 'test-fixture' },
    }) as { attempt: { id: string } };
    process.stdout.write(
      JSON.stringify({ phase: 'result', ok: true, id: result.attempt.id }) + '\n',
    );
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    process.stdout.write(JSON.stringify({ phase: 'result', ok: false, code: error.code }) + '\n');
  }
} finally {
  process.stderr.write('closing database\n');
  store.close();
  process.stderr.write('database closed\n');
}
