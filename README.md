# Agent-Collaborator

让手动打开的多个 AI Agent 共用一块本地任务板：领取任务、记录进度、提交交接，由人验收。

**v0.1 开发快照 · 单机优先 · Agent 中立 · 许可证待定**

目标场景是一台 Windows PC 上，同时使用 Codex、Claude Code 或其他能够调用 HTTP、CLI、MCP 的工具。任务、执行尝试和交接记录归属于这块任务板，不依赖某一家 Agent 的会话格式。

> 当前从源码运行，尚未发布 npm 包、桌面安装器或正式发行版。项目计划公开开发，但仓库许可证尚未选定；公开代码不等于已经授予开源许可证。请勿假定采用 Apache-2.0、MIT 或其他许可证。

## 工作方式

1. 人创建项目与任务，写明验收标准和依赖
2. 人手动打开 Agent，让它查看任务板并选择可领取任务
3. Agent 原子领取任务，保存本次执行的 token，定期发送心跳
4. Agent 完成工作后，提交摘要、证据引用和后续事项，任务进入待验收
5. 人检查实际产物，接受后任务才成为 `done`；不合格则退回

任务板不会自动启动 Agent、执行命令、修改仓库、读取证据路径或合并代码。它协调工作与交接；实际执行仍在你手动打开的工具里。

## v0.1 范围

- 项目、任务、父子任务、优先级、依赖和活动记录
- 原子领取、执行尝试、租约心跳、过期提示与人工回收
- 交接摘要、证据引用、人工接受/退回、评论和会话引用
- React 看板、同一套 REST 命令、CLI、真实 stdio MCP 代理
- 本地 SQLite 持久化、JSON 导出和仅空库恢复

明确不包含：Agent 自动调度器、多人账户/权限、局域网或公网服务、云同步、Git 自动操作、桌面安装包。

## 快速开始

需要 Git、**Node.js 24** 和 npm。以下命令可在 PowerShell 7、cmd 或常见 POSIX shell 中逐行执行：

```sh
git clone https://github.com/tubo233/Agent-Collaborator.git
cd Agent-Collaborator
npm ci
npm run build
npm start
```

打开 **http://127.0.0.1:4310**，保持服务所在终端运行。其他终端和 MCP 客户端连接同一个 daemon。

```sh
npm run cli -- status
npm run cli -- projects
npm run cli -- tasks
```

默认数据库位置是 `~/.agent-collaborator/board.sqlite`，其中 `~` 由 Node 的 `os.homedir()` 解析；Windows 通常对应当前用户主目录。源码目录和运行数据分离。不要将数据库放在 SMB、网络盘或云盘同步目录里。

服务固定监听 `127.0.0.1`。v0.1 不提供改为 `0.0.0.0` 或局域网地址的选项。

## 连接 Agent

先构建并启动 daemon，再在支持 MCP 的客户端中注册本地入口：

```sh
node /absolute/path/Agent-Collaborator/dist/adapters/mcp.js
```

Windows 路径示例：`C:/work/Agent-Collaborator/dist/adapters/mcp.js`。客户端会启动 stdio 代理进程；代理不会启动 daemon，也不直接打开 SQLite。正式配置建议调用 `node` 与绝对路径，避免 npm 启动日志干扰 stdio 协议。

见 [Codex / Claude Code MCP 配置](docs/mcp.md) 和 [Agent 领取与交接约定](docs/agent-workflow.md)。这些是基于官方配置文档整理的示例；不代表已在真实 Codex / Claude Code 会话中完成验收。

不使用 MCP 也能通过 [CLI 与 REST API](docs/api.md) 操作同一块板。

## 核心规则

- 只有 `ready` 且所有依赖均为 `done` 的任务可被领取
- 主流程为 `ready → running → review → done`，最后一步必须是人工验收
- 每次领取产生独立 attempt 与 token；旧 token、过期 token 不得继续写入该次执行结果
- 默认租约 300 秒，可选范围 30–3600 秒；建议每 60 秒心跳一次
- 租约到期只标记为失联，任务仍是 `running`；人明确回收后才能重新领取
- 任务修改使用版本号防止覆盖新数据；依赖必须无环
- API 的 `actor.kind = "human"` 是本机协作约定，不是不可伪造的身份认证

完整状态规则见 [架构与不变量](docs/architecture.md)。

## 开发

```sh
npm ci
npm run dev
```

开发 UI：http://127.0.0.1:5173；Vite 将 `/api` 转发到本机 daemon 的 `4310` 端口。运行开发模式前先停止占用同端口的生产服务。开发代理默认端口固定，初次开发请保留默认端口配置。

```sh
npm run check
```

检查顺序：ESLint、TypeScript、测试、生产构建。[CI](.github/workflows/ci.yml) 配置了 Ubuntu / Windows 与 Node 24；配置存在不等于两套平台已经通过。实际已执行项目与未验证项见 [验证说明](docs/validation.md)。

## 文档

- [CLI / REST API 与完整执行示例](docs/api.md)
- [Agent 工作约定](docs/agent-workflow.md)
- [MCP 接入](docs/mcp.md)
- [架构、状态机与并发语义](docs/architecture.md)
- [配置、备份、恢复和故障处理](docs/operations.md)
- [验证范围](docs/validation.md)
- [贡献指南](CONTRIBUTING.md) · [安全边界与漏洞报告](SECURITY.md)

## 来源与许可证

产品方向受到 [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) 的本地任务板思路启发。Agent-Collaborator 是独立实现；本版本未复制该项目源代码，也不继承其许可证或兼容性承诺。

仓库尚未选定许可证，暂无 `LICENSE` 文件。发布前需要由维护者明确授权条款，并核查各依赖自己的许可证。

## English summary

Agent-Collaborator is a local-first, agent-neutral coordination board for manually opened AI agents. One Node.js 24 daemon owns SQLite; the web UI, CLI and stdio MCP proxy share its REST API. Claims use leases and fencing tokens, and submitted work requires human review. v0.1 is a source-only development snapshot, binds to loopback only, and has no selected project license yet.
