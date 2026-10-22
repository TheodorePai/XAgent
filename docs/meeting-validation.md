# 验证方案：参会准备助手

## 假设与范围

检验“Mastra 负责 Agent 执行，薄业务层负责独立任务与事件”能否支持多个用户和持续任务。复用现有 DeepSeek 连接、Mastra 实例、部署与已有设备暂停恢复实验。

当前仅验证服务端能力，不开展客户端渲染开发。保留发布前的 A2UI Schema 强制校验，作为当前实验已有的输出检查；具体产品的客户端展示类型后续再定。

一个 `meeting-prep@1` 定义；Alice / Bob 两名合成用户，各两个独立任务。没有为用户或任务复制 Agent。运行时最多两个任务并发，每用户最多一个；闲置任务没有运行中的模型。

设备是模拟日历适配器；资料为每任务独立的测试资料库。检索工具是真正通过 Mastra 被模型调用，但只对这些资料排序并返回候选，不代表联网搜索、向量检索或已接入企业知识库。

## 验收链路

1. 用户身份决定任务 owner；禁止正文指定 ownerId。
2. 创建任务返回仅属于该订阅的设备 token；设备轮询得到 watchCalendar 命令。
3. 设备 ACK 后订阅 active；ACK 本身不调用模型。
4. 每个设备事件先写 SQLite inbox、更新事实和 revision，再确认接收；调度触发独立 Agent 运行。
5. Agent 调用 searchMeetingNotes，随后以经过 Zod 校验的 submitBrief 工具参数提交业务简报。submitBrief 只收集草稿，最终版本检查后才发布。
6. 四个任务使用不同资料编号，输出必须包含自己的真实资料，不能包含其他任务编号；记录工具轨迹与模型 token 用量。
7. 用户修改一个任务关注点，只刷新该任务；日历变更再次刷新，其他三个任务版本不变。
8. 同一事件重试不新增运行；相同 ID 内容冲突和旧序号分别拒绝。
9. 已发布结果通过 A2UI v0.9.1 适配器生成消息。首次 / 重连包含 createSurface + updateComponents + updateDataModel；后续只更新数据，surfaceId 不变。
10. 停服务后模拟事件已落库但未调度，再启动，验证扫描恢复处理。暂停任务撤销订阅，迟到事件拒绝。

另外本地自动测试确定性验证：旧快照无法覆盖新 revision；生成期间读取页面仍得到完整的上一版本，不混入新标题。

## 实现边界

| 模块 | 代码 | 复用 / 专属 |
|---|---|---|
| 用户、任务、订阅与事件账本 | src/tasks/store.ts | 与信息巡检共用；src/meeting/store.ts 保留旧导入 |
| API 和设备协议 | src/tasks/api.ts | 共用 API，按定义选择业务事件契约 |
| 调度与运行 | src/tasks/runtime.ts | 两种 Agent 共用 |
| 会议工具、提示词和契约 | src/agents/meeting.ts | 会议专属 |
| 业务结果到页面消息 | src/tasks/view.ts | 共用 A2UI 输出和发布前强制校验 |
| Mastra 与模型连接 | 现有 Engine / Mastra 实例 | 复用 |
| 自动验收 | tests/meeting.test.ts、scripts/verify-meeting.py | 本地 mock 与服务器真实模型分开 |

为兼容当前 DeepSeek 工具调用，业务 JSON 使用 Schema 约束的提交工具。没有将模型的任意文本直接当成可执行页面，也没有强依赖特定模型的 JSON response_format 支持。后续可替换为 Mastra structuredOutput，不影响任务协议。

## 运行与访问

仍使用现有 `127.0.0.1:4391` 和 SSH 隧道，不开放公网端口。旧 `/runs` 实验保持原状。新 `/v1/*` 使用 Bearer token：

- `POST /v1/tasks`：创建；body 为 name、instruction、notes、mode。
- `GET /v1/tasks`、`GET /v1/tasks/:id`：当前用户任务与详情。
- `POST /v1/tasks/:id/instruction`：修改要求并触发刷新。
- `POST /v1/tasks/:id/pause`：暂停并撤销订阅。
- `GET /v1/tasks/:id/view?after=0`：完整 A2UI 快照；after 为已接收版本时返回增量或空列表。
- `GET /v1/device/tasks/:id/commands`：该订阅的 watch / stop 命令。
- `POST /v1/device/tasks/:id/ack`：确认安装，body 为 commandId。
- `POST /v1/device/tasks/:id/events`：eventId、sequence、observedAt、meeting(title/agenda/startAt)。

