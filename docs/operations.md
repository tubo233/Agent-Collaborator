# 配置、备份与故障处理

## 配置

| 环境变量                      | 使用方    | 默认值                                           |
| ----------------------------- | --------- | ------------------------------------------------ |
| `AGENT_COLLABORATOR_DATA_DIR` | daemon    | `path.join(os.homedir(), '.agent-collaborator')` |
| `AGENT_COLLABORATOR_PORT`     | daemon    | `4310`，整数 1–65535                             |
| `AGENT_COLLABORATOR_URL`      | CLI / MCP | `http://127.0.0.1:4310`，只支持本机 loopback     |

v0.1 无 HOST / LAN 开关，daemon 固定监听 `127.0.0.1`。`AGENT_COLLABORATOR_URL` 只更改客户端连接目标，不会配置或启动服务。推荐使用 `127.0.0.1`，避免 `localhost` 在某些系统解析为未监听的 IPv6 地址。

PowerShell 独立测试目录示例：

```powershell
$env:AGENT_COLLABORATOR_DATA_DIR = "$HOME/agent-collaborator-demo"
$env:AGENT_COLLABORATOR_PORT = '4311'
npm start
```

在另一个 PowerShell 终端中设置客户端地址：

```powershell
$env:AGENT_COLLABORATOR_URL = 'http://127.0.0.1:4311'
npm run cli -- status
```

POSIX shell 等价启动：

```sh
AGENT_COLLABORATOR_DATA_DIR="$HOME/agent-collaborator-demo" AGENT_COLLABORATOR_PORT=4311 npm start
```

变量仅影响继承它的进程。修改后应重启相关 daemon / MCP 客户端；切换目录会显示另一份数据，不会迁移原数据库。

开发命令 `npm run dev` 的 Vite 代理目标固定为 `4310`。常规开发保留默认端口；若需要自定义开发端口，应同时调整本地 Vite 代理设置，不能只改 daemon 变量。

## 数据目录

默认包含 `board.sqlite`、SQLite 运行时可能生成的 `board.sqlite-wal` / `board.sqlite-shm`，以及用于排他运行锁的 `daemon-lock.sqlite`。

- 一个数据目录只运行一个 daemon
- 使用本机磁盘，不使用 SMB / NAS，也不让 OneDrive、Dropbox 等同步正在运行的数据库
- 程序不会加密数据库；保护目录的系统账户权限与磁盘访问
- 停服务使用运行终端的 Ctrl+C，等待进程退出后再进行文件级维护
- 不要只复制正在运行的 `.sqlite` 文件作为可靠备份；使用下面的逻辑导出
- 不要手工编辑 SQL / JSON 字段绕开状态机

服务重启保留任务与历史，但不会恢复 Agent 会话或自动续租。

## JSON 备份

先确保 daemon 正在运行。在仓库目录执行：

```sh
npm run cli -- export ../board-backup.json
```

示例将备份放在仓库外的上一级目录；请按需改到自己的私密备份位置。导出文件必须是新文件名，CLI 不覆盖已有文件。备份不是脱敏摘要，包含完整项目、任务、执行历史、交接、评论、会话与证据引用以及活动事件。导出不包含 claim token 或存储中的 token hash。用户写进自由文本的秘密不会被自动识别与删除，因此仍须把备份当敏感文件保护。

备份结构：

```json
{
  "format": "agent-collaborator",
  "schemaVersion": 1,
  "exportedAt": "2026-10-02T00:00:00.000Z",
  "data": {
    "projects": [],
    "tasks": [],
    "attempts": [],
    "handoffs": [],
    "comments": [],
    "sessions": [],
    "events": [],
    "serverTime": "2026-10-02T00:00:00.000Z"
  }
}
```

这是空备份结构示意，实际内容以导出为准。请不要编辑 schemaVersion 以绕过版本检查。JSON 导出可带离原电脑；它不包含证据指向的文件、Git 仓库或外部 Agent 会话内容。

## 仅空库恢复

恢复不覆盖、不合并现有任务板。推荐在新的本地数据目录和独立端口中演练，并先确认旧 Agent 已停止实际工作：

1. 保留原数据和备份，不删除原目录
2. 按上面的 PowerShell 示例启动新的 daemon，数据目录指向尚未使用的目录
3. 在另一个终端将 `AGENT_COLLABORATOR_URL` 指向新端口
4. 执行恢复并读取任务：

```sh
npm run cli -- restore ../board-backup.json --confirm-empty
npm run cli -- status
npm run cli -- tasks
```

