# CLI 与 REST API

同一块板只有一个 daemon。UI、CLI 和 MCP 代理均调用这里的 API；不要让脚本直接修改 SQLite。

## CLI

在仓库根目录执行：

```sh
npm run cli -- status
npm run cli -- projects
npm run cli -- tasks
npm run cli -- tasks PROJECT_ID
npm run cli -- task TASK_ID
npm run cli -- run COMMAND JSON
npm run cli -- run COMMAND "@input.json"
npm run cli -- export ../board-backup.json
npm run cli -- restore ../board-backup.json --confirm-empty
```

`PROJECT_ID`、`TASK_ID`、`COMMAND` 和 `JSON` 为需要替换的参数。构建后无需 `tsx` 的等价入口：

```sh
node dist/adapters/cli.js status
node dist/adapters/cli.js tasks
```

CLI 默认连接 `http://127.0.0.1:4310`，可通过 `AGENT_COLLABORATOR_URL` 指定同机 loopback 地址。它不会替你启动 daemon。状态读取与命令响应以 JSON 输出，错误以非零退出码报告。

POSIX shell 的简单写入例子：

```sh
npm run cli -- run project.create '{"name":"示例项目","description":"本地协作演示"}'
```

Windows 不同 PowerShell 版本向原生进程传递 JSON 引号的行为不同。可将命令的 input 对象保存为 UTF-8 JSON 文件（不是包含 command 的整个 envelope），再用 `npm run cli -- run project.create "@input.json"`；也可以使用本页的 `Invoke-RestMethod` 示例，避免手动拼接、转义 JSON。`npm run` 还会输出 npm 自身的脚本标题；机器解析应优先用构建后的 `node dist/adapters/cli.js`。

## HTTP 入口

基础 URL：`http://127.0.0.1:4310`。成功响应为实际对象，不包裹通用 `data` 字段。

| 方法与路径           | 响应 / 用途                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `GET /api/health`    | `{ok, version, mode, serverTime}`                                    |
| `GET /api/snapshot`  | `Snapshot`：项目、任务、attempt、handoff、评论、会话和近期事件       |
| `GET /api/tasks/:id` | `{task, attempts, handoffs, comments, sessions, events, serverTime}` |
| `POST /api/commands` | 执行业务命令，返回下表对应对象                                       |
| `GET /api/export`    | 完整 JSON 备份，含备份格式与 schema 版本                             |
| `POST /api/restore`  | 把完整备份恢复到空库，返回恢复后的快照                               |
| `GET /api/events`    | SSE 变化通知；收到通知后重新拉取快照                                 |

写请求必须使用 `Content-Type: application/json`。普通命令请求体上限 1 MiB，JSON 备份导出与恢复请求上限 64 MiB。v0.1 不承诺 API 稳定兼容；持久化数据库 schema 和备份分别有明确版本检查。

命令请求示例：

```json
{
  "command": "project.create",
  "input": {
    "name": "示例项目",
    "actor": { "name": "Local user", "kind": "human" }
  }
}
```

`input` 使用严格 schema，未知字段或类型错误会被拒绝。状态必须通过专用命令变更，不能放进 `task.update.patch`。

## 通用字段

- `taskId`：任务 ID
- `expectedVersion`：最近读取的 `task.version`，正整数；成功任务变更后版本递增
- `actor`：`{name, kind: "human" | "agent", provider?, sessionId?}`；只是声明的身份信息
- `agent`：同样的 Actor 结构，但 `kind` 必须为 `"agent"`，用于领取
- `attemptId` / `token`：claim 返回的本次所有权；不能使用外部会话 ID 代替
- `leaseSeconds`：可选整数，30–3600，省略时为 300；每次心跳不传时也按 300 续租
- `evidence`：至少一项 `{label, uri, kind?}`；kind 可为 `url`、`file`、`commit`、`test`、`other`

心跳、评论和会话引用不增加任务版本。可选 actor 未提供时，核心默认记录为本机用户 `Local user`；Agent 集成应明确提供自己的 actor，不依赖这个默认值。

## 命令表

下表“其他字段”中的 `?` 表示可选；V 表示必须提供 `taskId` 与 `expectedVersion`。

