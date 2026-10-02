/** DOM/component regression tests. These are not browser or visual-layout tests. */
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { Store } from '../src/core/store.js';
import { createApp } from '../src/server/http.js';
import type { Project, Snapshot, Task } from '../src/shared/types.js';
import type { RunCommand } from '../web/forms.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  sessionStorage: dom.window.sessionStorage,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
class TestEventSource extends dom.window.EventTarget {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private closed = false;
  constructor() {
    super();
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.();
    });
  }
  close() {
    this.closed = true;
  }
}
Object.defineProperty(globalThis, 'EventSource', { value: TestEventSource, configurable: true });
const { render, cleanup, fireEvent, within, waitFor, act } = await import('@testing-library/react');
const { default: App } = await import('../web/App.js');
const { default: TaskDrawer } = await import('../web/TaskDrawer.js');
const { ProjectForm, TaskForm, SubmitForm } = await import('../web/forms.js');
const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  dom.window.sessionStorage.clear();
  dom.window.history.replaceState(null, '', '/');
});
after(() => dom.window.close());
const date = '2026-10-02T15:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: '测试项目',
  description: '',
  repositoryUrl: '',
  createdAt: date,
};
const task: Task = {
  id: 'task-1',
  projectId: project.id,
  parentId: null,
  title: '测试任务',
  description: '',
  acceptanceCriteria: '',
  priority: 'normal',
  status: 'ready',
  dependencies: [],
  version: 3,
  currentAttemptId: null,
  blockedReason: null,
  createdAt: date,
  updatedAt: date,
};
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    projects: [project],
    tasks: [task],
    attempts: [],
    handoffs: [],
    comments: [],
    sessions: [],
    events: [],
    serverTime: date,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const noop = () => {};

