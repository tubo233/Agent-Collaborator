import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClaimResult, Priority, Project, Task } from '../src/shared/types.js';
import { HUMAN, safeUrl } from './api';
import { Dialog, Field, FormActions, Icon, STATUS_LABEL } from './ui';

export type RunCommand = <T = unknown>(
  command: string,
  input: Record<string, unknown>,
) => Promise<T>;
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}
export function FormError({ error }: { error: string }) {
  return error ? (
    <div className="inline-error" role="alert">
      <Icon name="alert" size={16} />
      {error}
    </div>
  ) : null;
}

export function ProjectForm({
  run,
  onClose,
  onCreated,
  busy,
}: {
  run: RunCommand;
  onClose: () => void;
  onCreated: (id: string) => void;
  busy: boolean;
}) {
  const mounted = useMounted();
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (repositoryUrl.trim() && !safeUrl(repositoryUrl.trim())) {
      setError('仓库地址需要是有效的 http 或 https 链接');
      return;
    }
    try {
      const project = await run<Project>('project.create', {
        name: name.trim(),
        description: description.trim(),
        repositoryUrl: repositoryUrl.trim(),
        actor: HUMAN,
      });
      if (mounted.current) onCreated(project.id);
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  }
  return (
    <Dialog
      title="建立一个新项目"
      subtitle="把目标、任务和每一次交接放在一起。"
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="modal-form">
        <Field label="项目名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：个人网站重构"
            required
            maxLength={200}
            autoFocus
          />
        </Field>
        <Field label="项目说明" optional>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这个项目想实现什么？"
            rows={3}
            maxLength={50000}
          />
        </Field>
        <Field label="代码仓库" optional hint="仅用于关联项目，不会读取仓库或启动任何 Agent">
          <input
            type="url"
            value={repositoryUrl}
            onChange={(e) => setRepositoryUrl(e.target.value)}
            placeholder="https://github.com/you/project"
            maxLength={4000}
          />
        </Field>
        <FormError error={error} />
        <FormActions onClose={onClose} busy={busy} label="创建项目" />
      </form>
    </Dialog>
  );
}

