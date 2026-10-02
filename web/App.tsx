import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClaimResult, Priority, Snapshot, Task, TaskStatus } from '../src/shared/types.js';
import {
  fetchSnapshot,
  readOwnership,
  RequestError,
  safeUrl,
  saveOwnership,
  sendCommand,
  type Ownership,
} from './api';
import { ProjectForm, TaskForm, type RunCommand } from './forms';
import TaskDrawer from './TaskDrawer';
import { Empty, Icon, PriorityBadge, STATUS_LABEL, formatDate, type IconName } from './ui';

const COLUMNS: { status: TaskStatus; icon: IconName; subtitle: string }[] = [
  { status: 'ready', icon: 'box', subtitle: '准备好，随时接手' },
  { status: 'running', icon: 'activity', subtitle: '专注推进中的工作' },
  { status: 'review', icon: 'check', subtitle: '交接完成，等待确认' },
  { status: 'done', icon: 'check', subtitle: '每一步都留下成果' },
  { status: 'blocked', icon: 'alert', subtitle: '需要一点帮助' },
];
const SUCCESS_MESSAGES: Record<string, string> = {
  'project.create': '项目已创建',
  'task.create': '任务已创建',
  'task.update': '任务已更新',
  'task.claim': '领取成功，请在 Agent 工具中执行',
  'task.submit': '交接已提交，等待验收',
  'task.accept': '验收通过，任务已完成',
  'task.reject': '任务已退回，可重新领取',
  'task.reclaim': '任务已回收',
  'task.block': '已标记阻塞',
  'task.unblock': '阻塞已解除',
  'task.cancel': '任务已取消',
  'comment.add': '评论已发布',
  'session.link': '会话已关联',
};
function getLocation() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return { project: params.get('project') || '', task: params.get('task') || '' };
}
function updateLocation(project: string, task = '') {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  if (task) params.set('task', task);
  window.history.pushState(null, '', `#${params}`);
}

