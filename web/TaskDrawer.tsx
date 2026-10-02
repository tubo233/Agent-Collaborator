import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClaimResult, Handoff, Snapshot, Task } from '../src/shared/types.js';
import { HUMAN, safeUrl, type Ownership } from './api';
import {
  ClaimForm,
  FormError,
  ReasonForm,
  SessionForm,
  SubmitForm,
  TaskForm,
  type RunCommand,
} from './forms';
import {
  Empty,
  Icon,
  PriorityBadge,
  StatusBadge,
  formatDate,
  relativeTime,
  STATUS_LABEL,
} from './ui';

type Action =
  | 'claim'
  | 'submit'
  | 'accept'
  | 'reject'
  | 'block'
  | 'unblock'
  | 'cancel'
  | 'reclaim'
  | 'session'
  | 'edit'
  | null;
const ATTEMPT_LABEL: Record<string, string> = {
  active: '执行中',
  submitted: '已提交',
  accepted: '已验收',
  rejected: '已退回',
  reclaimed: '已回收',
  cancelled: '已取消',
  blocked: '已阻塞',
};
const EVENT_LABEL: Record<string, string> = {
  'project.create': '创建了项目',
  'task.create': '创建了任务',
  'task.update': '更新了任务',
  'task.claim': '领取了任务',
  'task.heartbeat': '续租了任务',
  'task.heartbeated': '续租了任务',
  'task.reclaim': '回收了过期任务',
  'task.submit': '提交了交接',
  'task.accept': '通过了验收',
  'task.reject': '退回了交接',
  'task.block': '标记了阻塞',
  'task.unblock': '解除了阻塞',
  'task.cancel': '取消了任务',
  'comment.add': '添加了评论',
  'session.link': '关联了会话',
};
export default function TaskDrawer({
  task,
  snapshot,
  ownership,
  busy,
  now,
  run,
  onClose,
  onClaimed,
  onOpenTask,
}: {
  task: Task;
  snapshot: Snapshot;
  ownership?: Ownership;
  busy: boolean;
  now: number;
  run: RunCommand;
  onClose: () => void;
  onClaimed: (claim: ClaimResult) => void;
  onOpenTask: (id: string) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'handoffs' | 'comments' | 'history'>('overview');
  const [action, setAction] = useState<Action>(null);
  const [actionVersion, setActionVersion] = useState(task.version);
  function openAction(next: Action) {
    setActionVersion(task.version);
    setAction(next);
  }
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const project = snapshot.projects.find((item) => item.id === task.projectId)!;
  const attempts = snapshot.attempts
    .filter((item) => item.taskId === task.id)
    .sort((a, b) => b.number - a.number);
  const currentAttempt = attempts.find((item) => item.id === task.currentAttemptId);
  const handoffs = snapshot.handoffs
    .filter((item) => item.taskId === task.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const comments = snapshot.comments
    .filter((item) => item.taskId === task.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sessions = snapshot.sessions.filter((item) => item.taskId === task.id);
  const events = snapshot.events
    .filter((item) => item.taskId === task.id)
    .sort((a, b) => b.id - a.id);
  const dependencies = task.dependencies
    .map((id) => snapshot.tasks.find((item) => item.id === id))
    .filter((item): item is Task => !!item);
  const unresolved = dependencies.filter((item) => item.status !== 'done');
  const isStale =
    task.status === 'running' && currentAttempt && Date.parse(currentAttempt.leaseUntil) <= now;
  const isOwned = !!ownership && ownership.attemptId === task.currentAttemptId;
  const isTerminal = ['done', 'cancelled'].includes(task.status);
  const base = { taskId: task.id, expectedVersion: actionVersion, actor: HUMAN };
  const credentials = ownership ? { attemptId: ownership.attemptId, token: ownership.token } : {};
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (action) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const items = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], textarea, input, select, [tabindex="0"]',
          ) || []),
        ].filter((item) => item.offsetParent !== null);
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        }
        if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [action, busy]);
  async function postComment(event: FormEvent) {
    event.preventDefault();
    setCommentError('');
    try {
      await run('comment.add', { taskId: task.id, body: comment.trim(), actor: HUMAN });
      setComment('');
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : '评论未能保存');
    }
  }
  const reasonConfig =
    action === 'accept'
      ? {
          title: '通过这次验收？',
          subtitle: '确认交付满足验收标准，任务将进入已完成。',
          label: '确认通过',
          command: 'task.accept',
          key: 'note',
          required: false,
        }
      : action === 'reject'
        ? {
            title: '退回修改',
            subtitle: '本次交接会保留记录，任务回到待领取。',
            label: '退回任务',
            command: 'task.reject',
            key: 'note',
            required: true,
          }
        : action === 'reclaim'
          ? {
              title: '回收过期任务',
              subtitle: '当前租约已过期。回收后，其他 Agent 可以重新领取。',
              label: '确认回收',
              command: 'task.reclaim',
              key: 'reason',
              required: true,
            }
          : action === 'block'
            ? {
                title: '标记任务阻塞',
                subtitle: '说明卡点，方便后续解决并恢复任务。',
                label: '标记阻塞',
                command: 'task.block',
                key: 'reason',
                required: true,
              }
            : action === 'cancel'
              ? {
                  title: '取消这项任务？',
                  subtitle: '任务与历史记录会保留，可在已取消列表中查看。',
                  label: '确认取消',
                  command: 'task.cancel',
                  key: 'reason',
                  required: true,
                }
              : action === 'unblock'
                ? {
                    title: '解除任务阻塞？',
                    subtitle: '确认卡点已解决。任务将回到待领取，等待重新分配。',
                    label: '解除阻塞',
                    command: 'task.unblock',
                    key: '',
                    required: false,
                  }
                : null;
  return (
    <>
      <div
        className="drawer-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !busy && !action) onClose();
        }}
        aria-hidden={action ? true : undefined}
      >
        <section
          className="task-drawer"
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby="task-detail-title"
        >
          <div className="drawer-top">
            <span className="drawer-breadcrumb">
              <Icon name="box" size={15} />
              {project.name}
              <Icon name="chevron" size={12} />
              <span className="mono">{task.id.slice(0, 12)}</span>
            </span>
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="关闭任务详情"
              disabled={busy}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="drawer-heading">
            <div className="task-badges">
              <StatusBadge status={task.status} />
              <PriorityBadge priority={task.priority} />
              <span className="version-label">v{task.version}</span>
            </div>
            <h2 id="task-detail-title">{task.title}</h2>
            <div className="task-dates">
              创建于 {formatDate(task.createdAt)}
              <span>·</span>更新于 {relativeTime(task.updatedAt)}
            </div>
          </div>
          <div className="drawer-tabs" role="tablist" aria-label="任务详情分类">
            {(
              [
                { id: 'overview', label: '概览' },
                { id: 'handoffs', label: '交接记录', count: handoffs.length },
                { id: 'comments', label: '讨论', count: comments.length },
                { id: 'history', label: '活动' },
              ] as const
            ).map((item) => (
              <button
                type="button"
                key={item.id}
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`panel-${item.id}`}
                id={`tab-${item.id}`}
                className={tab === item.id ? 'active' : ''}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                {'count' in item && item.count > 0 && <span>{item.count}</span>}
              </button>
            ))}
          </div>
          <div
            className="drawer-content"
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
          >
            {tab === 'overview' && (
              <>
                {task.blockedReason && (
                  <div className="warning-callout">
                    <Icon name="alert" />
                    <div>
                      <strong>当前阻塞</strong>
                      <p>{task.blockedReason}</p>
                    </div>
                  </div>
                )}
                {task.status === 'running' && currentAttempt && (
                  <div className={`owner-card ${isStale ? 'stale' : ''}`}>
                    <div className="owner-avatar">
                      <Icon name="robot" size={22} />
                    </div>
                    <div className="owner-info">
                      <strong>{currentAttempt.agent.name}</strong>
                      <span>
                        {currentAttempt.agent.provider || 'Agent'} · 第 {currentAttempt.number}{' '}
                        次执行
                      </span>
                    </div>
                    <span className={`lease-badge ${isStale ? 'expired' : ''}`}>
                      <Icon name="clock" size={13} />
                      {isStale
                        ? '租约已过期'
                        : `租约 ${Math.max(1, Math.ceil((Date.parse(currentAttempt.leaseUntil) - now) / 60000))} 分钟`}
                    </span>
                    <div className="owner-caption">
                      {isStale
                        ? '执行状态可能已失联，回收后可由其他 Agent 重新领取。'
                        : isOwned
                          ? '本页查看期间自动续租 · 每 60 秒 · 关闭详情后停止'
                          : '由外部会话持有执行凭证。可在这里查看进度与交接。'}
                    </div>
                  </div>
                )}
                {task.status === 'review' && (
                  <div className="info-callout">
                    <Icon name="check" />
                    <p>交接已提交。请查看交付证据和验收标准，再通过或退回。</p>
                    <button className="text-button" onClick={() => setTab('handoffs')}>
                      查看交接
                      <Icon name="arrow" size={14} />
                    </button>
                  </div>
                )}
                <section className="detail-section">
                  <div className="section-title">
                    <h3>任务描述</h3>
                    {['ready', 'blocked'].includes(task.status) && (
                      <button
                        className="text-button"
                        onClick={() => openAction('edit')}
                        disabled={busy}
                      >
                        编辑任务
                      </button>
                    )}
                  </div>
                  {task.description ? (
                    <p className="prose">{task.description}</p>
                  ) : (
                    <p className="muted">还没有补充描述</p>
                  )}
                </section>
                <section className="detail-section">
                  <h3>
                    <Icon name="check" size={16} />
                    验收标准
                  </h3>
                  {task.acceptanceCriteria ? (
                    <div className="criteria-box prose">{task.acceptanceCriteria}</div>
                  ) : (
                    <p className="muted">未设置验收标准</p>
                  )}
                </section>
                {(dependencies.length > 0 || task.parentId) && (
                  <section className="detail-section">
                    <h3>
                      <Icon name="branch" size={16} />
                      任务关系
                    </h3>
                    {task.parentId && (
                      <button className="related-task" onClick={() => onOpenTask(task.parentId!)}>
                        <span className="tiny-label">父任务</span>
                        <span>
                          {snapshot.tasks.find((item) => item.id === task.parentId)?.title ||
                            task.parentId}
                        </span>
                        <Icon name="chevron" size={14} />
                      </button>
                    )}
                    {dependencies.map((item) => (
                      <button
                        className="related-task"
                        key={item.id}
                        onClick={() => onOpenTask(item.id)}
                      >
                        <span className="tiny-label">依赖</span>
                        <span>{item.title}</span>
                        <StatusBadge status={item.status} />
                      </button>
                    ))}
                    {unresolved.length > 0 && (
                      <p className="field-hint">
                        还有 {unresolved.length} 项前置依赖未完成，暂不可领取。
                      </p>
                    )}
                  </section>
                )}
                <section className="detail-section">
                  <div className="section-title">
                    <h3>
                      <Icon name="link" size={16} />
                      关联会话 <span className="count-label">{sessions.length}</span>
                    </h3>
                    <button
                      className="text-button"
                      onClick={() => openAction('session')}
                      disabled={busy}
                    >
                      <Icon name="plus" size={14} />
                      关联
                    </button>
                  </div>
                  {sessions.length ? (
                    <div className="session-list">
                      {sessions.map((session) => {
                        const href = safeUrl(session.uri);
                        return (
                          <div className="session-item" key={session.id}>
                            <span className="session-icon">
                              <Icon name="robot" size={17} />
                            </span>
                            <div>
                              <strong>{session.label || session.provider}</strong>
                              <span className="mono">
                                {session.provider} · {session.sessionId}
                              </span>
                            </div>
                            {href && (
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="icon-button"
                                aria-label={`打开会话 ${session.label || session.provider}`}
                              >
                                <Icon name="external" size={15} />
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="muted">将 Agent 会话关联到任务，保留完整上下文。</p>
                  )}
                </section>
                <section className="detail-section execution-note">
                  <Icon name="layers" size={17} />
                  <p>这个工作台负责协调和交接。实际执行发生在你选择的 Agent 工具中。</p>
                </section>
              </>
            )}
            {tab === 'handoffs' &&
              (handoffs.length ? (
                <div className="handoff-list">
                  {handoffs.map((handoff, index) => (
                    <HandoffCard
                      key={handoff.id}
                      handoff={handoff}
                      number={attempts.find((item) => item.id === handoff.attemptId)?.number}
                      latest={index === 0}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  icon="file"
                  title="还没有交接记录"
                  description="Agent 完成工作后，提交摘要、交付证据和后续建议。"
                />
              ))}
            {tab === 'comments' && (
              <>
                <div className="comment-list">
                  {comments.length ? (
                    comments.map((item) => (
                      <article className="comment" key={item.id}>
                        <div className={`avatar ${item.actor.kind}`}>
                          <Icon
                            name={item.actor.kind === 'agent' ? 'robot' : 'comment'}
                            size={16}
                          />
                        </div>
                        <div className="comment-body">
                          <div className="comment-meta">
                            <strong>{item.actor.name}</strong>
                            <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                          </div>
                          <p className="prose">{item.body}</p>
                        </div>
                      </article>
                    ))
                  ) : (
                    <Empty
                      icon="comment"
                      title="从一句话开始协作"
                      description="补充上下文、提出问题，或留下执行中的发现。"
                    />
                  )}
                </div>
                <form onSubmit={postComment} className="comment-form">
                  <label className="sr-only" htmlFor="task-comment">
                    添加评论
                  </label>
                  <textarea
                    id="task-comment"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="写下评论或补充上下文…"
                    rows={3}
                    maxLength={10000}
                    required
                  />
                  <FormError error={commentError} />
                  <div className="comment-actions">
                    <span>以本机用户身份发布</span>
                    <button
                      type="submit"
                      className="button primary small"
                      disabled={busy || !comment.trim()}
                    >
                      {busy ? '正在保存…' : '发布评论'}
                      <Icon name="arrow" size={14} />
                    </button>
                  </div>
                </form>
              </>
            )}
            {tab === 'history' && (
              <>
                <section className="detail-section">
                  <h3>
                    执行尝试 <span className="count-label">{attempts.length}</span>
                  </h3>
                  {attempts.length ? (
                    <div className="attempt-list">
                      {attempts.map((attempt) => (
                        <article className="attempt-item" key={attempt.id}>
                          <span className="attempt-number">
                            {String(attempt.number).padStart(2, '0')}
                          </span>
                          <div>
                            <strong>{attempt.agent.name}</strong>
                            <p>
                              {attempt.agent.provider || 'Agent'} · {formatDate(attempt.startedAt)}
                            </p>
                            <small>
                              最后心跳 {formatDate(attempt.heartbeatAt)}
                              {attempt.endedAt
                                ? ` · 结束 ${formatDate(attempt.endedAt)}`
                                : ` · 租约至 ${formatDate(attempt.leaseUntil)}`}
                            </small>
                          </div>
                          <span className={`attempt-status ${attempt.status}`}>
                            {ATTEMPT_LABEL[attempt.status] || attempt.status}
                          </span>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">尚无执行记录</p>
                  )}
                </section>
                <section className="detail-section">
                  <h3>活动时间线</h3>
                  <div className="timeline">
                    {events.map((event) => (
                      <div className="timeline-item" key={event.id}>
                        <span className="timeline-dot" />
                        <div>
                          <p>
                            <strong>{event.actor.name}</strong>{' '}
                            {EVENT_LABEL[event.type] || event.type}
                          </p>
                          <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                        </div>
                      </div>
                    ))}
                    {events.length === 0 && <p className="muted">尚无活动</p>}
                  </div>
                </section>
              </>
            )}
          </div>
          <footer className="drawer-footer">
            <div className="secondary-actions">
              {!isTerminal && (
                <button
                  className="text-button danger-text"
                  onClick={() => openAction('cancel')}
                  disabled={busy}
                >
                  取消任务
                </button>
              )}
              {(task.status === 'ready' || (task.status === 'running' && isOwned && !isStale)) && (
                <button
                  className="button secondary small"
                  onClick={() => openAction('block')}
                  disabled={busy}
                >
                  标记阻塞
                </button>
              )}
            </div>
            <div className="primary-actions">
              {task.status === 'ready' && (
                <button
                  className="button primary"
                  onClick={() => openAction('claim')}
                  disabled={busy || unresolved.length > 0}
                  title={unresolved.length ? '请先完成前置依赖' : undefined}
                >
                  <Icon name="play" size={15} />
                  领取任务
                </button>
              )}
              {task.status === 'running' &&
                (isStale ? (
                  <button
                    className="button warning"
                    onClick={() => openAction('reclaim')}
                    disabled={busy}
                  >
                    <Icon name="refresh" size={15} />
                    回收任务
                  </button>
                ) : isOwned ? (
                  <button
                    className="button primary"
                    onClick={() => openAction('submit')}
                    disabled={busy}
                  >
                    提交交接
                    <Icon name="arrow" size={15} />
                  </button>
                ) : (
                  <span className="footer-note">
                    <Icon name="clock" size={15} />
                    等待执行者提交
                  </span>
                ))}
              {task.status === 'review' && (
                <>
                  <button
                    className="button secondary"
                    onClick={() => openAction('reject')}
                    disabled={busy}
                  >
                    退回修改
                  </button>
                  <button
                    className="button primary"
                    onClick={() => openAction('accept')}
                    disabled={busy}
                  >
                    <Icon name="check" size={16} />
                    通过验收
                  </button>
                </>
              )}
              {task.status === 'blocked' && (
                <button
                  className="button primary"
                  onClick={() => openAction('unblock')}
                  disabled={busy}
                >
                  解除阻塞
                </button>
              )}
              {isTerminal && (
                <span className="footer-note">
                  <Icon name={task.status === 'done' ? 'check' : 'box'} size={16} />
                  {STATUS_LABEL[task.status]} · 历史记录已保留
                </span>
              )}
            </div>
          </footer>
        </section>
      </div>
      {action === 'claim' && (
        <ClaimForm
          task={task}
          run={run}
          busy={busy}
          onClose={() => setAction(null)}
          onClaimed={onClaimed}
        />
      )}
      {action === 'submit' && (
        <SubmitForm
          task={task}
          busy={busy}
          onClose={() => setAction(null)}
          onSubmit={async (input) => {
            await run('task.submit', {
              taskId: task.id,
              expectedVersion: actionVersion,
              ...credentials,
              ...input,
            });
            setTab('handoffs');
          }}
        />
      )}
      {action === 'session' && (
        <SessionForm task={task} run={run} busy={busy} onClose={() => setAction(null)} />
      )}
      {action === 'edit' && (
        <TaskForm
          task={task}
          project={project}
          tasks={snapshot.tasks.filter((item) => item.projectId === project.id)}
          run={run}
          busy={busy}
          onClose={() => setAction(null)}
        />
      )}
      {reasonConfig && (
        <ReasonForm
          title={reasonConfig.title}
          subtitle={reasonConfig.subtitle}
          label={reasonConfig.label}
          required={reasonConfig.required}
          danger={action === 'cancel'}
          busy={busy}
          onClose={() => setAction(null)}
          onSubmit={async (note) => {
            await run(reasonConfig.command, {
              ...base,
              ...(reasonConfig.key ? { [reasonConfig.key]: note } : {}),
              ...(action === 'block' && task.status === 'running' ? credentials : {}),
            });
          }}
        />
      )}
    </>
  );
}
function HandoffCard({
  handoff,
  number,
  latest,
}: {
  handoff: Handoff;
  number?: number;
  latest: boolean;
}) {
  return (
    <article className="handoff-card">
      <div className="handoff-header">
        <div>
          <span className="eyebrow">
            HANDOFF {number ? `#${String(number).padStart(2, '0')}` : ''}
          </span>
          <h3>{latest ? '最近一次交接' : '历史交接'}</h3>
        </div>
        <span className={`handoff-decision ${handoff.decision}`}>
          {handoff.decision === 'pending'
            ? '等待验收'
            : handoff.decision === 'accepted'
              ? '验收通过'
              : '已退回'}
        </span>
      </div>
      <time className="muted small-text" dateTime={handoff.createdAt}>
        {formatDate(handoff.createdAt)}
      </time>
      <h4>完成摘要</h4>
      <p className="prose">{handoff.summary}</p>
      {handoff.evidence.length > 0 && (
        <>
          <h4>交付证据</h4>
          <div className="evidence-list">
            {handoff.evidence.map((item, index) => {
              const href = safeUrl(item.uri);
              return (
                <div className="evidence-item" key={index}>
                  <Icon name="file" size={17} />
                  <div>
                    <strong>{item.label}</strong>
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer noopener">
                        {item.uri}
                        <Icon name="external" size={12} />
                      </a>
                    ) : (
                      <span className="mono">{item.uri}</span>
                    )}
                  </div>
                  <span className="tiny-label">{item.kind || 'other'}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {handoff.nextSteps && (
        <>
          <h4>后续建议</h4>
          <p className="prose">{handoff.nextSteps}</p>
        </>
      )}
      {handoff.decision !== 'pending' && (
        <div className="review-note">
          <Icon name={handoff.decision === 'accepted' ? 'check' : 'refresh'} size={17} />
          <div>
            <strong>{handoff.decision === 'accepted' ? '验收通过' : '退回意见'}</strong>
            {handoff.reviewNote && <p className="prose">{handoff.reviewNote}</p>}
            {handoff.reviewedAt && <time>{formatDate(handoff.reviewedAt)}</time>}
          </div>
        </div>
      )}
    </article>
  );
}
