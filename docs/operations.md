# 统一验证和 Studio 发布

这些命令只管理 Studio 和隔离测试服务，不升级或重启原任务服务 4391。需要 Node 24、npm、Python 3.12、Git；服务器需已有 SSH 别名 `tencent-server`、Docker、Python 3.12、`ss`，部署用户 UID 1000。DeepSeek 凭据继续使用服务器原有 `/home/ubuntu/xagent-mastra-lab/.env`，不下载至本机。

## 统一验证

```powershell
# 默认只跑本地回归，不调用模型
npm.cmd run check

# 测试已部署版本的 Agent API；默认 mock
npm.cmd run check -- --suite agent-api --agents meeting-prep,information-watch

# 显式启用真实 DeepSeek，只验证所选 Agent，每个 Agent 一轮，不自动重试
npm.cmd run check -- --suite agent-api --mode deepseek --agents meeting-prep

# 独立 4491 服务：参会一轮、巡检初始/变更两轮，结束时暂停任务并移除容器
npm.cmd run check -- --suite task-api --mode deepseek

# 本地回归 + 全部三个 Agent API + 隔离任务 API
npm.cmd run check -- --suite all --mode deepseek
```

Linux 使用 `npm`。CLI 默认报告为 `.cache/verification-latest.json`，可用 `--output docs/<name>.json` 保存所需证据；服务器报告在 `/home/ubuntu/xagent-studio/reports/<run-id>/`，包含子报告、隔离任务数据和清理结果。任务 API 场景固定为两种事件 Agent，`--agents` 仅控制 Agent API 场景；出行的用户请求型任务仍由原回归测试覆盖。

远端验证要求本地工作区干净且提交版本与实际 Studio 镜像版本一致；不一致时在发出模型请求前失败。首次部署前不可对未受管的旧 Studio 运行新远端验收。验证和发布共用服务器操作锁；不并行运行两套验证或在发布中发起 CLI 验收。

`all` 仅包含上述 CLI 场景，默认不代表页面验收。所有 CLI 报告明确写 `uiVerified: false`。涉及 Studio 改动时，还必须在页面中手工或通过浏览器工具发送消息、检查提交工具的 `accepted` / artifact 和最终回复；若涉及历史，刷新确认保留，并保存截图及对应会话、版本。页面验收结果另记，不能将 HTTP API 的通过结果改写为已测 UI。

真实模型每轮受 Agent 自身步骤和时间预算限制；脚本只运行选定场景，不自动因失败重试。首次失败保留报告和非零退出码，先查清原因再重跑受影响范围。报告不保留原始推理、凭据或全量 provider 响应。真实浏览器只在选中出行助手且使用 DeepSeek 时运行，照片与设备事件仍是模拟数据。

## 独立 Studio 发布

先通过 `npm run check` 并提交源码，再运行：

```powershell
npm.cmd run studio:deploy
npm.cmd run studio:status
npm.cmd run studio:rollback
```

第一次把原手工部署的 `xagent-studio` 接入管理时使用：

```powershell
npm.cmd run studio:deploy -- --adopt-legacy
```

这是显式维护切换：旧实例没有排空接口，不能保证其运行中请求可完成；首次接管应选无业务运行的维护时间。控制器只接受已识别的旧实验容器，不接管未知容器。旧容器、目录和一致性备份保留。首次接管还没有“上一个受管版本”，`rollback` 会明确拒绝；旧实例可作人工恢复，恢复前须先把当前聊天库一致性备份到旧实例的数据位置，不能直接启动旧数据而丢弃新增聊天。

后续发布流程：

1. 本地使用 `git archive` 打包已提交的完整版本，源码与控制器来自同一干净提交，不上传 `.env`、运行数据、Git 目录或本地依赖。
2. 在服务器新 release 目录构建 `Dockerfile.studio`，按锁文件安装 Linux 依赖并打包 Studio，构建成功前不停止当前服务。镜像带源码 SHA 和 release 标签，运行目录内含 build-info。
3. 写只读挂载控制文件，让 Studio 输入处理器拒绝新运行；等待已有运行归零并保持两秒。排空超时清除标志，保留原服务，不强制中断。
4. 停止旧 Studio，用 SQLite backup 保存完整聊天库，保留旧容器，然后单实例启动新镜像。数据库继续使用独立共享数据目录，不连接正式任务库。
5. 核对状态端点、源码版本和三个 Agent 登记，执行两种笔记 Agent 的 mock API smoke。失败则停止新容器并恢复旧容器；成功更新 current / previous 状态。
6. 再按改动范围显式运行真实验收和页面验收。部署后的 mock smoke 不等于真实业务验收；真实验收失败需定位或使用 rollback。

回退使用不可变镜像 ID，同样排空当前运行、备份聊天库并保留当前数据，不用旧数据库覆盖新增聊天。仅适用于数据库契约向后兼容的版本；涉及存储或依赖导致的不兼容 Schema 变更时必须另行提供迁移与恢复方案，不能盲目使用此回退流程。已保留镜像、容器、备份不会自动删除，应在确认不再需要回退后另行清理。

## 状态、数据与访问

受管根目录 `/home/ubuntu/xagent-studio`：

| 路径 | 用途 |
| --- | --- |
| `state.json` | 期望的 current / previous 版本及不可变镜像 ID |
| `releases/` | 按提交与时间隔离的构建源码 |
| `data/mastra.db` | 唯一受管 Studio 聊天库 |
| `backups/` | 停服后创建并校验的一致性备份 |
| `control/draining` | 维护排空标志，不由 HTTP 或模型工具修改 |
| `reports/` | 构建日志、操作结果、验证报告和隔离测试数据 |

`GET /xagent/status` 仅返回服务名称、源码/release、是否排空、活跃运行数及是否配置 key，不返回 key。`studio:status` 同时读取容器实际镜像与服务信息；镜像标签、清单和接口都不一致时不得宣布版本已部署。

Studio 继续只监听服务器回环 4411。建立本机访问通道：

```powershell
ssh -N -L 127.0.0.1:4411:127.0.0.1:4411 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 tencent-server
```

打开 http://127.0.0.1:4411/agents。不要使用 `scripts/deploy.ps1` 更新 Studio，它面向原任务服务。运行镜像不挂载旧工作区的 `node_modules`；容器只写 Studio 数据和临时目录，控制目录只读挂载。
