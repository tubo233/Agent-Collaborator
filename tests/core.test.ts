import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { DomainError, Store } from '../src/core/store.js';
import type { Actor, Attempt, ClaimResult, Handoff, Project, Task } from '../src/shared/types.js';

const human: Actor = { name: 'Reviewer', kind: 'human' };
const agent: Actor = {
  name: 'Claude worker',
  kind: 'agent',
  provider: 'claude',
  sessionId: 'session-one',
};
const evidence = [
  { label: 'Passing tests', uri: '/workspace/検証/test-results.txt', kind: 'file' },
];

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'collaborator-空 間-'));
  const dbPath = join(directory, 'board Ω.sqlite');
  let time = Date.parse('2026-10-02T10:00:00.000Z');
  const stores = new Set<Store>();
  const open = () => {
    const store = new Store(dbPath, { now: () => new Date(time) });
    stores.add(store);
    return store;
  };
  const store = open();
  t.after(() => {
    for (const connection of stores) connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    dbPath,
    directory,
    open,
    advance: (seconds: number) => {
      time += seconds * 1000;
    },
    close: (connection: Store) => {
      connection.close();
      stores.delete(connection);
    },
  };
}
function project(store: Store, name = 'Shared project'): Project {
  return store.execute('project.create', { name }) as Project;
}
function task(store: Store, projectId: string, fields: Record<string, unknown> = {}): Task {
  return store.execute('task.create', { projectId, title: 'Implement worker', ...fields }) as Task;
}
function claim(store: Store, value: Task, fields: Record<string, unknown> = {}): ClaimResult {
  return store.execute('task.claim', {
    taskId: value.id,
    expectedVersion: value.version,
    agent,
    ...fields,
  }) as ClaimResult;
}
function submit(store: Store, value: ClaimResult) {
  return store.execute('task.submit', {
    taskId: value.task.id,
    expectedVersion: value.task.version,
    attemptId: value.attempt.id,
    token: value.token,
    summary: 'Implemented and verified',
    evidence,
    nextSteps: 'Please review the change',
  }) as { task: Task; attempt: Attempt; handoff: Handoff };
}
function accept(store: Store, value: Task): Task {
  return store.execute('task.accept', {
    taskId: value.id,
    expectedVersion: value.version,
    actor: human,
  }) as Task;
}
function error(code: string) {
  return (value: unknown) => {
    assert.ok(value instanceof DomainError);
    assert.equal(value.code, code);
    return true;
  };
}
function credentials(value: ClaimResult) {
  return { taskId: value.task.id, attemptId: value.attempt.id, token: value.token };
}

test('projects, task hierarchy, comments, sessions, and Unicode references persist across restart', (t) => {
  const f = fixture(t);
  const p = project(f.store, 'プロジェクト 🛰️');
  const parent = task(f.store, p.id, { title: 'Parent' });
  const child = task(f.store, p.id, {
    parentId: parent.id,
    title: 'Unicode child 文',
    acceptanceCriteria: 'Verified',
    priority: 'high',
  });
  f.store.execute('comment.add', { taskId: child.id, body: 'レビューしてね', actor: human });
  f.store.execute('session.link', {
    taskId: child.id,
    provider: 'codex',
    sessionId: 'abc',
    label: 'Worker',
    uri: 'codex://threads/abc',
  });
  const before = f.store.snapshot();
  f.close(f.store);
  assert.deepEqual(f.open().snapshot(), before);
  assert.equal(before.tasks[1].parentId, parent.id);
  assert.equal(before.events.length, 5);
});