| 命令             | 其他字段                                                                                           | 允许状态 / 返回                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `project.create` | `name, description?, repositoryUrl?, actor?`                                                       | 返回 Project                                                           |
| `task.create`    | `projectId, title, description?, acceptanceCriteria?, priority?, dependencies?, parentId?, actor?` | 初始 ready、version 1；返回 Task                                       |
| `task.update`    | V, `patch, actor?`                                                                                 | ready / blocked；返回 Task                                             |
| `task.claim`     | V, `agent, leaseSeconds?`                                                                          | ready，所有依赖 done；返回 `{task, attempt, token}`                    |
| `task.heartbeat` | `taskId, attemptId, token, leaseSeconds?`                                                          | running 且租约有效；返回 Attempt                                       |
| `task.submit`    | V, `attemptId, token, summary, evidence, nextSteps?`                                               | running 且租约有效 → review；返回 `{task, attempt, handoff}`           |
| `task.accept`    | V, `actor`（human）, `note?`                                                                       | review → done；返回 Task                                               |
| `task.reject`    | V, `actor`（human）, `note`（非空）                                                                | review → ready；返回 Task                                              |
| `task.reclaim`   | V, `actor`（human）, `reason`                                                                      | 仅过期 running → ready；返回 Task                                      |
| `task.block`     | V, `reason, actor?, attemptId?, token?`                                                            | ready / running → blocked；running 必须带有效 attempt/token；返回 Task |
| `task.unblock`   | V, `actor`                                                                                         | blocked → ready；返回 Task                                             |
| `task.cancel`    | V, `actor`（human）, `reason`                                                                      | ready / running / review / blocked → cancelled；返回 Task              |
| `comment.add`    | `taskId, body, actor`                                                                              | 返回 Comment                                                           |
| `session.link`   | `taskId, provider, sessionId, label?, uri?, actor?`                                                | 返回 SessionRef                                                        |

`task.update.patch` 仅支持 `title`、`description`、`acceptanceCriteria`、`priority`、`dependencies`，至少一项。优先级为 `low`、`normal`、`high`，创建默认 `normal`。父任务在创建时指定，v0.1 不提供修改父关系的命令。

父子关系和依赖必须属于同一项目，不允许自引用或环。`dependencies` 是不重复 ID 数组。任务 `done` / `cancelled` 后没有直接重新打开命令；需要后续工作时创建新任务并保留历史。

人工命令是协作流程约束，**不是认证授权机制**。本机客户端能够构造 human actor。`task.unblock` 的 API 接受 Actor，但正常工作流将解除阻塞留给人，MCP 不暴露此操作。

## 完整示例：PowerShell 领取、心跳、交接、验收

下面逐段运行。示例会真实创建一个项目与任务，使用已经运行的本机 daemon。目标仅为验证健康检查与任务生命周期，不修改任何代码。

```powershell
$base = 'http://127.0.0.1:4310'
$human = @{ name = 'Local user'; kind = 'human' }
$agent = @{ name = 'demo-agent'; kind = 'agent'; provider = 'manual-demo' }

function Invoke-BoardCommand($command, $inputData) {
    $body = @{ command = $command; input = $inputData } | ConvertTo-Json -Depth 20
    Invoke-RestMethod -Method Post -Uri "$base/api/commands" `
        -ContentType 'application/json; charset=utf-8' `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
}

$project = Invoke-BoardCommand 'project.create' @{
    name = 'API lifecycle demo'; actor = $human
}
$task = Invoke-BoardCommand 'task.create' @{
    projectId = $project.id
    title = 'Check the local health endpoint'
    acceptanceCriteria = 'GET /api/health returns ok = true, then a human reviews the handoff.'
    actor = $human
}

$claim = Invoke-BoardCommand 'task.claim' @{
    taskId = $task.id; expectedVersion = $task.version
    agent = $agent; leaseSeconds = 300
}
```

现在才开始示例工作。保留 `$claim.token`，不要将整个 claim 打印到共享日志。实际任务应定期重复心跳；这里仅演示一次：