5. 在新 URL 检查项目、任务、交接与历史，确认目标实例正确后再安排 Agent 使用

`--confirm-empty` 是 CLI 的明确确认参数；daemon 仍独立验证数据库确实为空。HTTP `POST /api/restore` 接收导出文件本身，且只接受 `application/json`。JSON 导出和恢复的 HTTP 传输体上限均为 64 MiB。服务在导出超过上限时会返回 `BACKUP_TOO_LARGE`，而不是生成不能通过同一入口恢复的导出。CLI 读取备份后会重新序列化请求；文件的缩进、空格不等于实际传输大小。不要截断 JSON 或拆分成多次导入。更大数据量采用下面的停机整目录备份。

恢复会验证备份结构、引用关系、状态与环；不支持未知的更高 schema 版本。备份里的 `running` 任务恢复为 `ready`，相应 active attempt 标记为 `reclaimed`，任务版本递增并记录恢复事件。所有旧执行所有权失效，不恢复 token。其他已提交/已完成历史按验证后的备份保留。

恢复副本不意味着两块板会同步；避免让旧 Agent 和新 Agent 同时改同一个实际工作目录。

## 停机整目录备份（大数据集）

JSON 是可移植的逻辑备份。对于超过 64 MiB 的数据集，可采用文件级备份，但必须保证一致性：

1. 确认所有 Agent 已停止工作，干净关闭 daemon 并确认进程完全退出
2. 复制**整个数据目录**，包括 `board.sqlite` 以及任何仍存在的 WAL / SHM 文件；不能只挑一个文件，也不能边运行边复制
3. 将副本保存到安全位置，记录所用代码版本 / schema；保持原目录不动
4. 恢复时复制到另一个空的本机目录，使用兼容版本的 daemon 和独立端口打开它
5. 检查数据完整性后再允许客户端操作，切勿让两个目录的服务同时驱动同一工作目录

与 JSON 恢复不同，文件级备份是原数据库副本，包含内部 token hash 和原租约状态，不会执行所有权重置。不要用它绕过过期限制；旧 Agent 全部停止后，由人按正常规则等待租约过期并回收，再重新领取。保护整目录备份的权限，不能提交到公开仓库。

## 故障排查

### 页面打不开 / 连接被拒绝

先看运行终端是否仍在，执行 `npm run cli -- status`。核对 URL、端口、Node 24 和构建产物。代理进程启动成功不代表 daemon 已启动。

### UI_NOT_BUILT

在仓库根目录执行 `npm run build` 后再 `npm start`。开发时使用 Vite 的 `http://127.0.0.1:5173`。

### 端口已占用

查明是否已有本项目 daemon，优先连接它。需要独立实例时同时选择另一个端口与另一个数据目录，不要删除锁数据库来强开同一个数据目录。

### 数据目录已被使用 / 无法取得锁

daemon 在独立的 `daemon-lock.sqlite` 上持有 SQLite 排他事务锁。进程退出或崩溃后，操作系统会释放锁；锁数据库文件留在目录里是正常现象，不表示服务仍在运行。

先检查是否已有 daemon 或目录权限问题。停止已确认的旧服务，或选择另一个本机数据目录。不要删除锁数据库来绕过正在运行的服务，也不要结束不认识的进程。

### 任务一直 running

读取最新 attempt 的 `heartbeatAt` 与 `leaseUntil`。有效租约表示仍被占用；过期只表示可能失联。检查旧 Agent 是否还在工作，然后由人回收。服务不会自动重排或启动另一个 Agent。

### VERSION_CONFLICT / LEASE_EXPIRED

刷新任务。版本冲突意味着读取后有人已更改任务；过期 lease 不能被迟到 heartbeat 恢复。重新领取必须先完成规定的人工处理，不能复用旧 token。

### 数据看起来不见了

检查 daemon 启动日志中的数据目录、当前用户的 `os.homedir()` 以及客户端 URL。换用户、改环境变量或连接另一个端口可能进入了另一块板。先定位旧目录，不要急着恢复或覆盖。

### Windows 命令 / 路径问题

- 路径包含空格时加引号，MCP args 使用单独的参数项
- JSON 使用 CLI 的 `"@input.json"` 方式，或 PowerShell `Invoke-RestMethod`
- 如果本机 PowerShell 执行策略拦截 `npm.ps1`，可使用已有的 `npm.cmd` 入口或 cmd 终端；无需放宽系统安全策略
- MCP 进程的用户和环境可能与终端不同，使用 Node 与脚本的绝对路径排查
- Windows 原生实机行为仍需单独验证，见 [验证说明](validation.md)
