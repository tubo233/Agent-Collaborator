import { z } from 'zod';

const id = z.string().min(1).max(200);
const text = z.string().max(50_000);
const name = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(1).max(10_000);
const timestamp = z.iso.datetime();
// References are inert metadata. Never open, read, execute, or resolve local paths.
const reference = z
  .string()
  .trim()
  .max(4000)
  .refine((value) => {
    if (
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return false;
    if (/^[A-Za-z]:[\\/]/.test(value)) return true; // Windows path
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1].toLowerCase();
    if (!scheme) return true;
    if (!['http', 'https', 'file', 'codex', 'vscode', 'git', 'urn'].includes(scheme)) return false;
    if (scheme === 'http' || scheme === 'https') {
      try {
        const url = new URL(value);
        return Boolean(url.hostname) && !url.username && !url.password;
      } catch {
        return false;
      }
    }
    return true;
  }, 'Use a safe URL or inert file/commit reference');
export const actorSchema = z.strictObject({
  name,
  kind: z.enum(['human', 'agent']),
  provider: name.optional(),
  sessionId: id.optional(),
});
const human = actorSchema.refine((actor) => actor.kind === 'human', 'A human actor is required');
const agent = actorSchema.refine((actor) => actor.kind === 'agent', 'An agent actor is required');
const optionalActor = actorSchema.optional();
const expectedVersion = z.number().int().positive().safe();
const leaseSeconds = z.number().int().min(30).max(3600).optional();
export const evidenceSchema = z.strictObject({
  label: name,
  uri: reference.refine((value) => value.length > 0, 'A reference is required'),
  kind: z.enum(['url', 'file', 'commit', 'test', 'other']).optional(),
});
const dependencies = z
  .array(id)
  .max(1000)
  .refine((items) => new Set(items).size === items.length, 'Dependencies must be unique');
const priority = z.enum(['low', 'normal', 'high']);
const taskVersion = { taskId: id, expectedVersion };
const credentials = { attemptId: id, token: z.string().min(16).max(200) };
const patch = z
  .strictObject({
    title: name.optional(),
    description: text.optional(),
    acceptanceCriteria: text.optional(),
    priority: priority.optional(),
    dependencies: dependencies.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const commandSchemas = {
  'project.create': z.strictObject({
    name,
    description: text.optional(),
    repositoryUrl: reference.optional(),
    actor: optionalActor,
  }),
  'task.create': z.strictObject({
    projectId: id,
    title: name,
    description: text.optional(),
    acceptanceCriteria: text.optional(),
    priority: priority.optional(),
    dependencies: dependencies.optional(),
    parentId: id.nullable().optional(),
    actor: optionalActor,
  }),
  'task.update': z.strictObject({ ...taskVersion, patch, actor: optionalActor }),
  'task.claim': z.strictObject({ ...taskVersion, agent, leaseSeconds }),
  'task.heartbeat': z.strictObject({ taskId: id, ...credentials, leaseSeconds }),
  'task.reclaim': z.strictObject({ ...taskVersion, reason, actor: human }),
  'task.submit': z.strictObject({
    ...taskVersion,
    ...credentials,
    summary: reason,
    evidence: z.array(evidenceSchema).min(1).max(100),
    nextSteps: text.optional(),
  }),
  'task.accept': z.strictObject({ ...taskVersion, actor: human, note: text.optional() }),
  'task.reject': z.strictObject({ ...taskVersion, actor: human, note: reason }),
  'task.block': z.strictObject({
    ...taskVersion,
    reason,
    attemptId: id.optional(),
    token: z.string().min(16).max(200).optional(),
    actor: optionalActor,
  }),
  'task.unblock': z.strictObject({ ...taskVersion, actor: actorSchema }),
  'task.cancel': z.strictObject({ ...taskVersion, actor: human, reason }),
  'comment.add': z.strictObject({ taskId: id, body: reason, actor: actorSchema }),
  'session.link': z.strictObject({
    taskId: id,
    provider: name,
    sessionId: id,
    label: z.string().max(200).optional(),
    uri: reference.optional(),
    actor: optionalActor,
  }),
} as const;

export const projectSchema = z.strictObject({
  id,
  name,
  description: text,
  repositoryUrl: reference,
  createdAt: timestamp,
});
export const taskSchema = z.strictObject({
  id,
  projectId: id,
  parentId: id.nullable(),
  title: name,
  description: text,
  acceptanceCriteria: text,
  priority,
  status: z.enum(['ready', 'running', 'review', 'done', 'blocked', 'cancelled']),
  dependencies,
  version: expectedVersion,
  currentAttemptId: id.nullable(),
  blockedReason: reason.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const attemptSchema = z.strictObject({
  id,
  taskId: id,
  number: expectedVersion,
  agent,
  status: z.enum([
    'active',
    'submitted',
    'accepted',
    'rejected',
    'reclaimed',
    'cancelled',
    'blocked',
  ]),
  startedAt: timestamp,
  heartbeatAt: timestamp,
  leaseUntil: timestamp,
  endedAt: timestamp.nullable(),
});
export const handoffSchema = z.strictObject({
  id,
  taskId: id,
  attemptId: id,
  summary: reason,
  evidence: z.array(evidenceSchema).min(1).max(100),
  nextSteps: text,
  createdAt: timestamp,
  reviewedAt: timestamp.nullable(),
  reviewNote: text.nullable(),
  decision: z.enum(['pending', 'accepted', 'rejected']),
});
export const commentSchema = z.strictObject({
  id,
  taskId: id,
  body: reason,
  actor: actorSchema,
  createdAt: timestamp,
});
export const sessionSchema = z.strictObject({
  id,
  taskId: id,
  provider: name,
  sessionId: id,
  label: z.string().max(200),
  uri: reference,
  createdAt: timestamp,
});
export const eventSchema = z.strictObject({
  id: expectedVersion,
  type: name,
  projectId: id.nullable(),
  taskId: id.nullable(),
  actor: actorSchema,
  data: z.record(z.string(), z.json()),
  createdAt: timestamp,
});
export const snapshotSchema = z.strictObject({
  projects: z.array(projectSchema).max(100_000),
  tasks: z.array(taskSchema).max(100_000),
  attempts: z.array(attemptSchema).max(1_000_000),
  handoffs: z.array(handoffSchema).max(1_000_000),
  comments: z.array(commentSchema).max(1_000_000),
  sessions: z.array(sessionSchema).max(1_000_000),
  events: z.array(eventSchema).max(1_000_000),
  serverTime: timestamp,
});
export const backupSchema = z.strictObject({
  format: z.literal('agent-collaborator'),
  schemaVersion: z.literal(1),
  exportedAt: timestamp,
  data: snapshotSchema,
});
