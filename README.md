# XAgent · Mastra 手机工具实验

开发验证使用 `npm run check`；Studio 独立发布、查询和回退使用 `npm run studio:deploy` / `studio:status` / `studio:rollback`。真实模型须显式指定 `--mode deepseek`。命令、首次接管和页面验收要求见 [运维与统一验证](docs/operations.md)。

最新验收：59 项自动测试通过，统一 CLI、真实 API、三个 Studio 页面、聊天保留及版本回退已验证；失败修复、报告和限制见 [运维验收](docs/operations-validation.md)。

当前 Studio 已接入出行、参会和信息巡检三个 Agent：[启动与调试](docs/studio.md)、[参会与巡检接入及真实验收](docs/notes-studio.md)。本轮 45 项自动测试通过，并完成 5 次真实 DeepSeek 运行（3 次隔离任务 API、2 次 Studio 页面调用）；设备事件与会议资料为合成测试数据。

新增：[出行助手与原生浏览器工具](docs/travel-assistant.md)。`travel-assistant` 已通过真实 DeepSeek + `@mastra/agent-browser` + Chromium 运行验证，自动生成[延吉三日计划（含来源图片）](docs/yanji-trip.md)；[结构化运行报告](docs/travel-verification.json)。用户请求型任务创建后直接运行，无需设备监测订阅。当前共 3 种 Agent，本地测试 26 项通过。

最新：[第二种 Agent 与服务端复用验证](docs/second-agent-validation.md)已完成。参会 `meeting-prep` 与信息巡检 `information-watch` 共用 `src/tasks/` 的任务、事件、调度、模型和强制输出校验，业务定义在 `src/agents/`。两用户、四任务，最终一轮 9 次真实 DeepSeek 运行、8 组检查通过；本地测试 24 项通过。新增业务可在 registry 登记，保留原会议接口与数据，无客户端渲染开发。

面向多个专用 Agent 的[架构与方案](docs/architecture.md)，以及原始[参会准备助手验证](docs/meeting-validation.md)。参会模块复用一个 Agent 定义，支持两名测试用户的独立持续任务、模拟设备事件、资料检索与 A2UI JSON 刷新。`src/meeting/` 保留兼容入口，本地验收 `npm.cmd test`。

2026-10-22 参会闭环已在 tencent-server 用真实 DeepSeek 完成 6 组检查、7 次运行，含事件恢复和任务隔离；[验收记录](docs/meeting-verification.json)。设备和资料库仍为合成测试数据，尚未接入真实手机或 A2UI 渲染客户端。

独立验证「Agent 发起手机工具调用 → 设备返回结果 → Agent 继续决策」，以及延迟回传、服务重启和取消时的行为。代码与数据不依赖 taskAI。

当前默认使用**脚本模拟模型 + 模拟手机**。2026-10-22 已在服务器用真实 `deepseek-flash` 完成 4 个场景、5 项检查，包括连续工具调用、结果驱动分支和容器重启后继续；详见 [真实模型记录](docs/deepseek-verification.json)。设备仍为模拟器，未访问真实手机数据。

模拟模式通过 Mastra 的真实 Agent 工具循环执行，但其工具选择规则由测试代码预设，不能据此评价模型智能。`mode=deepseek` 才请求真实模型，key 由服务器外部配置提供。

## 组成

```text
HTTP API → Mastra Agent → 设备工具网关 → 手机模拟器
                ↑              ↓
       Mastra 暂停快照    SQLite 调用记录与结果
```

- `src/engine.ts`：Agent、三个工具、短等待、持久暂停、恢复与取消。
- `src/model.ts`：不联网的脚本模型，使用 Mastra 官方 mock model。
- `src/store.ts`：设备调用账本、结果去重、取消、期限和事件记录。
- `src/server.ts`：独立 HTTP 接口；默认只接受回环连接，拒绝浏览器 Origin。
- `scripts/phone-simulator.py`：独立设备轮询器，可供模拟模型或后续 DeepSeek 实验共用。
- `scripts/verify-deepseek.py`：使用真实模型和合成设备结果的有限验收，包含实际容器重启。
- `tests/integration.test.ts`：真实启动服务子进程，覆盖工具结果、跨进程恢复和边界场景。

固定版本：`@mastra/core 1.78.0`、`@mastra/libsql 1.26.2`，传递依赖由 `package-lock.json` 锁定。Node 24 Docker 基础镜像固定 SHA-256 digest。

## 本地运行

需要 Node 24 和 npm；Python 3 用于模拟设备和服务器验收。

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd test
npm.cmd start
```

另一个终端启动模拟设备：

```powershell
python scripts/phone-simulator.py --battery 78 --auto-photo
```

创建运行（PowerShell）：

```powershell
Invoke-RestMethod http://127.0.0.1:4391/runs -Method Post -ContentType application/json -Body '{"mode":"mock","scenario":"plan"}'
```

返回 `id`，通过 `GET /runs/<id>` 查看结果及完整事件记录。电量低于 20 时，脚本模型建议充电并结束；否则读取日历。`scenario=photo` 请求一张明确标记为模拟内容的照片说明。

## 服务器

目标：SSH 别名 `tencent-server`。

- 项目：`/home/ubuntu/xagent-mastra-lab`
- 容器：`xagent-mastra-lab`
- 接口：`http://127.0.0.1:4391`，仅服务器回环开放
- 数据：项目内 `data/`，包含设备账本和 Mastra 持久快照
- 凭据：项目内 `.env`，不提交、不打包上传，权限 0600
- 容器：非 root，内存上限 768 MB，持久目录以外只读