test('strict input validation rejects unknown fields, unsafe refs, blank values, malformed leases, and spoofed reviewers', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.execute('project.create', { name: ' ' }), error('VALIDATION_ERROR'));
  assert.throws(
    () => store.execute('project.create', { name: 'Board', surprise: true }),
    error('VALIDATION_ERROR'),
  );
  assert.throws(
    () => store.execute('project.create', { name: 'Board', repositoryUrl: 'javascript:alert(1)' }),
    error('VALIDATION_ERROR'),
  );
  assert.throws(() => store.execute('task.done', {}), error('UNKNOWN_COMMAND'));
  const value = task(store, project(store).id);
  assert.throws(() => claim(store, value, { leaseSeconds: 29 }), error('VALIDATION_ERROR'));
  assert.throws(() => claim(store, value, { leaseSeconds: 3601 }), error('VALIDATION_ERROR'));
  assert.throws(() => claim(store, value, { agent: human }), error('VALIDATION_ERROR'));
  assert.throws(
    () =>
      store.execute('task.accept', {
        taskId: value.id,
        expectedVersion: value.version,
        actor: agent,
      }),
    error('VALIDATION_ERROR'),
  );
  assert.equal(store.snapshot().attempts.length, 0);
});

test('claim is exclusive across Store connections with optimistic version checks', (t) => {
  const f = fixture(t);
  const second = f.open();
  const value = task(f.store, project(f.store).id);
  const owned = claim(f.store, value);
  assert.throws(() => claim(second, value), error('VERSION_CONFLICT'));
  assert.throws(() => claim(second, owned.task), error('INVALID_STATE'));
  assert.equal(second.snapshot().attempts.length, 1);
  assert.equal(second.snapshot().events.filter((entry) => entry.type === 'task.claim').length, 1);
  const updated = second.snapshot().tasks[0];
  assert.throws(
    () =>
      second.execute('task.update', {
        taskId: value.id,
        expectedVersion: updated.version,
        patch: { title: 'Changed mid-flight' },
      }),
    error('INVALID_STATE'),
  );
});

test('heartbeat extends only the current lease without changing the task version', (t) => {
  const f = fixture(t);
  const owned = claim(f.store, task(f.store, project(f.store).id), { leaseSeconds: 30 });
  f.advance(20);
  const attempt = f.store.execute('task.heartbeat', {
    ...credentials(owned),
    leaseSeconds: 60,
  }) as Attempt;
  assert.equal(attempt.leaseUntil, '2026-10-02T10:01:20.000Z');
  assert.equal(f.store.snapshot().tasks[0].version, owned.task.version);
  assert.throws(
    () => f.store.execute('task.heartbeat', { ...credentials(owned), token: 'x'.repeat(43) }),
    error('INVALID_TOKEN'),
  );
  f.advance(59);
  assert.equal(submit(f.store, owned).task.status, 'review');
});

test('expired leases stay running, reject old writes, and require reasoned human reclaim', (t) => {
  const f = fixture(t);
  const owned = claim(f.store, task(f.store, project(f.store).id), { leaseSeconds: 30 });
  assert.throws(
    () =>
      f.store.execute('task.reclaim', {
        taskId: owned.task.id,
        expectedVersion: owned.task.version,
        reason: 'Restart',
        actor: human,
      }),
    error('LEASE_ACTIVE'),
  );
  f.advance(30);
  assert.equal(f.store.snapshot().tasks[0].status, 'running');
  assert.throws(
    () => f.store.execute('task.heartbeat', credentials(owned)),
    error('LEASE_EXPIRED'),
  );
  assert.throws(() => submit(f.store, owned), error('LEASE_EXPIRED'));
  assert.throws(() => claim(f.store, owned.task), error('INVALID_STATE'));
  assert.throws(
    () =>
      f.store.execute('task.reclaim', {
        taskId: owned.task.id,
        expectedVersion: owned.task.version,
        reason: 'Restart',
        actor: agent,
      }),
    error('VALIDATION_ERROR'),
  );
  const ready = f.store.execute('task.reclaim', {
    taskId: owned.task.id,
    expectedVersion: owned.task.version,
    reason: 'Worker disconnected',
    actor: human,
  }) as Task;
  const replacement = claim(f.store, ready, {
    agent: { name: 'Codex worker', kind: 'agent', provider: 'codex' },
  });
  assert.equal(replacement.attempt.number, 2);
  assert.notEqual(replacement.token, owned.token);
  assert.throws(
    () => f.store.execute('task.heartbeat', credentials(owned)),
    error('STALE_ATTEMPT'),
  );
  assert.throws(
    () =>
      f.store.execute('task.submit', {
        ...credentials(owned),
        expectedVersion: replacement.task.version,
        summary: 'Stale',
        evidence,
      }),
    error('STALE_ATTEMPT'),
  );
  assert.equal(f.store.snapshot().attempts[0].status, 'reclaimed');
});