async function backend() {
  const dir = await mkdtemp(join(tmpdir(), 'ac-ui-'));
  const store = new Store(join(dir, 'board.sqlite'));
  const app = createApp(store, { webDir: dir });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const commands: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST')
      commands.push((JSON.parse(String(init.body)) as { command: string }).command);
    const address = typeof input === 'string' && input.startsWith('/') ? `${url}${input}` : input;
    return realFetch(address, init);
  }) as typeof fetch;
  return {
    store,
    commands,
    close: async () => {
      cleanup();
      app.closeClients();
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('React DOM + actual HTTP: create, duplicate-submit guard, claim, evidence handoff, accept, and Back/Escape', async () => {
  const f = await backend();
  try {
    const view = render(<App />);
    fireEvent.click(await view.findByRole('button', { name: /创建第一个项目/ }));
    let dialog = within(view.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('项目名称'), { target: { value: 'DOM 集成项目' } });
    const createForm = dialog.getByLabelText('项目名称').closest('form')!;
    // Submit twice without waiting for React's disabled state to update.
    act(() => {
      fireEvent.submit(createForm);
      fireEvent.submit(createForm);
    });
    await waitFor(() => assert.equal(f.store.snapshot().projects.length, 1));
    await waitFor(() => assert(view.queryByRole('dialog') === null, 'dialog should close'));
    assert.equal(f.commands.filter((command) => command === 'project.create').length, 1);
    fireEvent.click(view.getByRole('button', { name: '新建任务' }));
    dialog = within(view.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('任务标题'), {
      target: { value: '实际 HTTP 协作任务' },
    });
    fireEvent.change(dialog.getByLabelText(/验收标准/), {
      target: { value: 'DOM 测试通过且交接证据齐全' },
    });
    fireEvent.click(dialog.getByRole('button', { name: '创建任务' }));
    await waitFor(() => assert.equal(f.store.snapshot().tasks.length, 1));
    await waitFor(() =>
      assert.equal(view.getByRole('dialog').getAttribute('aria-labelledby'), 'task-detail-title'),
    );
    // The task must open directly after creation, without another card click.
    assert.equal(view.getByRole('dialog').querySelector('h2')?.textContent, '实际 HTTP 协作任务');
    fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: '领取任务' }));
    dialog = within(view.getByRole('dialog', { name: '为 Agent 领取任务' }));
    fireEvent.change(dialog.getByLabelText('Agent 名称'), { target: { value: '测试 Agent' } });
    fireEvent.click(dialog.getByRole('button', { name: '确认领取' }));
    await waitFor(() => assert.equal(f.store.snapshot().tasks[0].status, 'running'));
    await waitFor(() => assert(view.getByRole('button', { name: '提交交接' })));
    const ownership = JSON.parse(
      dom.window.sessionStorage.getItem('agent-collaborator.ownership.v1') || '{}',
    ) as Record<string, { token: string }>;
    const token = Object.values(ownership)[0]?.token;
    assert(token, 'ownership credentials remain in this session');
    assert(!view.container.textContent?.includes(token), 'ownership token is never rendered');
    fireEvent.click(view.getByRole('button', { name: '提交交接' }));
    dialog = within(view.getByRole('dialog', { name: '提交交接，等待验收' }));
    fireEvent.change(dialog.getByLabelText('完成摘要'), {
      target: { value: '任务已完成，验证通过' },
    });
    const evidenceName = dialog.getByLabelText('证据 1 名称') as HTMLInputElement;
    assert.equal(evidenceName.required, true);
    assert.equal(
      evidenceName.form?.checkValidity(),
      false,
      'missing required evidence invalidates the form',
    );
    assert.equal(
      (dialog.getByRole('button', { name: '删除证据 1' }) as HTMLButtonElement).disabled,
      true,
    );
    fireEvent.change(evidenceName, { target: { value: 'DOM 测试' } });
    fireEvent.change(dialog.getByLabelText('证据 1 地址'), {
      target: { value: 'tests/ui.test.tsx' },
    });
    fireEvent.click(dialog.getByRole('button', { name: '提交验收' }));
    await waitFor(() => assert.equal(f.store.snapshot().tasks[0].status, 'review'));
    await waitFor(() => assert(view.getByRole('button', { name: '通过验收' })));
    assert.equal(dom.window.sessionStorage.getItem('agent-collaborator.ownership.v1'), '{}');
    fireEvent.click(view.getByRole('button', { name: '通过验收' }));
    dialog = within(view.getByRole('dialog', { name: '通过这次验收？' }));
    fireEvent.click(dialog.getByRole('button', { name: '确认通过' }));
    await waitFor(() => assert.equal(f.store.snapshot().tasks[0].status, 'done'));
    await waitFor(() =>
      assert(
        view.queryByRole('dialog', { name: '通过这次验收？' }) === null,
        'review dialog should close',
      ),
    );
    assert.equal(f.store.snapshot().handoffs[0].decision, 'accepted');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => assert(view.queryByRole('dialog') === null, 'dialog should close'));
    fireEvent.click(view.getByRole('button', { name: /实际 HTTP 协作任务/ }));
    assert(view.getByRole('dialog'));
    act(() => dom.window.history.back());
    await waitFor(() => assert(view.queryByRole('dialog') === null, 'dialog should close'));
  } finally {
    await f.close();
  }
});

test('edit keeps the original optimistic version across a remote rerender', async () => {
  const calls: { command: string; input: Record<string, unknown> }[] = [];
  const run: RunCommand = async <T,>(command: string, input: Record<string, unknown>) => {
    calls.push({ command, input });
    return task as T;
  };
  const props = { project, tasks: [task], run, busy: false, onClose: noop };
  const view = render(<TaskForm {...props} task={task} />);
  fireEvent.change(view.getByLabelText('任务标题'), { target: { value: '本地尚未保存的标题' } });
  view.rerender(<TaskForm {...props} task={{ ...task, version: 9, title: '远端已更新' }} />);
  fireEvent.click(view.getByRole('button', { name: '保存修改' }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].command, 'task.update');
  assert.equal(calls[0].input.expectedVersion, 3);
  assert.equal((calls[0].input.patch as { title: string }).title, '本地尚未保存的标题');
});