export function TaskForm({
  project,
  tasks,
  task,
  run,
  onClose,
  onCreated,
  busy,
}: {
  project: Project;
  tasks: Task[];
  task?: Task;
  run: RunCommand;
  onClose: () => void;
  onCreated?: (id: string) => void;
  busy: boolean;
}) {
  const expectedVersion = useRef(task?.version);
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(task?.acceptanceCriteria || '');
  const [priority, setPriority] = useState<Priority>(task?.priority || 'normal');
  const [dependencies, setDependencies] = useState<string[]>(task?.dependencies || []);
  const [parentId, setParentId] = useState(task?.parentId || '');
  const mounted = useMounted();
  const [error, setError] = useState('');
  const choices = tasks.filter((item) => item.id !== task?.id);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const values = {
      title: title.trim(),
      description: description.trim(),
      acceptanceCriteria: acceptanceCriteria.trim(),
      priority,
      dependencies,
    };
    try {
      const result = await run<Task>(
        task ? 'task.update' : 'task.create',
        task
          ? {
              taskId: task.id,
              expectedVersion: expectedVersion.current,
              patch: values,
              actor: HUMAN,
            }
          : { projectId: project.id, ...values, ...(parentId ? { parentId } : {}), actor: HUMAN },
      );
      if (mounted.current) {
        onCreated?.(result.id);
        onClose();
      }
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  }
  return (
    <Dialog
      title={task ? '编辑任务' : '创建一个清晰的任务'}
      subtitle={`${project.name} · 明确目标，让下一位接手时无需猜测。`}
      onClose={onClose}
      busy={busy}
      wide
    >
      <form onSubmit={submit} className="modal-form">
        <Field label="任务标题">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="用一句话描述要完成的工作"
            required
            maxLength={200}
            autoFocus
          />
        </Field>
        <Field label="任务描述" optional>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="背景、范围，以及需要了解的上下文…"
            rows={3}
            maxLength={50000}
          />
        </Field>
        <Field label="验收标准" optional hint="建议写下可验证的结果，而不只是操作步骤">
          <textarea
            value={acceptanceCriteria}
            onChange={(e) => setAcceptanceCriteria(e.target.value)}
            placeholder="例如：测试通过；移动端布局正常；附上验证结果"
            rows={3}
            maxLength={50000}
          />
        </Field>
        <div className="form-grid">
          <Field label="优先级">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="normal">普通</option>
              <option value="high">高优先</option>
              <option value="low">低优先</option>
            </select>
          </Field>
          {!task && (
            <Field label="父任务" optional>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">独立任务</option>
                {choices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {choices.length > 0 && (
          <fieldset className="dependency-field">
            <legend>
              前置依赖 <small>可选 · 依赖全部完成后才能领取</small>
            </legend>
            <div className="dependency-choices">
              {choices.map((item) => (
                <label key={item.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={dependencies.includes(item.id)}
                    onChange={(e) =>
                      setDependencies((current) =>
                        e.target.checked
                          ? [...current, item.id]
                          : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span>{item.title}</span>
                  <small>{STATUS_LABEL[item.status]}</small>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <FormError error={error} />
        <FormActions onClose={onClose} busy={busy} label={task ? '保存修改' : '创建任务'} />
      </form>
    </Dialog>
  );
}

export function ClaimForm({
  task,
  run,
  onClose,
  onClaimed,
  busy,
}: {
  task: Task;
  run: RunCommand;
  onClose: () => void;
  onClaimed: (claim: ClaimResult) => void;
  busy: boolean;
}) {
  const expectedVersion = useRef(task.version);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [sessionId, setSessionId] = useState('');
  const mounted = useMounted();
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const claim = await run<ClaimResult>('task.claim', {
        taskId: task.id,
        expectedVersion: expectedVersion.current,
        agent: {
          name: name.trim(),
          kind: 'agent',
          ...(provider.trim() ? { provider: provider.trim() } : {}),
          ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
        },
        leaseSeconds: 300,
      });
      if (mounted.current) {
        onClaimed(claim);
        onClose();
      }
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  }
  return (
    <Dialog title="为 Agent 领取任务" subtitle={task.title} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="modal-form">
        <div className="info-callout">
          <Icon name="robot" />
          <p>
            这里是人工登记领取，不会启动 Agent，也不会把凭证传给外部会话。若希望 Agent
            自己续租和提交，请让它通过 MCP 或 CLI 领取。
          </p>
        </div>
        <Field label="Agent 名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Claude · 前端开发"
            required
            maxLength={200}
          />
        </Field>
        <div className="form-grid">
          <Field label="Provider" optional>
            <input
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="claude / codex / other"
              maxLength={200}
            />
          </Field>
          <Field label="会话 ID" optional>
            <input
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="关联现有会话"
              maxLength={200}
            />
          </Field>
        </div>
        <p className="field-hint">
          初始租约为 5 分钟。在此浏览器打开任务详情时，每 60
          秒自动续租；关闭详情后停止续租。领取凭证仅保存在当前标签页。
        </p>
        <FormError error={error} />
        <FormActions onClose={onClose} busy={busy} label="确认领取" />
      </form>
    </Dialog>
  );
}

export function ReasonForm({
  title,
  subtitle,
  label,
  initial = '',
  required = true,
  danger = false,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  subtitle?: string;
  label: string;
  initial?: string;
  required?: boolean;
  danger?: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState(initial);
  const mounted = useMounted();
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await onSubmit(note.trim());
      if (mounted.current) onClose();
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  }
  return (
    <Dialog title={title} subtitle={subtitle} onClose={onClose} busy={busy}>
      <form className="modal-form" onSubmit={submit}>
        <Field label="说明" optional={!required}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={required ? '请说明原因，帮助下一位接手者了解情况…' : '可以留下验收意见…'}
            required={required}
            rows={4}
            maxLength={10000}
          />
        </Field>
        <FormError error={error} />
        <FormActions busy={busy} onClose={onClose} label={label} danger={danger} />
      </form>
    </Dialog>
  );
}

export function SubmitForm({
  task,
  busy,
  onClose,
  onSubmit,
}: {
  task: Task;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: {
    summary: string;
    evidence: { label: string; uri: string; kind: 'url' | 'file' | 'commit' | 'test' | 'other' }[];
    nextSteps: string;
  }) => Promise<void>;
}) {
  const [summary, setSummary] = useState('');
  const [nextSteps, setNextSteps] = useState('');
  const [evidence, setEvidence] = useState<
    { label: string; uri: string; kind: 'url' | 'file' | 'commit' | 'test' | 'other' }[]
  >([{ label: '', uri: '', kind: 'url' }]);
  const mounted = useMounted();
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await onSubmit({
        summary: summary.trim(),
        evidence: evidence.map((item) => ({
          ...item,
          label: item.label.trim(),
          uri: item.uri.trim(),
        })),
        nextSteps: nextSteps.trim(),
      });
      if (mounted.current) onClose();
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  }
  return (
    <Dialog title="提交交接，等待验收" subtitle={task.title} busy={busy} onClose={onClose} wide>
      <form className="modal-form" onSubmit={submit}>
        <Field label="完成摘要">
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="完成了什么？做了哪些验证？还有哪些需要关注？"
            required
            rows={4}
            maxLength={10000}
          />
        </Field>
        <fieldset className="evidence-field">
          <legend>
            交付证据 <small>至少一项 · 链接、文件路径或 commit</small>
          </legend>
          {evidence.map((item, index) => (
            <div className="evidence-form-row" key={index}>
              <input
                aria-label={`证据 ${index + 1} 名称`}
                placeholder="名称，例如：测试结果"
                required
                value={item.label}
                maxLength={200}
                onChange={(e) =>
                  setEvidence((items) =>
                    items.map((value, i) =>
                      i === index ? { ...value, label: e.target.value } : value,
                    ),
                  )
                }
              />
              <input
                aria-label={`证据 ${index + 1} 地址`}
                placeholder="链接、文件路径或 commit"
                required
                value={item.uri}
                maxLength={4000}
                onChange={(e) =>
                  setEvidence((items) =>
                    items.map((value, i) =>
                      i === index ? { ...value, uri: e.target.value } : value,
                    ),
                  )
                }
              />
              <select
                aria-label={`证据 ${index + 1} 类型`}
                value={item.kind}
                onChange={(e) =>
                  setEvidence((items) =>
                    items.map((value, i) =>
                      i === index ? { ...value, kind: e.target.value as typeof item.kind } : value,
                    ),
                  )
                }
              >
                <option value="url">链接</option>
                <option value="file">文件</option>
                <option value="commit">Commit</option>
                <option value="test">测试</option>
                <option value="other">其他</option>
              </select>
              <button
                type="button"
                className="icon-button"
                aria-label={`删除证据 ${index + 1}`}
                disabled={evidence.length === 1}
                onClick={() => setEvidence((items) => items.filter((_, i) => i !== index))}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
          <button
            className="text-button"
            type="button"
            disabled={evidence.length >= 100}
            onClick={() => setEvidence((items) => [...items, { label: '', uri: '', kind: 'url' }])}
          >
            <Icon name="plus" size={15} />
            添加证据
          </button>
        </fieldset>
        <Field label="后续建议" optional>
          <textarea
            value={nextSteps}
            onChange={(e) => setNextSteps(e.target.value)}
            placeholder="下一位接手者需要知道什么？"
            rows={2}
            maxLength={50000}
          />
        </Field>
        <FormError error={error} />
        <FormActions busy={busy} onClose={onClose} label="提交验收" />
      </form>
    </Dialog>
  );
}

export function SessionForm({
  task,
  run,
  busy,
  onClose,
}: {
  task: Task;
  run: RunCommand;
  busy: boolean;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [label, setLabel] = useState('');
  const [uri, setUri] = useState('');
  const mounted = useMounted();
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (uri.trim() && !safeUrl(uri.trim())) {
      setError('会话链接需要是有效的 http 或 https 地址');
      return;
    }
    try {
      await run('session.link', {
        taskId: task.id,
        provider: provider.trim(),
        sessionId: sessionId.trim(),
        label: label.trim(),
        uri: uri.trim(),
        actor: HUMAN,
      });
      if (mounted.current) onClose();
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  }
  return (
    <Dialog
      title="关联 Agent 会话"
      subtitle="保留上下文的入口，方便后续接手。"
      onClose={onClose}
      busy={busy}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Provider">
            <input
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="codex / claude"
              required
              maxLength={200}
            />
          </Field>
          <Field label="会话 ID">
            <input
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              required
              maxLength={200}
            />
          </Field>
        </div>
        <Field label="显示名称" optional>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例如：前端实现会话"
            maxLength={200}
          />
        </Field>
        <Field label="会话链接" optional>
          <input
            type="url"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="https://…"
            maxLength={4000}
          />
        </Field>
        <FormError error={error} />
        <FormActions busy={busy} onClose={onClose} label="关联会话" />
      </form>
    </Dialog>
  );
}