test('tokens are hashed at rest and absent from snapshots, audit events, and portable backup', (t) => {
  const f = fixture(t);
  const owned = claim(f.store, task(f.store, project(f.store).id));
  const raw = new DatabaseSync(f.dbPath);
  t.after(() => raw.close());
  const row = raw
    .prepare('SELECT token_hash, data FROM attempts WHERE id=?')
    .get(owned.attempt.id)!;
  assert.equal(row.token_hash, createHash('sha256').update(owned.token).digest('hex'));
  assert.ok(!String(row.data).includes(owned.token));
  assert.ok(!JSON.stringify(f.store.snapshot()).includes(owned.token));
  assert.ok(!JSON.stringify(f.store.exportData()).includes(owned.token));
  assert.ok(!JSON.stringify(f.store.exportData()).includes('token_hash'));
  submit(f.store, owned);
  assert.equal(
    raw.prepare('SELECT token_hash FROM attempts WHERE id=?').get(owned.attempt.id)!.token_hash,
    null,
  );
});

test('dependencies gate claims, completion needs evidence and human acceptance, and done is stable', (t) => {
  const { store } = fixture(t);
  const p = project(store);
  const dependency = task(store, p.id, { title: 'Dependency' });
  const dependent = task(store, p.id, { dependencies: [dependency.id] });
  assert.throws(() => claim(store, dependent), error('DEPENDENCIES_INCOMPLETE'));
  assert.throws(() => accept(store, dependency), error('INVALID_STATE'));
  const owned = claim(store, dependency);
  assert.throws(
    () =>
      store.execute('task.submit', {
        ...credentials(owned),
        expectedVersion: owned.task.version,
        summary: 'Done',
        evidence: [],
      }),
    error('VALIDATION_ERROR'),
  );
  assert.throws(
    () =>
      store.execute('task.submit', {
        ...credentials(owned),
        expectedVersion: owned.task.version,
        summary: 'Done',
        evidence: [{ label: 'Bad', uri: 'data:text/html,script' }],
      }),
    error('VALIDATION_ERROR'),
  );
  const submitted = submit(store, owned);
  assert.equal(submitted.task.status, 'review');
  assert.throws(() => claim(store, dependent), error('DEPENDENCIES_INCOMPLETE'));
  assert.throws(() => store.execute('task.heartbeat', credentials(owned)), error('INVALID_STATE'));
  const done = accept(store, submitted.task);
  assert.equal(done.status, 'done');
  assert.equal(store.snapshot().handoffs[0].decision, 'accepted');
  assert.throws(
    () =>
      store.execute('task.cancel', {
        taskId: done.id,
        expectedVersion: done.version,
        actor: human,
        reason: 'Undo',
      }),
    error('INVALID_STATE'),
  );
  assert.throws(
    () =>
      store.execute('task.update', {
        taskId: done.id,
        expectedVersion: done.version,
        patch: { title: 'Undo' },
      }),
    error('INVALID_STATE'),
  );
  assert.equal(claim(store, dependent).task.status, 'running');
});

test('review rejection requires a note and creates a new attempt on the next claim', (t) => {
  const { store } = fixture(t);
  const first = claim(store, task(store, project(store).id));
  const submitted = submit(store, first);
  assert.throws(
    () =>
      store.execute('task.reject', {
        taskId: submitted.task.id,
        expectedVersion: submitted.task.version,
        actor: human,
      }),
    error('VALIDATION_ERROR'),
  );
  const ready = store.execute('task.reject', {
    taskId: submitted.task.id,
    expectedVersion: submitted.task.version,
    actor: human,
    note: 'Please cover timeout behavior',
  }) as Task;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.currentAttemptId, null);
  const second = claim(store, ready);
  assert.equal(second.attempt.number, 2);
  assert.equal(store.snapshot().attempts[0].status, 'rejected');
  assert.throws(() => store.execute('task.heartbeat', credentials(first)), error('STALE_ATTEMPT'));
  assert.equal(store.snapshot().handoffs[0].reviewNote, 'Please cover timeout behavior');
});