服务首次运行在忽略目录 `data/meeting-lab-identities.json` 生成两个随机用户凭据；服务器文件权限 600。验收脚本只在内存读取，不输出、不写报告。设备 token 只在创建响应中返回，数据库仅存摘要。它们用于实验身份模拟，不是正式登录系统。生产需替换 OIDC / 组织鉴权、设备注册与凭据轮换。

本地：`npm.cmd test`。服务器：

```bash
cd /home/ubuntu/xagent-mastra-lab
python3 scripts/verify-meeting.py --container xagent-mastra-lab --mode deepseek --restart
```

脚本只创建四个任务并触发有限运行，结束后暂停自己的任务；报告不保存凭据。重启测试会先检查其他活动实验，避免打断。既有 `.env` 和模型 key 保留。

## A2UI 校验依据

`docs/vendor/a2ui/` 保存官方 v0.9.1 路径下的消息 Schema、common types、Basic catalog 和 Apache 2.0 许可，来源提交记录在 REVISION。官方该版本的 catalogId / schemaId 仍使用 v0_9 路径，保留其原值，不拼出不存在的 catalogId。

Ajv 2020 校验消息和 catalog 引用；本实现只输出 Column / Text 与数据绑定，不使用格式敏感的 URL / 日期组件，因此未启用格式断言。官方消息 Schema 的相对 `catalog.json` 绑定到所选 Basic catalog。协议结构校验通过不等于真实客户端渲染已验收：本次没有部署 A2UI 渲染器，也没有验证交互回调。

## 失败与生产差距

- 单进程 SQLite 调度，不能让多个副本直接共享该目录；无分布式锁或全局速率限制。
- 当前每 100 毫秒扫描任务，适合小规模验证；大量任务应改为索引查询待处理状态或事件唤醒 / 队列，并增加日志保留策略。此次没有做容量测试。
- 崩溃后允许重新执行只读推理，结果由 revision 控制提交；不承诺模型计费恰好一次。不是外部写操作的通用恢复方案。
- 模型最多五步、单次运行 60 秒超时；失败保留已发布页面，并标记任务错误。修改 instruction 可显式创建新 revision 重试，不无限自动重试。
- 新输入可以合并为最新视图，不保证为每个中间事件各生成一份页面；所有接受事件仍保留。
- 暂停会下发 stop 命令，但未实现端侧撤销确认、订阅租约、心跳、离线补报或真实手机后台运行。
- 目前通过轮询取页面 JSON，未做真实 A2UI 客户端、推送、按钮动作、完整会话 Memory、定时刷新或外网搜索。这些分别是替换/补充适配器与触发源，不需要复制每个用户的 Agent。
- 已接入信息巡检作为第二个领域，见 [复用验证](second-agent-validation.md)；更复杂的执行模式、外部写操作与生产规模仍待验证。
- npm audit 当前遗留 Mastra 1.78.0 的 gray-matter / js-yaml 依赖链 5 项 moderate 报告；本实验不加载外部 Markdown 技能。正式部署前单独升级框架并做恢复回归，避免此次混合升级改变已验证行为。

## 结果

2026-10-22 已在 tencent-server 完成真实 DeepSeek 验收：[meeting-verification.json](meeting-verification.json)。6 组服务器验收全部通过，包含 4 个任务、7 次真实模型运行、一次停止服务后已落库事件的恢复；整个脚本耗时 32.452 秒。每次运行均调用检索和提交工具，单次执行约 4.1–7.3 秒（含工具循环；不含排队，只有这个小样本）。两名用户各两个任务均已暂停，未留下自动持续调用。

本地 `npm.cmd test` 共 16 项测试通过，包含原设备调用回归，以及上述隔离、版本竞争和页面快照一致性测试。服务器部署还通过原设备实验的 6 组检查。

结论：这个特定闭环可以沿用 Mastra。第二个领域已完成公共接口复用，新增验收记录与上述历史单领域报告分别保存；当前本地测试共 24 项通过。该报告不构成手机可靠性、生产多租户安全、规模或通用 Agent 质量的证明。