部署与真实容器重启验收：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
```

在本机建立访问通道（保持该终端运行）：

```powershell
ssh -N -L 14391:127.0.0.1:4391 tencent-server
```

随后访问 `http://127.0.0.1:14391/health`，或给模拟设备增加 `--base http://127.0.0.1:14391`。接口返回 JSON；这一轮没有构建网页控制台。

服务器操作：

```sh
cd /home/ubuntu/xagent-mastra-lab
docker compose --project-name xagent-mastra-lab ps
docker compose --project-name xagent-mastra-lab logs --tail=60
python3 scripts/verify.py --container xagent-mastra-lab
docker compose --project-name xagent-mastra-lab stop
```

`verify.py --container` 会重启本实验容器，建议在没有其他实验进行时运行。只创建 mock 运行，不触发真实模型，也不更改其他服务。

## DeepSeek 配置与真实模型验收

在服务器编辑 `.env`，填写 `DEEPSEEK_API_KEY`。不要把密钥粘贴到聊天、脚本、Git 或命令行参数中。

```sh
ssh tencent-server
cd /home/ubuntu/xagent-mastra-lab
nano .env
docker compose --project-name xagent-mastra-lab up -d --force-recreate
```

当前默认 `DEEPSEEK_MODEL=deepseek-flash`，`DEEPSEEK_BASE_URL=https://api.deepseek.com/v1`。可按自己的账户和接入渠道调整。`restart` 不会重新读取 env_file，修改后需 `up -d --force-recreate`。

`GET /health` 只报告是否配置 key，不会显示 key，也不能证明 key 有效。创建 `mode=deepseek` 的运行才实际请求模型；没有 key 返回 412，不会暗中降级为模拟模型。

启动模拟设备后，用下列请求验证真实模型到模拟设备的链路：

```sh
curl -s http://127.0.0.1:4391/runs \
  -H 'Content-Type: application/json' \
  -d '{"mode":"deepseek","scenario":"plan","prompt":"请读取手机电量；低于20%就建议充电，否则查询日历后给出安排。"}'
```

这仍然只操作模拟设备，不是手机真机验收。真实模型的工具选择、API兼容性、延迟和费用都需单独记录。

真实模型验收（会产生少量 API 用量，创建 4 个真实运行）：

```sh
python3 scripts/verify-deepseek.py --restart-container xagent-mastra-lab
```

该命令自行模拟设备回调，不需要同时启动 `phone-simulator.py`。它会重启本实验容器，并在存在其他活跃实验时拒绝运行。输出保存在 `docs/deepseek-verification.json`，包括真实回复、工具调用事件和耗时；不会读取或输出 key。

## 本地 Studio 调试

执行 `npm.cmd run studio`，打开 http://127.0.0.1:4111。当前已接入「出行助手」；选择 Request context 中的延吉 mock 预设并 Save，即可聊天、检查工具结果和经过校验的行程 JSON。调试会话与正式任务数据独立，原有任务 API 保持可用。

启动、真实模型配置、代码边界及验证说明见 [Studio 使用说明](docs/studio.md)。

## 设备协议

| 接口 | 用途 |
| --- | --- |
| `POST /runs` | 创建 mock / deepseek 运行，可选 `scenario`、`prompt`、`jobTtlMs` |
| `GET /runs/:id` | 获取运行、设备作业和事件记录 |
| `POST /runs/:id/cancel` | 先持久取消，再中断当前执行 |
| `GET /devices/sim-phone/commands` | 领取待执行的模拟设备命令 |
| `POST /devices/sim-phone/results/:callId` | 提交结构化设备结果 |

成功结果：`{"status":"succeeded","observedAt":"<ISO时间>","data":{...}}`。失败结果：`{"status":"failed","observedAt":"<ISO时间>","error":"permission_denied"}`，也支持 `device_unavailable` / `user_canceled`。失败不等于成功的空数据。

首次结果校验采集时间、工具字段、数值范围。相同结果重复提交只返回收据；同 callId 内容冲突返回 409；已取消或到期返回 410。取消、到期和完成均为终态。

快速读取最多等待 600ms 后转为 Mastra 持久暂停；照片直接暂停。设备回调先写入账本，再恢复指定的暂停调用。重启时补查已提交但尚未恢复的结果，避免把较早工具的结果误用于当前工具。

## 已验证范围与边界

本地验收及服务器结果见 [实验记录](docs/experiment.md)。

- 验证了正常短调用、工具结果影响下一步、慢调用暂停和跨进程恢复。
- 验证了回调提交后的恢复、重复/冲突结果、取消后迟到结果、超时和拒绝授权。
- 普通模型调用进行中进程退出，会记录 `EXECUTION_INTERRUPTED`；没有声称任意执行点都可透明恢复。
- 目前仅单个可信实验者、一台模拟设备、一个服务实例，无公开鉴权、多租户、多设备安全路由。
- 只读电量、日历和模拟拍照，不含日历写入、支付、消息发送等真实外部副作用，也未验证这类操作的端到端幂等。
- 设备账本和 Mastra 快照是两个持久边界，已验证常见窗口，但没有证明跨数据库的原子提交或任意断电恢复。
- 这是一套选型实验，不是生产设备管理平台。

参考：[工具与客户端工具](https://mastra.ai/docs/agents/tools)、[暂停和重启恢复](https://mastra.ai/docs/agents/human-in-the-loop)、[libSQL存储](https://mastra.ai/integrations/databases/libsql)、[DeepSeek接入](https://api-docs.deepseek.com/guides/search_fetch)。