test('dependency cycles, cross-project links, missing links, and parent edits are rejected atomically', (t) => {
  const { store } = fixture(t);
  const p = project(store);
  const a = task(store, p.id, { title: 'A' });
  const b = task(store, p.id, { title: 'B', dependencies: [a.id] });
  const c = task(store, p.id, { title: 'C', dependencies: [b.id] });
  const foreign = task(store, project(store, 'Other').id);
  const before = store.snapshot();
  assert.throws(
    () =>
      store.execute('task.update', {
        taskId: a.id,
        expectedVersion: a.version,
        patch: { dependencies: [c.id] },
      }),
    error('CYCLE'),
  );
  assert.throws(
    () => task(store, p.id, { dependencies: [foreign.id] }),
    error('CROSS_PROJECT_LINK'),
  );
  assert.throws(() => task(store, p.id, { parentId: foreign.id }), error('CROSS_PROJECT_LINK'));
  assert.throws(() => task(store, p.id, { dependencies: ['missing'] }), error('NOT_FOUND'));
  assert.throws(
    () =>
      store.execute('task.update', {
        taskId: a.id,
        expectedVersion: a.version,
        patch: { parentId: b.id },
      }),
    error('VALIDATION_ERROR'),
  );
  assert.throws(
    () =>
      store.execute('task.update', {
        taskId: a.id,
        expectedVersion: a.version,
        patch: { dependencies: [a.id] },
      }),
    error('CYCLE'),
  );
  assert.deepEqual(store.snapshot(), before);
});

test('blocking, unblocking, and cancellation fence active credentials', (t) => {
  const { store } = fixture(t);
  const initial = task(store, project(store).id);
  const blocked = store.execute('task.block', {
    taskId: initial.id,
    expectedVersion: initial.version,
    reason: 'Need design review',
  }) as Task;
  assert.equal(blocked.blockedReason, 'Need design review');
  assert.throws(() => claim(store, blocked), error('INVALID_STATE'));
  const ready = store.execute('task.unblock', {
    taskId: blocked.id,
    expectedVersion: blocked.version,
    actor: human,
  }) as Task;
  const owned = claim(store, ready);
  assert.throws(
    () =>
      store.execute('task.block', {
        taskId: owned.task.id,
        expectedVersion: owned.task.version,
        reason: 'Waiting',
      }),
    error('LEASE_REQUIRED'),
  );
  const blockedAgain = store.execute('task.block', {
    ...credentials(owned),
    expectedVersion: owned.task.version,
    reason: 'Awaiting access',
  }) as Task;
  assert.equal(store.snapshot().attempts[0].status, 'blocked');
  const unblocked = store.execute('task.unblock', {
    taskId: blockedAgain.id,
    expectedVersion: blockedAgain.version,
    actor: human,
  }) as Task;
  const next = claim(store, unblocked);
  const cancelled = store.execute('task.cancel', {
    taskId: next.task.id,
    expectedVersion: next.task.version,
    actor: human,
    reason: 'No longer needed',
  }) as Task;
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => store.execute('task.heartbeat', credentials(next)), error('INVALID_STATE'));
  assert.throws(() => claim(store, cancelled), error('INVALID_STATE'));
});

test('event insertion failure rolls back task status, version, attempt, and ownership atomically', (t) => {
  const f = fixture(t);
  const initial = task(f.store, project(f.store).id);
  const before = f.store.snapshot();
  const raw = new DatabaseSync(f.dbPath);
  raw.exec(
    "CREATE TRIGGER force_audit_failure BEFORE INSERT ON events WHEN NEW.type = 'task.claim' BEGIN SELECT RAISE(ABORT, 'Injected audit failure'); END",
  );
  assert.throws(() => claim(f.store, initial), /Injected audit failure/);
  assert.deepEqual(f.store.snapshot(), before);
  raw.exec('DROP TRIGGER force_audit_failure');
  raw.close();
  assert.equal(claim(f.store, initial).attempt.number, 1);
});

