export type TaskStatus = 'ready' | 'running' | 'review' | 'done' | 'blocked' | 'cancelled';
export type Priority = 'low' | 'normal' | 'high';
export interface Actor {
  name: string;
  kind: 'human' | 'agent';
  provider?: string;
  sessionId?: string;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  repositoryUrl: string;
  createdAt: string;
}
export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: Priority;
  status: TaskStatus;
  dependencies: string[];
  version: number;
  currentAttemptId: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Attempt {
  id: string;
  taskId: string;
  number: number;
  agent: Actor;
  status: 'active' | 'submitted' | 'accepted' | 'rejected' | 'reclaimed' | 'cancelled' | 'blocked';
  startedAt: string;
  heartbeatAt: string;
  leaseUntil: string;
  endedAt: string | null;
}
export interface Evidence {
  label: string;
  uri: string;
  kind?: 'url' | 'file' | 'commit' | 'test' | 'other';
}
export interface Handoff {
  id: string;
  taskId: string;
  attemptId: string;
  summary: string;
  evidence: Evidence[];
  nextSteps: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  decision: 'pending' | 'accepted' | 'rejected';
}
export interface Comment {
  id: string;
  taskId: string;
  body: string;
  actor: Actor;
  createdAt: string;
}
export interface SessionRef {
  id: string;
  taskId: string;
  provider: string;
  sessionId: string;
  label: string;
  uri: string;
  createdAt: string;
}
export interface ActivityEvent {
  id: number;
  type: string;
  projectId: string | null;
  taskId: string | null;
  actor: Actor;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  attempts: Attempt[];
  handoffs: Handoff[];
  comments: Comment[];
  sessions: SessionRef[];
  events: ActivityEvent[];
  serverTime: string;
}
export interface ClaimResult {
  task: Task;
  attempt: Attempt;
  token: string;
}
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
export interface CommandEnvelope {
  command: string;
  input: Record<string, unknown>;
}