export default function App() {
  const initial = useRef(getLocation());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [projectId, setProjectId] = useState(initial.current.project);
  const [taskId, setTaskId] = useState(initial.current.task);
  const [modal, setModal] = useState<'project' | 'task' | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState<'all' | Priority>('all');
  const [showCancelled, setShowCancelled] = useState(false);
  const [ownership, setOwnership] = useState<Record<string, Ownership>>(readOwnership);
  const [now, setNow] = useState(Date.now());
  const clockOffset = useRef(0);
  const runningMutation = useRef(false);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);
  const project = snapshot?.projects.find((item) => item.id === projectId) || snapshot?.projects[0];
  const currentTask = snapshot?.tasks.find((item) => item.id === taskId);
  const projectTasks = snapshot?.tasks.filter((item) => item.projectId === project?.id) || [];
  const filtered = projectTasks.filter(
    (task) =>
      (!search.trim() ||
        `${task.title} ${task.description} ${task.id}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase())) &&
      (priority === 'all' || task.priority === priority),
  );
  const activeTasks = projectTasks.filter((task) => task.status !== 'cancelled');
  const completed = activeTasks.filter((task) => task.status === 'done').length;
  const progress = activeTasks.length ? Math.round((completed / activeTasks.length) * 100) : 0;

  const refresh = useCallback(async () => {
    if (refreshPromise.current) {
      refreshQueued.current = true;
      return refreshPromise.current;
    }
    const request = (async () => {
      setRefreshing(true);
      do {
        refreshQueued.current = false;
        try {
          const next = await fetchSnapshot();
          clockOffset.current = Date.parse(next.serverTime) - Date.now();
          setNow(Date.now() + clockOffset.current);
          setSnapshot(next);
          setOwnership((previous) => {
            const valid = Object.fromEntries(
              Object.entries(previous).filter(([id, own]) =>
                next.tasks.some(
                  (task) =>
                    task.id === id &&
                    task.status === 'running' &&
                    task.currentAttemptId === own.attemptId,
                ),
              ),
            );
            if (Object.keys(valid).length === Object.keys(previous).length) return previous;
            saveOwnership(valid);
            return valid;
          });
        } catch (e) {
          setError(
            e instanceof Error
              ? `无法同步数据：${e.message}`
              : '无法连接本地服务，请确认 daemon 正在运行',
          );
        } finally {
          setInitialLoaded(true);
        }
      } while (refreshQueued.current);
      setRefreshing(false);
    })();
    refreshPromise.current = request;
    try {
      await request;
    } finally {
      refreshPromise.current = null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stream = new EventSource('/api/events');
    stream.onopen = () => {
      setConnection('live');
      void refresh();
    };
    stream.addEventListener('change', () => {
      void refresh();
    });
    stream.addEventListener('hello', () => {
      setConnection('live');
      void refresh();
    });
    stream.onerror = () => setConnection('offline');
    const timer = window.setInterval(() => {
      void refresh();
    }, 30000);
    const clock = window.setInterval(() => setNow(Date.now() + clockOffset.current), 10000);
    const locationChanged = () => {
      const next = getLocation();
      setProjectId(next.project);
      setTaskId(next.task);
      setModal(null);
    };
    window.addEventListener('popstate', locationChanged);
    window.addEventListener('hashchange', locationChanged);
    return () => {
      stream.close();
      window.clearInterval(timer);
      window.clearInterval(clock);
      window.removeEventListener('popstate', locationChanged);
      window.removeEventListener('hashchange', locationChanged);
    };
  }, [refresh]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const owned = currentTask ? ownership[currentTask.id] : undefined;
  useEffect(() => {
    if (
      !currentTask ||
      currentTask.status !== 'running' ||
      !owned ||
      currentTask.currentAttemptId !== owned.attemptId
    )
      return;
    const id = currentTask.id;
    let stopped = false;
    let sending = false;
    const timer = window.setInterval(async () => {
      if (sending || stopped) return;
      sending = true;
      try {
        await sendCommand('task.heartbeat', { taskId: id, ...owned, leaseSeconds: 300 });
        if (!stopped) void refresh();
      } catch (e) {
        if (!stopped) {
          setError(`自动续租失败：${e instanceof Error ? e.message : '请检查本地服务'}`);
          if (e instanceof RequestError && [400, 403, 409].includes(e.status)) {
            setOwnership((previous) => {
              const next = { ...previous };
              delete next[id];
              saveOwnership(next);
              return next;
            });
            void refresh();
          }
        }
      } finally {
        sending = false;
      }
    }, 60000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [currentTask?.id, currentTask?.status, currentTask?.currentAttemptId, owned, refresh]);

  const run: RunCommand = async <T,>(
    command: string,
    input: Record<string, unknown>,
  ): Promise<T> => {
    if (runningMutation.current) throw new Error('上一项操作正在保存，请稍候');
    runningMutation.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await sendCommand<T>(command, input);
      await refresh();
      setToast(SUCCESS_MESSAGES[command] || '已保存');
      return result;
    } catch (e) {
      if (e instanceof RequestError && e.status === 409) {
        await refresh();
        setError(`数据已同步：${e.message}。请关闭当前弹窗，检查最新状态后重新打开再试。`);
      } else setError(e instanceof Error ? e.message : '操作失败，请重试');
      throw e;
    } finally {
      runningMutation.current = false;
      setBusy(false);
    }
  };
  function chooseProject(id: string) {
    setProjectId(id);
    setTaskId('');
    setSearch('');
    setPriority('all');
    setShowCancelled(false);
    setSidebarOpen(false);
    updateLocation(id);
  }
  function openTask(id: string) {
    const next = snapshot?.tasks.find((item) => item.id === id);
    if (!next) return;
    setProjectId(next.projectId);
    setTaskId(id);
    updateLocation(next.projectId, id);
  }
  function closeTask() {
    setTaskId('');
    updateLocation(project?.id || '');
  }
  function claimed(claim: ClaimResult) {
    setOwnership((previous) => {
      const next = {
        ...previous,
        [claim.task.id]: { attemptId: claim.attempt.id, token: claim.token },
      };
      saveOwnership(next);
      return next;
    });
  }
  const counts = Object.fromEntries(
    COLUMNS.map(({ status }) => [
      status,
      projectTasks.filter((task) => task.status === status).length,
    ]),
  );
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="项目导航">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            closeTask();
            setSidebarOpen(false);
          }}
        >
          <span className="brand-symbol">
            <svg width="25" height="25" viewBox="0 0 40 40" fill="none" aria-hidden="true">
              <path
                d="M8 27 20 7l12 20M13 19h14M8 33h24"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>
            Agent
            <br />
            <strong>
              Collaborator<span className="brand-period">.</span>
            </strong>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-mark">L</span>
          <div>
            <strong>本地工作空间</strong>
            <span>LOCAL WORKSPACE</span>
          </div>
          <span className="version-pill">v0.1</span>
        </div>
        <div className="sidebar-section-heading">
          <span>我的项目</span>
          <button
            className="icon-button"
            aria-label="创建项目"
            onClick={() => {
              setModal('project');
              setSidebarOpen(false);
            }}
          >
            <Icon name="plus" size={17} />
          </button>
        </div>
        <nav className="project-list">
          {snapshot?.projects.map((item, index) => (
            <button
              className={`project-nav ${project?.id === item.id ? 'selected' : ''}`}
              key={item.id}
              onClick={() => chooseProject(item.id)}
            >
              <span className={`project-symbol tone-${index % 4}`}>
                <Icon name="box" size={16} />
              </span>
              <span className="project-nav-name">{item.name}</span>
              <span className="project-nav-count">
                {
                  snapshot.tasks.filter(
                    (task) =>
                      task.projectId === item.id && !['done', 'cancelled'].includes(task.status),
                  ).length
                }
              </span>
            </button>
          ))}
          {initialLoaded && !snapshot?.projects.length && (
            <p className="sidebar-empty">好的协作，从一个项目开始。</p>
          )}
        </nav>
        <button
          className="new-project-button"
          onClick={() => {
            setModal('project');
            setSidebarOpen(false);
          }}
        >
          <Icon name="plus" size={16} />
          新建项目
        </button>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="local-note-icon">
              <Icon name="layers" size={20} />
            </span>
            <strong>让每一次接力有迹可循</strong>
            <p>
              Agent 自由选择
              <br />
              上下文留在你手中
            </p>
          </div>
          <div className="daemon-status">
            <span className={`connection-dot ${connection}`} />
            <div>
              <strong>
                {connection === 'live'
                  ? '本地服务已连接'
                  : connection === 'connecting'
                    ? '正在连接本地服务'
                    : '正在重新连接'}
              </strong>
              <span>LOCAL-FIRST · PRIVATE BY DEFAULT</span>
            </div>
          </div>
        </div>
      </aside>
      <main className="main-workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="打开项目导航"
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <Icon name="grid" size={16} />
            <span>工作空间</span>
            <Icon name="chevron" size={12} />
            <strong>{project?.name || '开始协作'}</strong>
          </div>
          <div className="topbar-actions">
            <span className="live-label">
              <span className={`connection-dot ${connection}`} />
              {connection === 'live' ? '实时同步' : '等待连接'}
            </span>
            <button
              className="icon-button"
              onClick={() => {
                setError('');
                void refresh();
              }}
              disabled={refreshing}
              aria-label="刷新数据"
              title="刷新数据"
            >
              <Icon name="refresh" className={refreshing ? 'spinning' : ''} size={17} />
            </button>
            <a
              href="/api/export"
              className="icon-button"
              title="导出全部数据为 JSON"
              aria-label="导出全部数据为 JSON"
              download
            >
              <Icon name="download" size={17} />
            </a>
            <span className="topbar-divider" />
            <span className="user-avatar" title="本机用户">
              本
            </span>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <Icon name="alert" size={17} />
            <span>{error}</span>
            <button
              className="text-button"
              onClick={() => {
                setError('');
                void refresh();
              }}
            >
              重试
            </button>
            <button className="icon-button" onClick={() => setError('')} aria-label="关闭错误提示">
              <Icon name="close" size={15} />
            </button>
          </div>
        )}
        {connection === 'offline' && snapshot && (
          <div className="offline-banner" role="status">
            <Icon name="clock" size={15} />
            实时连接已断开，正在自动重连。当前显示上次同步的数据，每 30 秒尝试刷新。
          </div>
        )}
        {!initialLoaded ? (
          <div className="loading-state" role="status">
            <span className="spinner" />
            <h2>正在打开工作空间</h2>
            <p>从本地服务同步项目与任务…</p>
          </div>
        ) : !snapshot ? (
          <Empty
            icon="alert"
            title="暂时无法连接本地服务"
            description="请确认 Agent-Collaborator daemon 已启动，然后重试。"
            action={
              <button
                className="button primary"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                <Icon name="refresh" size={16} />
                重新连接
              </button>
            }
          />
        ) : !project ? (
          <Onboarding onCreate={() => setModal('project')} />
        ) : (
          <>
            <section className="project-header">
              <div className="project-title-row">
                <div>
                  <div className="eyebrow">
                    PROJECT OVERVIEW <span> / </span> 协作工作台
                  </div>
                  <h1>{project.name}</h1>
                  <p>{project.description || '把目标拆成清晰的任务，让每一位 Agent 有序接手。'}</p>
                </div>
                <button className="button primary create-task" onClick={() => setModal('task')}>
                  <Icon name="plus" size={17} />
                  新建任务
                </button>
              </div>
              <div className="project-meta">
                <span>
                  <Icon name="box" size={14} />
                  {activeTasks.length} 项任务
                </span>
                <span>
                  <Icon name="robot" size={15} />
                  {
                    new Set(
                      snapshot.attempts
                        .filter(
                          (attempt) =>
                            projectTasks.some((task) => task.id === attempt.taskId) &&
                            attempt.status === 'active',
                        )
                        .map((attempt) => attempt.agent.name),
                    ).size
                  }{' '}
                  位协作 Agent
                </span>
                {safeUrl(project.repositoryUrl) && (
                  <a
                    href={safeUrl(project.repositoryUrl)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <Icon name="branch" size={14} />
                    代码仓库
                    <Icon name="external" size={12} />
                  </a>
                )}
                <span className="manual-label">手动协作 · 不自动执行 Agent</span>
              </div>
              <div className="project-stats">
                <div className="stat-card">
                  <div>
                    <span className="stat-label">整体进度</span>
                    <strong>
                      {progress}
                      <small>%</small>
                    </strong>
                  </div>
                  <div className="progress-area">
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label="项目完成进度"
                      aria-valuenow={progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span style={{ width: `${progress}%` }} />
                    </div>
                    <span>
                      {completed} / {activeTasks.length} 已完成
                    </span>
                  </div>
                </div>
                <div className="stat-card">
                  <span className="stat-icon running">
                    <Icon name="activity" size={20} />
                  </span>
                  <div>
                    <span className="stat-label">正在推进</span>
                    <strong>
                      {counts.running}
                      <small>项任务</small>
                    </strong>
                  </div>
                </div>
                <div className="stat-card">
                  <span className="stat-icon review">
                    <Icon name="check" size={20} />
                  </span>
                  <div>
                    <span className="stat-label">等待验收</span>
                    <strong>
                      {counts.review}
                      <small>项交接</small>
                    </strong>
                  </div>
                </div>
                <div className="stat-card">
                  <span className="stat-icon blocked">
                    <Icon name="alert" size={19} />
                  </span>
                  <div>
                    <span className="stat-label">需要关注</span>
                    <strong>
                      {counts.blocked}
                      <small>项阻塞</small>
                    </strong>
                  </div>
                </div>
              </div>
            </section>
            <section className="board-section" aria-label="任务看板">
              <div className="board-toolbar">
                <div className="board-view">
                  <Icon name="grid" size={17} />
                  <strong>{showCancelled ? '已取消任务' : '任务看板'}</strong>
                  <span>
                    {showCancelled
                      ? filtered.filter((task) => task.status === 'cancelled').length
                      : filtered.filter((task) => task.status !== 'cancelled').length}
                  </span>
                </div>
                <div className="board-filters">
                  <div className="search-field">
                    <Icon name="search" size={16} />
                    <input
                      aria-label="搜索任务"
                      placeholder="搜索任务…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        className="icon-button"
                        aria-label="清除搜索"
                        onClick={() => setSearch('')}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </div>
                  <label className="filter-select">
                    <Icon name="settings" size={15} />
                    <select
                      aria-label="按优先级筛选"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as 'all' | Priority)}
                    >
                      <option value="all">全部优先级</option>
                      <option value="high">高优先</option>
                      <option value="normal">普通</option>
                      <option value="low">低优先</option>
                    </select>
                  </label>
                  <button
                    className={`button secondary small cancelled-filter ${showCancelled ? 'active' : ''}`}
                    aria-pressed={showCancelled}
                    onClick={() => setShowCancelled((value) => !value)}
                  >
                    {showCancelled ? '返回看板' : '已取消'}
                    {!showCancelled && projectTasks.some((task) => task.status === 'cancelled') && (
                      <span>
                        {projectTasks.filter((task) => task.status === 'cancelled').length}
                      </span>
                    )}
                  </button>
                </div>
              </div>
              {showCancelled ? (
                <div className="cancelled-list">
                  {filtered.some((task) => task.status === 'cancelled') ? (
                    filtered
                      .filter((task) => task.status === 'cancelled')
                      .map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          snapshot={snapshot}
                          now={now}
                          onClick={() => openTask(task.id)}
                        />
                      ))
                  ) : (
                    <Empty
                      icon="box"
                      title="没有已取消的任务"
                      description={
                        search || priority !== 'all'
                          ? '试试调整搜索或筛选条件'
                          : '取消后的任务与历史记录会保留在这里'
                      }
                    />
                  )}
                </div>
              ) : (
                <div className="board-columns">
                  {COLUMNS.map((column) => {
                    const tasks = filtered
                      .filter((task) => task.status === column.status)
                      .sort(
                        (a, b) =>
                          ({ high: 0, normal: 1, low: 2 })[a.priority] -
                            { high: 0, normal: 1, low: 2 }[b.priority] ||
                          b.updatedAt.localeCompare(a.updatedAt),
                      );
                    return (
                      <section
                        className={`board-column ${column.status}`}
                        key={column.status}
                        aria-label={STATUS_LABEL[column.status]}
                      >
                        <div className="column-header">
                          <span className="column-status-dot" />
                          <h2>{STATUS_LABEL[column.status]}</h2>
                          <span className="column-count">{tasks.length}</span>
                          {column.status === 'ready' && (
                            <button
                              className="icon-button"
                              title="新建任务"
                              aria-label="在待领取中创建任务"
                              onClick={() => setModal('task')}
                            >
                              <Icon name="plus" size={16} />
                            </button>
                          )}
                        </div>
                        <div className="column-content">
                          {tasks.length ? (
                            tasks.map((task) => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                snapshot={snapshot}
                                now={now}
                                onClick={() => openTask(task.id)}
                              />
                            ))
                          ) : (
                            <div className="column-empty">
                              <Icon name={column.icon} size={22} />
                              <span>
                                {search || priority !== 'all' ? '没有匹配的任务' : column.subtitle}
                              </span>
                              {column.status === 'ready' && !search && priority === 'all' && (
                                <button className="text-button" onClick={() => setModal('task')}>
                                  <Icon name="plus" size={13} />
                                  添加第一个任务
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
              <div className="board-footer">
                <span>
                  <span className="connection-dot live" />
                  所有改变都有记录，每一次交接都有上下文
                </span>
                <span>LOCAL WORKSPACE / V0.1</span>
              </div>
            </section>
          </>
        )}
      </main>
      {modal === 'project' && (
        <ProjectForm
          run={run}
          busy={busy}
          onClose={() => setModal(null)}
          onCreated={(id) => {
            chooseProject(id);
            setModal(null);
          }}
        />
      )}
      {modal === 'task' && project && (
        <TaskForm
          project={project}
          tasks={projectTasks}
          run={run}
          busy={busy}
          onClose={() => setModal(null)}
          onCreated={(id) => {
            setTaskId(id);
            updateLocation(project.id, id);
          }}
        />
      )}
      {currentTask && snapshot && (
        <TaskDrawer
          key={currentTask.id}
          task={currentTask}
          snapshot={snapshot}
          busy={busy}
          now={now}
          ownership={owned}
          run={run}
          onClose={closeTask}
          onClaimed={claimed}
          onOpenTask={openTask}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>
            <Icon name="check" size={16} />
          </span>
          {toast}
          <button className="icon-button" onClick={() => setToast('')} aria-label="关闭成功提示">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function Onboarding({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="onboarding">
      <div className="onboarding-label">
        <span className="connection-dot live" />
        你的本地协作空间，准备就绪
      </div>
      <h1>
        让不同的 Agent，
        <br />
        朝同一个目标前进<span>。</span>
      </h1>
      <p className="onboarding-intro">
        一个轻量的任务工作台，连接目标、执行与交接。
        <br />
        你选择工具，Agent 专注执行，协作过程清晰可见。
      </p>
      <button className="button primary large" onClick={onCreate}>
        <Icon name="plus" size={18} />
        创建第一个项目
        <Icon name="arrow" size={17} />
      </button>
      <div className="onboarding-steps">
        <article>
          <span className="step-number">01</span>
          <span className="step-icon">
            <Icon name="box" size={24} />
          </span>
          <h2>明确目标</h2>
          <p>
            建立项目，拆解任务
            <br />
            写下清晰的验收标准
          </p>
        </article>
        <span className="step-connector">
          <Icon name="arrow" />
        </span>
        <article>
          <span className="step-number">02</span>
          <span className="step-icon">
            <Icon name="robot" size={24} />
          </span>
          <h2>自由协作</h2>
          <p>
            Agent 领取任务与租约
            <br />
            在你选择的工具中执行
          </p>
        </article>
        <span className="step-connector">
          <Icon name="arrow" />
        </span>
        <article>
          <span className="step-number">03</span>
          <span className="step-icon">
            <Icon name="check" size={24} />
          </span>
          <h2>有序交接</h2>
          <p>
            提交成果与验证证据
            <br />
            验收后，继续下一步
          </p>
        </article>
      </div>
      <div className="onboarding-footnote">
        <Icon name="layers" size={16} />
        <span>本地优先 · Agent 中立 · 不自动启动或调度 Agent</span>
      </div>
    </section>
  );
}
function TaskCard({
  task,
  snapshot,
  now,
  onClick,
}: {
  task: Task;
  snapshot: Snapshot;
  now: number;
  onClick: () => void;
}) {
  const attempt = snapshot.attempts.find((item) => item.id === task.currentAttemptId);
  const comments = snapshot.comments.filter((item) => item.taskId === task.id).length;
  const unresolved = task.dependencies.filter(
    (id) => snapshot.tasks.find((item) => item.id === id)?.status !== 'done',
  ).length;
  const stale = task.status === 'running' && attempt && Date.parse(attempt.leaseUntil) <= now;
  return (
    <button className={`task-card ${task.status}`} onClick={onClick}>
      <div className="task-card-top">
        <span className="task-card-id mono">{task.id.slice(0, 10)}</span>
        <PriorityBadge priority={task.priority} />
      </div>
      <h3>{task.title}</h3>
      {task.description && <p className="card-description">{task.description}</p>}
      {task.blockedReason && (
        <div className="card-blocked">
          <Icon name="alert" size={13} />
          <span>{task.blockedReason}</span>
        </div>
      )}
      {unresolved > 0 && (
        <span className="dependency-chip">
          <Icon name="branch" size={12} />
          {unresolved} 项依赖未完成
        </span>
      )}
      {stale && (
        <span className="stale-chip">
          <Icon name="clock" size={12} />
          租约已过期 · 可回收
        </span>
      )}
      <div className="task-card-bottom">
        {attempt ? (
          <span className="card-owner">
            <span className={`mini-avatar ${task.status}`}>
              <Icon name="robot" size={12} />
            </span>
            <span>{attempt.agent.name}</span>
          </span>
        ) : (
          <span className="unassigned">
            <span />
            等待领取
          </span>
        )}
        <div className="card-indicators">
          {comments > 0 && (
            <span title={`${comments} 条评论`}>
              <Icon name="comment" size={12} />
              {comments}
            </span>
          )}
          <span>{formatDate(task.updatedAt, true)}</span>
        </div>
      </div>
    </button>
  );
}