test('audit rows are append-only and schema versions newer than supported are refused', (t) => {
  const f = fixture(t);
  project(f.store);
  const raw = new DatabaseSync(f.dbPath);
  assert.throws(() => raw.exec("UPDATE events SET type='tampered'"), /append-only/);
  assert.throws(() => raw.exec('DELETE FROM events'), /append-only/);
  raw.close();
  const futurePath = join(f.directory, 'future.sqlite');
  const future = new DatabaseSync(futurePath);
  future.exec('PRAGMA user_version = 999');
  future.close();
  assert.throws(() => new Store(futurePath), error('SCHEMA_TOO_NEW'));
});

test('backup round-trip preserves data and audit history, invalidates active leases, and refuses overwrite', (t) => {
  const source = fixture(t);
  const target = fixture(t);
  const p = project(source.store, 'Backup 日本語');
  const completed = accept(
    source.store,
    submit(source.store, claim(source.store, task(source.store, p.id))).task,
  );
  const active = claim(source.store, task(source.store, p.id, { dependencies: [completed.id] }));
  const backup = source.store.exportData();
  const snapshot = target.store.restoreData(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(snapshot.projects, backup.data.projects);
  const restored = snapshot.tasks.find((value) => value.id === active.task.id)!;
  assert.equal(restored.status, 'ready');
  assert.equal(restored.currentAttemptId, null);
  assert.equal(restored.version, active.task.version + 1);
  assert.equal(
    snapshot.attempts.find((value) => value.id === active.attempt.id)!.status,
    'reclaimed',
  );
  assert.equal(snapshot.tasks.find((value) => value.id === completed.id)!.status, 'done');
  assert.deepEqual(snapshot.events.slice(0, backup.data.events.length), backup.data.events);
  const reclaimed = claim(target.store, restored);
  assert.equal(reclaimed.attempt.number, 2);
  assert.throws(
    () => target.store.execute('task.heartbeat', credentials(active)),
    error('STALE_ATTEMPT'),
  );
  assert.throws(() => target.store.restoreData(backup), error('DATABASE_NOT_EMPTY'));
  assert.equal(
    backup.data.tasks.find((value) => value.id === active.task.id)!.status,
    'running',
    'restore must not mutate the caller backup',
  );
});

test('malformed backup graphs, review state, unknown fields, and secret-bearing events are rejected without writes', (t) => {
  const source = fixture(t);
  const target = fixture(t);
  const p = project(source.store);
  const a = task(source.store, p.id);
  task(source.store, p.id, { dependencies: [a.id] });
  const backup = source.store.exportData();
  const invalid = structuredClone(backup);
  invalid.data.tasks[0].dependencies = [invalid.data.tasks[1].id];
  assert.throws(() => target.store.restoreData(invalid), error('INVALID_BACKUP'));
  const secrets = structuredClone(backup);
  secrets.data.events[0].data = { nested: { token: 'secret' } };
  assert.throws(() => target.store.restoreData(secrets), error('INVALID_BACKUP'));
  assert.throws(
    () => target.store.restoreData({ ...backup, token: 'unexpected' }),
    error('VALIDATION_ERROR'),
  );
  const badState = structuredClone(backup);
  badState.data.tasks[0].status = 'done';
  assert.throws(() => target.store.restoreData(badState), error('INVALID_BACKUP'));
  assert.equal(target.store.snapshot().projects.length, 0);
  assert.equal(target.store.snapshot().events.length, 0);
});

test('snapshots bound recent event history while portable backups preserve the entire audit trail', (t) => {
  const { store } = fixture(t);
  const value = task(store, project(store).id);
  for (let i = 0; i < 2010; i++)
    store.execute('comment.add', { taskId: value.id, body: `Comment ${i}`, actor: human });
  const snapshot = store.snapshot();
  assert.equal(snapshot.events.length, 2000);
  assert.equal(snapshot.events[0].id, 13);
  assert.equal(snapshot.events.at(-1)!.id, 2012);
  assert.equal(store.exportData().data.events.length, 2012);
});
