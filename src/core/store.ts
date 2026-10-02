import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  Actor,
  Attempt,
  ClaimResult,
  Comment,
  Handoff,
  Project,
  SessionRef,
  Snapshot,
  Task,
} from '../shared/types.js';
import { backupSchema, commandSchemas } from './validation.js';

const SCHEMA_VERSION = 1;
const LOCAL_ACTOR: Actor = { kind: 'human', name: 'Local user' };
type EntityTable = 'projects' | 'tasks' | 'attempts' | 'handoffs' | 'comments' | 'sessions';
type Row = { data: string };
export interface PortableBackup {
  format: 'agent-collaborator';
  schemaVersion: 1;
  exportedAt: string;
  data: Snapshot;
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

function fail(code: string, message: string, status = 409, details?: unknown): never {
  throw new DomainError(code, message, status, details);
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    fail(
      'VALIDATION_ERROR',
      'Invalid input',
      400,
      result.error.issues.map(({ path, message }) => ({ path, message })),
    );
  return result.data;
}

/** One daemon owns mutations. Transactions also fence accidental competing connections. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(dbPath: string, options: { now?: () => Date } = {}) {
    this.clock = options.now ?? (() => new Date());
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version;
      if (version > SCHEMA_VERSION)
        fail(
          'SCHEMA_TOO_NEW',
          `Database schema ${version} is newer than supported version ${SCHEMA_VERSION}`,
          500,
        );
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      if (version === 0) this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), token_hash TEXT, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id), data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, project_id TEXT REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), actor TEXT NOT NULL CHECK(json_valid(actor)), data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id);
        CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
        CREATE INDEX IF NOT EXISTS handoffs_task ON handoffs(task_id);
        CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
        PRAGMA user_version = 1;
      `);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return this.clock().toISOString();
  }
  private all<T>(table: EntityTable): T[] {
    return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as Row[]).map(
      (row) => JSON.parse(row.data) as T,
    );
  }
  private get<T>(table: EntityTable, id: string): T {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as
      Row | undefined;
    if (!row) fail('NOT_FOUND', `${table.slice(0, -1)} not found`, 404, { id });
    return JSON.parse(row.data) as T;
  }
  private insert(
    table: EntityTable,
    value: Project | Task | Attempt | Handoff | Comment | SessionRef,
    tokenHash: string | null = null,
  ): void {
    if (table === 'projects')
      this.db
        .prepare('INSERT INTO projects(id, data) VALUES (?, ?)')
        .run(value.id, JSON.stringify(value));
    else if (table === 'tasks')
      this.db
        .prepare('INSERT INTO tasks(id, project_id, data) VALUES (?, ?, ?)')
        .run(value.id, (value as Task).projectId, JSON.stringify(value));
    else if (table === 'attempts')
      this.db
        .prepare('INSERT INTO attempts(id, task_id, token_hash, data) VALUES (?, ?, ?, ?)')
        .run(value.id, (value as Attempt).taskId, tokenHash, JSON.stringify(value));
    else if (table === 'handoffs')
      this.db
        .prepare('INSERT INTO handoffs(id, task_id, attempt_id, data) VALUES (?, ?, ?, ?)')
        .run(
          value.id,
          (value as Handoff).taskId,
          (value as Handoff).attemptId,
          JSON.stringify(value),
        );
    else
      this.db
        .prepare(`INSERT INTO ${table}(id, task_id, data) VALUES (?, ?, ?)`)
        .run(value.id, (value as Comment | SessionRef).taskId, JSON.stringify(value));
  }
  private save(table: EntityTable, value: { id: string }): void {
    this.db
      .prepare(`UPDATE ${table} SET data = ? WHERE id = ?`)
      .run(JSON.stringify(value), value.id);
  }
  private saveTask(task: Task, at: string): Task {
    task.version += 1;
    task.updatedAt = at;
    this.save('tasks', task);
    return task;
  }
  private finishAttempt(attempt: Attempt, status: Attempt['status'], at: string): void {
    attempt.status = status;
    attempt.endedAt = at;
    this.save('attempts', attempt);
    this.db.prepare('UPDATE attempts SET token_hash = NULL WHERE id = ?').run(attempt.id);
  }
  private event(
    type: string,
    task: Task | null,
    actor: Actor,
    data: Record<string, unknown>,
    at: string,
    projectId?: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO events(type, project_id, task_id, actor, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        type,
        task?.projectId ?? projectId ?? null,
        task?.id ?? null,
        JSON.stringify(actor),
        JSON.stringify(data),
        at,
      );
  }
  private currentTask(id: string, expectedVersion: number): Task {
    const task = this.get<Task>('tasks', id);
    if (task.version !== expectedVersion)
      fail('VERSION_CONFLICT', 'Task changed; refresh before retrying', 409, {
        taskId: id,
        expectedVersion,
        actualVersion: task.version,
      });
    return task;
  }
  private requireStatus(task: Task, ...allowed: Task['status'][]): void {
    if (!allowed.includes(task.status))
      fail('INVALID_STATE', `Task must be ${allowed.join(' or ')} for this action`, 409, {
        status: task.status,
      });
  }
  private owned(task: Task, attemptId: string, token: string, at: string): Attempt {
    this.requireStatus(task, 'running');
    if (task.currentAttemptId !== attemptId)
      fail('STALE_ATTEMPT', 'This attempt no longer owns the task');
    const attempt = this.get<Attempt>('attempts', attemptId);
    if (attempt.taskId !== task.id || attempt.status !== 'active')
      fail('STALE_ATTEMPT', 'This attempt no longer owns the task');
    const hash = (
      this.db.prepare('SELECT token_hash FROM attempts WHERE id = ?').get(attemptId) as {
        token_hash: string | null;
      }
    ).token_hash;
    const supplied = createHash('sha256').update(token).digest();
    if (!hash || !timingSafeEqual(Buffer.from(hash, 'hex'), supplied))
      fail('INVALID_TOKEN', 'Invalid lease credentials', 403);
    if (Date.parse(attempt.leaseUntil) <= Date.parse(at))
      fail('LEASE_EXPIRED', 'Lease expired; a human must explicitly reclaim the task');
    return attempt;
  }
  private validateLinks(task: Task): void {
    if (task.parentId) {
      const parent = this.get<Task>('tasks', task.parentId);
      if (parent.projectId !== task.projectId)
        fail('CROSS_PROJECT_LINK', 'Parent must belong to the same project', 400);
      const visited = new Set<string>([task.id]);
      let next: Task | undefined = parent;
      while (next) {
        if (visited.has(next.id)) fail('CYCLE', 'Parent relationships cannot contain a cycle', 400);
        visited.add(next.id);
        next = next.parentId ? this.get<Task>('tasks', next.parentId) : undefined;
      }
    }
    const visited = new Set<string>();
    const pending = [...task.dependencies];
    while (pending.length) {
      const id = pending.pop()!;
      if (id === task.id) fail('CYCLE', 'Dependencies cannot contain a cycle', 400);
      if (visited.has(id)) continue;
      const dependency = this.get<Task>('tasks', id);
      if (dependency.projectId !== task.projectId)
        fail('CROSS_PROJECT_LINK', 'Dependencies must belong to the same project', 400);
      visited.add(id);
      pending.push(...dependency.dependencies);
    }
  }
  private dependenciesDone(task: Task): void {
    const unfinished = task.dependencies.filter(
      (id) => this.get<Task>('tasks', id).status !== 'done',
    );
    if (unfinished.length)
      fail(
        'DEPENDENCIES_INCOMPLETE',
        'All dependencies must be done before claiming the task',
        409,
        { taskIds: unfinished },
      );
  }

  snapshot(): Snapshot {
    return this.readSnapshot(false);
  }

  private readSnapshot(allEvents: boolean): Snapshot {
    // Read all tables in one transaction so readers cannot observe a half command.
    this.db.exec('BEGIN');
    try {
      const data: Snapshot = {
        projects: this.all<Project>('projects'),
        tasks: this.all<Task>('tasks'),
        attempts: this.all<Attempt>('attempts'),
        handoffs: this.all<Handoff>('handoffs'),
        comments: this.all<Comment>('comments'),
        sessions: this.all<SessionRef>('sessions'),
        events: this.db
          .prepare(
            allEvents
              ? 'SELECT * FROM events ORDER BY id'
              : 'SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT 2000) ORDER BY id',
          )
          .all()
          .map((row) => ({
            id: Number(row.id),
            type: String(row.type),
            projectId: row.project_id === null ? null : String(row.project_id),
            taskId: row.task_id === null ? null : String(row.task_id),
            actor: JSON.parse(String(row.actor)) as Actor,
            data: JSON.parse(String(row.data)) as Record<string, unknown>,
            createdAt: String(row.created_at),
          })),
        serverTime: this.now(),
      };
      this.db.exec('COMMIT');
      return data;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  execute(command: string, input: Record<string, unknown>): unknown {
    if (!Object.hasOwn(commandSchemas, command))
      fail('UNKNOWN_COMMAND', `Unknown command: ${command}`, 400);
    // Only allowlisted fields ever reach events; any failure rolls back the whole command.
    return this.transaction(() => this.dispatch(command, input));
  }

  private dispatch(command: string, input: Record<string, unknown>): unknown {
    const at = this.now();
    switch (command) {
      case 'project.create': {
        const value = parse(commandSchemas[command], input);
        const project: Project = {
          id: randomUUID(),
          name: value.name,
          description: value.description ?? '',
          repositoryUrl: value.repositoryUrl ?? '',
          createdAt: at,
        };
        this.insert('projects', project);
        this.event(
          command,
          null,
          value.actor ?? LOCAL_ACTOR,
          { projectId: project.id, name: project.name },
          at,
          project.id,
        );
        return project;
      }
      case 'task.create': {
        const value = parse(commandSchemas[command], input);
        this.get<Project>('projects', value.projectId);
        const task: Task = {
          id: randomUUID(),
          projectId: value.projectId,
          parentId: value.parentId ?? null,
          title: value.title,
          description: value.description ?? '',
          acceptanceCriteria: value.acceptanceCriteria ?? '',
          priority: value.priority ?? 'normal',
          status: 'ready',
          dependencies: value.dependencies ?? [],
          version: 1,
          currentAttemptId: null,
          blockedReason: null,
          createdAt: at,
          updatedAt: at,
        };
        this.validateLinks(task);
        this.insert('tasks', task);
        this.event(
          command,
          task,
          value.actor ?? LOCAL_ACTOR,
          {
            title: task.title,
            dependencies: task.dependencies,
            parentId: task.parentId,
            version: task.version,
          },
          at,
        );
        return task;
      }
      case 'task.update': {
        const value = parse(commandSchemas[command], input);
        const task = this.currentTask(value.taskId, value.expectedVersion);
        this.requireStatus(task, 'ready', 'blocked');
        Object.assign(task, value.patch);
        this.validateLinks(task);
        this.saveTask(task, at);
        this.event(
          command,
          task,
          value.actor ?? LOCAL_ACTOR,
          { fields: Object.keys(value.patch), version: task.version },
          at,
        );
        return task;
      }
      case 'task.claim': {
        const value = parse(commandSchemas[command], input);
        const task = this.currentTask(value.taskId, value.expectedVersion);
        this.requireStatus(task, 'ready');
        this.dependenciesDone(task);
        const token = randomBytes(32).toString('base64url');
        const count = (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(json_extract(data, '$.number')), 0) AS count FROM attempts WHERE task_id = ?",
            )
            .get(task.id) as { count: number }
        ).count;
        const attempt: Attempt = {
          id: randomUUID(),
          taskId: task.id,
          number: count + 1,
          agent: value.agent,
          status: 'active',
          startedAt: at,
          heartbeatAt: at,
          leaseUntil: new Date(Date.parse(at) + (value.leaseSeconds ?? 300) * 1000).toISOString(),
          endedAt: null,
        };
        this.insert('attempts', attempt, createHash('sha256').update(token).digest('hex'));
        task.status = 'running';
        task.currentAttemptId = attempt.id;
        task.blockedReason = null;
        this.saveTask(task, at);
        this.event(
          command,
          task,
          value.agent,
          {
            attemptId: attempt.id,
            attemptNumber: attempt.number,
            leaseUntil: attempt.leaseUntil,
            version: task.version,
          },
          at,
        );
        return { task, attempt, token } satisfies ClaimResult;
      }
      case 'task.heartbeat': {
        const value = parse(commandSchemas[command], input);
        const task = this.get<Task>('tasks', value.taskId);
        const attempt = this.owned(task, value.attemptId, value.token, at);
        attempt.heartbeatAt = at;
        attempt.leaseUntil = new Date(
          Date.parse(at) + (value.leaseSeconds ?? 300) * 1000,
        ).toISOString();
        this.save('attempts', attempt);
        this.event(
          command,
          task,
          attempt.agent,
          { attemptId: attempt.id, leaseUntil: attempt.leaseUntil },
          at,
        );
        return attempt;
      }
      case 'task.reclaim': {
        const value = parse(commandSchemas[command], input);
        const task = this.currentTask(value.taskId, value.expectedVersion);
        this.requireStatus(task, 'running');
        const attempt = this.get<Attempt>('attempts', task.currentAttemptId!);
        if (Date.parse(attempt.leaseUntil) > Date.parse(at))
          fail(
            'LEASE_ACTIVE',
            'Wait for lease expiry before reclaiming; use explicit cancellation to stop an active task',
          );
        this.finishAttempt(attempt, 'reclaimed', at);
        task.status = 'ready';
        task.currentAttemptId = null;
        task.blockedReason = null;
        this.saveTask(task, at);
        this.event(
          command,
          task,
          value.actor,
          { attemptId: attempt.id, reason: value.reason, version: task.version },
          at,
        );
        return task;
      }
      case 'task.submit': {
        const value = parse(commandSchemas[command], input);
        const task = this.currentTask(value.taskId, value.expectedVersion);
        const attempt = this.owned(task, value.attemptId, value.token, at);
        const handoff: Handoff = {
          id: randomUUID(),
          taskId: task.id,
          attemptId: attempt.id,
          summary: value.summary,
          evidence: value.evidence,
          nextSteps: value.nextSteps ?? '',
          createdAt: at,
          reviewedAt: null,
          reviewNote: null,
          decision: 'pending',
        };
        this.finishAttempt(attempt, 'submitted', at);
        this.insert('handoffs', handoff);
        task.status = 'review';
        this.saveTask(task, at);
        this.event(
          command,
          task,
          attempt.agent,
          { attemptId: attempt.id, handoffId: handoff.id, version: task.version },
          at,
        );
        return { task, attempt, handoff };
      }
      case 'task.accept':
      case 'task.reject': {
        const value = parse(commandSchemas[command], input);
        const task = this.currentTask(value.taskId, value.expectedVersion);
        this.requireStatus(task, 'review');
        const attempt = this.get<Attempt>('attempts', task.currentAttemptId!);
        const row = this.db
          .prepare('SELECT data FROM handoffs WHERE attempt_id = ?')
          .get(attempt.id) as Row | undefined;
        if (!row) fail('MISSING_HANDOFF', 'A submitted handoff is required for review');
        const handoff = JSON.parse(row.data) as Handoff;
        if (handoff.decision !== 'pending' || attempt.status !== 'submitted')
          fail('INVALID_STATE', 'Handoff has already been reviewed');
        const accepted = command === 'task.accept';
        handoff.decision = accepted ? 'accepted' : 'rejected';
        handoff.reviewedAt = at;
        handoff.reviewNote = value.note ?? '';
        this.save('handoffs', handoff);
        this.finishAttempt(attempt, accepted ? 'accepted' : 'rejected', at);
        task.status = accepted ? 'done' : 'ready';
        if (!accepted) task.currentAttemptId = null;
        this.saveTask(task, at);
        this.event(
          command,
          task,
          value.actor,
          {
            attemptId: attempt.id,
            handoffId: handoff.id,
            note: value.note ?? '',
            version: task.version,
          },
          at,
        );
        return task;
      }
      case 'task.block': {
        const value = parse(commandSchemas[command], input);
        const task = this.currentTask(value.taskId, value.expectedVersion);
        this.requireStatus(task, 'ready', 'running');
        let actor = value.actor ?? LOCAL_ACTOR;
        if (task.status === 'running') {
          if (!value.attemptId || !value.token)
            fail('LEASE_REQUIRED', 'Running tasks require their current lease credentials', 403);
          const attempt = this.owned(task, value.attemptId, value.token, at);
          actor = attempt.agent;
          this.finishAttempt(attempt, 'blocked', at);
          task.currentAttemptId = null;
        } else if (value.attemptId || value.token)
          fail('INVALID_STATE', 'Ready tasks do not have lease credentials');
        task.status = 'blocked';
        task.blockedReason = value.reason;
        this.saveTask(task, at);
        this.event(command, task, actor, { reason: value.reason, version: task.version }, at);
        return task;
      }
      case 'task.unblock': {
        const value = parse(commandSchemas[command], input);
        const task = this.currentTask(value.taskId, value.expectedVersion);
        this.requireStatus(task, 'blocked');
        task.status = 'ready';
        task.blockedReason = null;
        this.saveTask(task, at);
        this.event(command, task, value.actor, { version: task.version }, at);
        return task;
      }
      case 'task.cancel': {
        const value = parse(commandSchemas[command], input);
        const task = this.currentTask(value.taskId, value.expectedVersion);
        this.requireStatus(task, 'ready', 'running', 'review', 'blocked');
        if (task.currentAttemptId) {
          const attempt = this.get<Attempt>('attempts', task.currentAttemptId);
          this.finishAttempt(attempt, 'cancelled', at);
          const row = this.db
            .prepare('SELECT data FROM handoffs WHERE attempt_id = ?')
            .get(attempt.id) as Row | undefined;
          if (row) {
            const handoff = JSON.parse(row.data) as Handoff;
            if (handoff.decision === 'pending') {
              handoff.decision = 'rejected';
              handoff.reviewedAt = at;
              handoff.reviewNote = `Cancelled: ${value.reason}`;
              this.save('handoffs', handoff);
            }
          }
        }
        task.status = 'cancelled';
        task.currentAttemptId = null;
        task.blockedReason = null;
        this.saveTask(task, at);
        this.event(command, task, value.actor, { reason: value.reason, version: task.version }, at);
        return task;
      }
      case 'comment.add': {
        const value = parse(commandSchemas[command], input);
        const task = this.get<Task>('tasks', value.taskId);
        const comment: Comment = {
          id: randomUUID(),
          taskId: task.id,
          body: value.body,
          actor: value.actor,
          createdAt: at,
        };
        this.insert('comments', comment);
        this.event(command, task, value.actor, { commentId: comment.id }, at);
        return comment;
      }
      case 'session.link': {
        const value = parse(commandSchemas[command], input);
        const task = this.get<Task>('tasks', value.taskId);
        const session: SessionRef = {
          id: randomUUID(),
          taskId: task.id,
          provider: value.provider,
          sessionId: value.sessionId,
          label: value.label ?? '',
          uri: value.uri ?? '',
          createdAt: at,
        };
        this.insert('sessions', session);
        this.event(
          command,
          task,
          value.actor ?? LOCAL_ACTOR,
          { sessionId: session.id, provider: session.provider },
          at,
        );
        return session;
      }
      default:
        return fail('UNKNOWN_COMMAND', `Unknown command: ${command}`, 400);
    }
  }

  exportData(): PortableBackup {
    return {
      format: 'agent-collaborator',
      schemaVersion: 1,
      exportedAt: this.now(),
      data: this.readSnapshot(true),
    };
  }

  restoreData(input: unknown): Snapshot {
    const backup = parse(backupSchema, input);
    const data: Snapshot = backup.data;
    this.validateBackup(data);
    this.transaction(() => {
      const count = this.db
        .prepare('SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM events) AS count')
        .get() as { count: number };
      if (count.count !== 0)
        fail('DATABASE_NOT_EMPTY', 'Restore is only allowed into an empty database');
      const at = this.now();
      const reclaimed: { task: Task; attempt: Attempt }[] = [];
      for (const task of data.tasks) {
        if (task.status === 'running') {
          const attempt = data.attempts.find((item) => item.id === task.currentAttemptId)!;
          attempt.status = 'reclaimed';
          attempt.endedAt = at;
          task.status = 'ready';
          task.currentAttemptId = null;
          task.version += 1;
          task.updatedAt = at;
          reclaimed.push({ task, attempt });
        }
      }
      for (const value of data.projects) this.insert('projects', value);
      for (const value of data.tasks) this.insert('tasks', value);
      for (const value of data.attempts) this.insert('attempts', value);
      for (const value of data.handoffs) this.insert('handoffs', value);
      for (const value of data.comments) this.insert('comments', value);
      for (const value of data.sessions) this.insert('sessions', value);
      for (const event of data.events)
        this.db
          .prepare(
            'INSERT INTO events(id, type, project_id, task_id, actor, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            event.id,
            event.type,
            event.projectId,
            event.taskId,
            JSON.stringify(event.actor),
            JSON.stringify(event.data),
            event.createdAt,
          );
      for (const { task, attempt } of reclaimed)
        this.event(
          'task.reclaim',
          task,
          LOCAL_ACTOR,
          {
            attemptId: attempt.id,
            reason: 'Restore invalidated the previous lease',
            version: task.version,
          },
          at,
        );
      this.event(
        'backup.restore',
        null,
        LOCAL_ACTOR,
        {
          projects: data.projects.length,
          tasks: data.tasks.length,
          reclaimedAttempts: reclaimed.length,
        },
        at,
      );
    });
    return this.snapshot();
  }

  private validateBackup(data: Snapshot): void {
    const invalid = (message: string): never => fail('INVALID_BACKUP', message, 400);
    const unique = <T extends { id: string | number }>(
      values: T[],
      label: string,
    ): Map<T['id'], T> => {
      const map = new Map(values.map((value) => [value.id, value]));
      if (map.size !== values.length) invalid(`Duplicate ${label} IDs`);
      return map;
    };
    const projects = unique(data.projects, 'project');
    const tasks = unique(data.tasks, 'task');
    const attempts = unique(data.attempts, 'attempt');
    unique(data.handoffs, 'handoff');
    unique(data.comments, 'comment');
    unique(data.sessions, 'session');
    unique(data.events, 'event');
    const handoffs = new Map<string, Handoff>();
    for (const handoff of data.handoffs) {
      const attempt = attempts.get(handoff.attemptId);
      if (
        !attempt ||
        attempt.taskId !== handoff.taskId ||
        !tasks.has(handoff.taskId) ||
        handoffs.has(handoff.attemptId)
      )
        invalid('Handoff has invalid or duplicate attempt');
      handoffs.set(handoff.attemptId, handoff);
      if ((handoff.decision === 'pending') !== (handoff.reviewedAt === null))
        invalid('Handoff review state is inconsistent');
      const allowed = {
        pending: ['submitted'],
        accepted: ['accepted'],
        rejected: ['rejected', 'cancelled'],
      };
      if (!allowed[handoff.decision].includes(attempt!.status))
        invalid('Handoff decision does not match attempt');
    }
    const numbers = new Set<string>();
    for (const attempt of data.attempts) {
      const key = JSON.stringify([attempt.taskId, attempt.number]);
      if (!tasks.has(attempt.taskId) || numbers.has(key))
        invalid('Attempt has invalid task or duplicate number');
      numbers.add(key);
      if ((attempt.status === 'active') !== (attempt.endedAt === null))
        invalid('Attempt end state is inconsistent');
      if (
        Date.parse(attempt.heartbeatAt) < Date.parse(attempt.startedAt) ||
        Date.parse(attempt.leaseUntil) <= Date.parse(attempt.heartbeatAt)
      )
        invalid('Attempt timestamps are inconsistent');
      if (attempt.status === 'rejected' && handoffs.get(attempt.id)?.decision !== 'rejected')
        invalid('Rejected attempt has no rejected handoff');
      const task = tasks.get(attempt.taskId)!;
      if (
        attempt.status === 'active' &&
        (task.status !== 'running' || task.currentAttemptId !== attempt.id)
      )
        invalid('Active attempt has no owning task');
      if (
        attempt.status === 'submitted' &&
        (task.status !== 'review' ||
          task.currentAttemptId !== attempt.id ||
          handoffs.get(attempt.id)?.decision !== 'pending')
      )
        invalid('Submitted attempt has no pending review');
      if (
        attempt.status === 'accepted' &&
        (task.status !== 'done' ||
          task.currentAttemptId !== attempt.id ||
          handoffs.get(attempt.id)?.decision !== 'accepted')
      )
        invalid('Accepted attempt has no accepted task');
    }
    const validateGraph = (parent: boolean): void => {
      const visited = new Set<string>();
      for (const root of data.tasks) {
        const visiting = new Set<string>();
        const pending: { id: string; exit: boolean }[] = [{ id: root.id, exit: false }];
        while (pending.length) {
          const entry = pending.pop()!;
          if (entry.exit) {
            visiting.delete(entry.id);
            visited.add(entry.id);
            continue;
          }
          if (visiting.has(entry.id)) invalid(parent ? 'Parent cycle' : 'Dependency cycle');
          if (visited.has(entry.id)) continue;
          const task = tasks.get(entry.id)!;
          visiting.add(entry.id);
          pending.push({ id: entry.id, exit: true });
          const links = parent ? (task.parentId ? [task.parentId] : []) : task.dependencies;
          for (const id of links) {
            const linked = tasks.get(id);
            if (!linked || linked.projectId !== task.projectId)
              invalid('Missing or cross-project task link');
            pending.push({ id, exit: false });
          }
        }
      }
    };
    validateGraph(false);
    validateGraph(true);
    for (const task of data.tasks) {
      if (!projects.has(task.projectId)) invalid('Task project does not exist');
      const attempt = task.currentAttemptId ? attempts.get(task.currentAttemptId) : undefined;
      if (task.currentAttemptId && (!attempt || attempt.taskId !== task.id))
        invalid('Task has invalid current attempt');
      if (['running', 'review', 'done'].includes(task.status)) {
        const wanted = { running: 'active', review: 'submitted', done: 'accepted' }[
          task.status as 'running' | 'review' | 'done'
        ];
        if (!attempt || attempt.status !== wanted)
          invalid('Task status does not match current attempt');
        if (task.dependencies.some((id) => tasks.get(id)?.status !== 'done'))
          invalid('Active or completed task has incomplete dependencies');
      } else if (task.currentAttemptId !== null)
        invalid('Inactive task cannot have current attempt');
      if ((task.status === 'blocked') !== (task.blockedReason !== null))
        invalid('Blocked task reason is inconsistent');
    }
    for (const value of [...data.comments, ...data.sessions])
      if (!tasks.has(value.taskId)) invalid('Comment or session task does not exist');
    let lastEvent = 0;
    const hasSecretField = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      return Object.entries(value).some(
        ([key, child]) => /^(token|token_?hash|authorization)$/i.test(key) || hasSecretField(child),
      );
    };
    for (const event of data.events) {
      if (event.id <= lastEvent) invalid('Events must be ordered by increasing ID');
      lastEvent = event.id;
      if (event.projectId !== null && !projects.has(event.projectId))
        invalid('Event project does not exist');
      if (
        event.taskId !== null &&
        (!tasks.has(event.taskId) || tasks.get(event.taskId)?.projectId !== event.projectId)
      )
        invalid('Event task does not match project');
      if (hasSecretField(event.data)) invalid('Events cannot contain lease credentials');
    }
  }
}