```powershell
$heartbeat = Invoke-BoardCommand 'task.heartbeat' @{
    taskId = $claim.task.id; attemptId = $claim.attempt.id
    token = $claim.token; leaseSeconds = 300
}
$health = Invoke-RestMethod "$base/api/health"
if ($health.ok -ne $true) { throw 'Health check failed; do not submit success.' }

$detail = Invoke-RestMethod "$base/api/tasks/$($task.id)"
$submission = Invoke-BoardCommand 'task.submit' @{
    taskId = $task.id; expectedVersion = $detail.task.version
    attemptId = $claim.attempt.id; token = $claim.token
    summary = 'Queried the local health endpoint; it returned ok = true.'
    evidence = @(@{
        label = 'Health endpoint checked in this demo'
        uri = "$base/api/health"
        kind = 'url'
    })
    nextSteps = 'A human should verify the health result and accept or reject this handoff.'
}
$submission.task.status
```

状态应为 `review`。**停下来由人检查**结果、交接与验收标准。下面是人工接受操作，不应交给 Agent 自动执行：

```powershell
$review = Invoke-RestMethod "$base/api/tasks/$($task.id)"
$accepted = Invoke-BoardCommand 'task.accept' @{
    taskId = $task.id; expectedVersion = $review.task.version
    actor = $human; note = 'Reviewed the health result and accepted the demo.'
}
$accepted.status
```

应为 `done`。需要退回时改用 `task.reject`，提供非空 `note`，不要先接受再尝试回退。这里的证据 URI 是一个引用，不会保存健康响应本身。

## 失联回收与阻塞

先查看详情确认 `leaseUntil` 已过期，确认旧 Agent 已停止实际工作，再由人发送：

```json
{
  "command": "task.reclaim",
  "input": {
    "taskId": "TASK_ID",
    "expectedVersion": 2,
    "reason": "Confirmed the old agent has stopped; reclaim expired work.",
    "actor": { "name": "Local user", "kind": "human" }
  }
}
```

示例中的 ID 与版本必须替换。有效租约不能提前 reclaim；需停止有效执行时，应由人明确选择取消，并理解取消只撤销板内所有权，不会杀掉 Agent 进程或撤销文件修改。

## 错误与重试

错误响应结构：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Task changed; refresh before retrying",
    "details": { "expectedVersion": 1, "actualVersion": 2 }
  }
}
```

`details` 为可选，实际字段随错误变化。常见错误：

| Code                                                     | 处理                                               |
| -------------------------------------------------------- | -------------------------------------------------- |
| `VALIDATION_ERROR` / `UNKNOWN_COMMAND`                   | 修正字段或命令；不要原样重试                       |
| `NOT_FOUND`                                              | 检查 ID 与连接的任务板                             |
| `VERSION_CONFLICT`                                       | 重新读取，判断最新状态后再决定                     |
| `INVALID_STATE`                                          | 当前状态不允许该操作                               |
| `DEPENDENCIES_INCOMPLETE`                                | 等待依赖被人工接受                                 |
| `CYCLE` / `CROSS_PROJECT_LINK`                           | 修正依赖 / 父子关系                                |
| `INVALID_TOKEN` / `STALE_ATTEMPT` / `LEASE_EXPIRED`      | 停止当前 attempt 的写操作；交由人处理              |
| `LEASE_ACTIVE`                                           | 租约未过期，不能回收                               |
| `LEASE_REQUIRED`                                         | running 阻塞缺少有效所有权                         |
| `DATABASE_NOT_EMPTY` / `INVALID_BACKUP`                  | 检查恢复目的库与文件，不覆盖现有数据               |
| `BACKUP_TOO_LARGE`                                       | JSON 导出超过 64 MiB，按运维说明使用停机整目录备份 |
| `INVALID_HOST` / `INVALID_ORIGIN` / `CROSS_SITE_REQUEST` | 检查本机 URL 与来源；不要绕过安全校验              |

版本与状态冲突通常为 HTTP 409，输入错误 400，token 错误 403，未知对象 404。还可能遇到 413（请求过大）、415（Content-Type 不符）或 500。

v0.1 没有幂等键。写请求若因网络中断没有收到响应，先读取快照/任务与活动记录确定是否生效，不盲目再次创建、领取或提交。

## SSE 与历史

`/api/events` 发出 `hello`、`change` 和保活信息。通知用于触发重新获取当前状态，不是可靠的事件回放接口；重连后应立即刷新快照，不依赖 `Last-Event-ID` 追补。

快照只包含最新 2,000 条活动，单任务详情中的 events 也来自这个近期窗口；完整历史保留在 JSON 导出中。备份敏感性与恢复规则见 [运维说明](operations.md)。