test('unmounting pending project/task forms does not invoke stale navigation callbacks', async () => {
  for (const kind of ['project', 'task'] as const) {
    const pending = deferred<Project | Task>();
    let navigations = 0;
    let closes = 0;
    const run: RunCommand = async <T,>() => pending.promise as Promise<T>;
    const view = render(
      kind === 'project' ? (
        <ProjectForm
          run={run}
          busy={false}
          onCreated={() => navigations++}
          onClose={() => closes++}
        />
      ) : (
        <TaskForm
          project={project}
          tasks={[]}
          run={run}
          busy={false}
          onCreated={() => navigations++}
          onClose={() => closes++}
        />
      ),
    );
    fireEvent.change(view.getByLabelText(kind === 'project' ? '项目名称' : '任务标题'), {
      target: { value: '即将离开的表单' },
    });
    fireEvent.submit(view.container.querySelector('form')!);
    view.unmount();
    await act(async () => {
      pending.resolve(kind === 'project' ? project : task);
      await pending.promise;
    });
    assert.equal(navigations, 0, `${kind} should not change later navigation`);
    assert.equal(closes, 0, `${kind} should not close a newer dialog`);
  }
});

test('untrusted task text is escaped and dangerous evidence/session URLs stay inert', () => {
  const attack = '<img src=x onerror="globalThis.compromised=true">';
  const unsafeTask = {
    ...task,
    title: attack,
    description: '<script>alert(1)</script>',
    status: 'review' as const,
  };
  const data = snapshot({
    tasks: [unsafeTask],
    handoffs: [
      {
        id: 'h-1',
        taskId: task.id,
        attemptId: 'a-1',
        summary: attack,
        evidence: [{ label: '<script>bad</script>', uri: 'javascript:alert(1)' }],
        nextSteps: '',
        createdAt: date,
        reviewedAt: null,
        reviewNote: null,
        decision: 'pending',
      },
    ],
    sessions: [
      {
        id: 's-1',
        taskId: task.id,
        provider: 'test',
        sessionId: 'session-1',
        label: attack,
        uri: 'javascript:alert(1)',
        createdAt: date,
      },
    ],
  });
  const run: RunCommand = async <T,>() => undefined as T;
  const view = render(
    <TaskDrawer
      task={unsafeTask}
      snapshot={data}
      busy={false}
      now={Date.parse(date)}
      run={run}
      onClose={noop}
      onClaimed={noop}
      onOpenTask={noop}
    />,
  );
  assert(view.container.textContent?.includes(attack));
  assert.equal(view.container.querySelector('img,script'), null);
  assert.equal(view.container.querySelector('a[href^="javascript:"]'), null);
  fireEvent.click(view.getByRole('tab', { name: /交接记录/ }));
  assert(view.container.textContent?.includes('javascript:alert(1)'));
  assert.equal(view.container.querySelector('a[href^="javascript:"],img,script'), null);
});

test('modal Escape/backdrop closes when idle and does not dismiss a pending mutation', () => {
  let closes = 0;
  const run: RunCommand = async <T,>() => project as T;
  const props = { run, onCreated: noop, onClose: () => closes++ };
  const view = render(<ProjectForm {...props} busy={false} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(closes, 1);
  fireEvent.mouseDown(view.container.querySelector('.modal-backdrop')!);
  assert.equal(closes, 2);
  view.rerender(<ProjectForm {...props} busy />);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(view.container.querySelector('.modal-backdrop')!);
  assert.equal(closes, 2);
});

test('handoff evidence cannot be removed below one required row', () => {
  const view = render(
    <SubmitForm task={task} busy={false} onClose={noop} onSubmit={async () => {}} />,
  );
  assert.equal(
    (view.getByRole('button', { name: '删除证据 1' }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(view.getByRole('button', { name: '添加证据' }));
  assert(view.getByLabelText('证据 2 名称'));
  fireEvent.click(view.getByRole('button', { name: '删除证据 1' }));
  assert.equal(view.queryByLabelText('证据 2 名称'), null);
  assert.equal(
    (view.getByRole('button', { name: '删除证据 1' }) as HTMLButtonElement).disabled,
    true,
  );
});
