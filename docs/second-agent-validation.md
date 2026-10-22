# 第二种 Agent：信息巡检与服务端复用验证

日期：2026-10-22。范围：服务端，测试资料与模拟事件；不开发客户端，不发送通知。

## 验证目标与结果

验证新增专用 Agent 能否复用既有的身份、任务、设备凭据、事件去重、版本控制、调度、模型连接、运行记录、暂停与重启恢复。此次新增 `information-watch@1`，与 `meeting-prep@1` 注册在同一个 Mastra 实例，共用一套 `/v1/tasks` API 和任务存储。

最终一轮真实 DeepSeek 验收 8 组检查全部通过，四个新任务、九次模型运行（参会 3 次、巡检 6 次），用时 45.233 秒。单次运行 4.581–6.965 秒，不含排队；Mastra 汇总 `usage.totalTokens` 共 41,820。它是这轮样本的用量记录，不是供应商结算金额或容量测试。

本地 `npm.cmd test` 共 24 项测试通过，包含原有 16 项回归和新增跨业务、配置与事件校验、基线与静默决策、重启和旧文档兼容检查。部署后原设备实验的 6 组检查也通过。

- [最终真实模型报告](multi-agent-verification.json)
- [首次试跑记录](multi-agent-attempt-1.json)
- [代码规模记录](second-agent-code-size.json)
- [部署前历史结果摘要及备份位置](pre-second-agent-snapshot.json)

首次试跑中，参会模型检索三次后成功提交，脚本却要求工具调用序列只能包含一次检索，断言导致验收中断。已保留这份部分报告，暂停该次创建的四个任务。最终脚本允许多次检索，但要求必要工具在提交前执行、只使用该业务工具集、实际引用本任务资料并检查隔离；调用次数和用量仍记录。最终报告九次运行不包含首次中断试跑的用量，不将两个样本混成一次。

## 业务行为

信息巡检任务绑定一个 `config.sourceId`，收到观察后：

1. `readPreviousObservation` 读取上次成功发布的观察与当前观察，确定性比较 sourceId、title、content。
2. `searchReferenceNotes` 检索该任务的测试资料。当前小资料库仅排序并返回全部候选，不是外网或向量检索。
3. 模型结合用户关注点与资料，调用 `submitInspection` 提交摘要、判断依据与提醒决策。
4. 校验来源、变化分类与业务规则，再执行保留的 A2UI Schema 强制校验；版本仍匹配时发布。

业务输出示例（摘录结构）：

```json
{
  "change": "changed",
  "notification": "notify",
  "summary": "维护由凌晨改至14:00–16:00，落在资料所述10:00–18:00开放时段，建议提醒并调整安排。",
  "findings": ["维护窗口影响服务可用性"],
  "sourceIds": ["本任务绑定的来源ID", "本任务检索资料ID"]
}
```

`initial` 表示建立基线，`unchanged` 表示与上次发布内容一致，两者必须 `quiet`；有变化时模型根据关注点决定 `notify` 或 `quiet`。服务端会拒绝模型编造的变化分类、外部来源 ID，以及无变化时的提醒决策。`notify` 仅是记录的决策，不代表发出了消息。

比较基线选择“上次发布”，不是“上一个收到的事件”。模型执行中若有新版本，旧结果不得发布；后续运行与最后已发布结果比较。这与事件合并和只发布最新结果的既有策略一致。

## 共同 API 和兼容性

创建参会任务可以继续省略 `agentId`，默认 `meeting-prep`。创建巡检任务增加业务类型和配置：

```json
{
  "agentId": "information-watch",
  "name": "维护公告巡检",
  "mode": "deepseek",
  "instruction": "关注影响服务开放时段的重要变更",
  "config": { "sourceId": "maintenance-source" },
  "notes": [{ "id": "opening-hours", "text": "服务每天10:00至18:00开放。" }]
}
```

仍通过认证后的 `POST /v1/tasks` 创建。返回该任务的独立设备 token。使用该 token 接收 `watchInformation` 命令并 ACK，然后向 `/v1/device/tasks/:id/events` 上报：

```json
{
  "eventId": "由设备生成的UUID",
  "sequence": 1,
  "observedAt": "2026-10-22T11:00:00+08:00",
  "observation": {
    "sourceId": "maintenance-source",
    "title": "维护公告",
    "content": "维护改为14:00至16:00停机。"
  }
}
```

UUID 和时间需使用实际合法值。来源不符合任务绑定返回 403，错误业务事件结构返回 400，旧序号或冲突返回 409，暂停后事件返回 410。

`GET /v1/tasks/:id` 的 `output` 是对应业务结果，`publishedFact` 为该结果的完整观察快照。输入 revision 与 publishedRevision 仍分开。参会任务继续返回 `brief`、`briefMeeting`；旧 `src/meeting/*` 导入保留兼容入口，原验收脚本可继续使用。

数据文件与 `meeting_runs` 表保留旧名字，避免此次改动执行数据库重建。会议定义负责旧文档的内存规范化，公共存储不包含会议字段。已验证升级前四个会议任务的 brief 内容哈希与已发布版本保持一致，并有升级前 SQLite 备份。读取旧文档会增加通用 `output` / `publishedFact` 表示，不改变已有业务结果。

## 抽取了什么，新增了什么

| 代码 | 职责 |
|---|---|
| `src/tasks/types.ts` | 任务、事件、运行作用域与 AgentDefinition 契约 |
| `src/tasks/store.ts` | 共用身份、凭据、事件事务、去重、版本、暂停与运行记录 |
| `src/tasks/api.ts` | 共用 HTTP API；根据定义验证配置、事件和下发监测命令 |
| `src/tasks/runtime.ts` | 注册多个 Mastra Agent，共用并发限制、模型配置、取消与恢复 |
| `src/tasks/view.ts` | 共用 A2UI 消息构造与强制校验 |
| `src/tasks/tools.ts`、`fixture.ts` | 共用小资料库检索与脚本模型测试基础 |
| `src/agents/meeting.ts` | 会议事件、提示词、工具、输出与旧字段兼容 |
| `src/agents/inspection.ts` | 巡检配置、事件、基线比较、提示词、工具与输出规则 |
| `src/agents/registry.ts` | 一处登记两种业务定义 |

物理源码规模从 783 行变为 1,000 行，净增 217 行；公共任务模块 381 行，会议业务定义 73 行，巡检业务定义 85 行，兼容入口 28 行。另新增本地测试 154 行、服务器验收脚本 248 行，`package.json` 未变，没有增加依赖或常驻服务。统计包含空行和注释，不能换算为复用百分比或开发工时。

这次成本包含“抽取公共层 + 迁移会议实现 + 保留旧数据 / 接口 + 接入第二个业务 + 验收”，不能只拿 85 行业务定义代表全部开发成本。后续同类只读事件 Agent 可以以“定义 + 登记 + 评测样例”接入；需要外部写操作、特殊记忆或不同执行模式时，仍需增加公共能力或工具适配，尚未验证所有领域。

## 验收和维护成本边界

- 两用户各一项会议与一项巡检，共用全局两任务、每用户一任务的并发限制。本地检查混合运行时间区间；没有做吞吐、排队公平性或大规模容量测试。
- 重复 eventId 不增加运行；相同内容但新 eventId 仍运行模型，再输出 `quiet`。静默不是零成本，需要成本优化时可增加内容指纹过滤并区分用户主动刷新。
- 资料是按任务保存的小型候选集；新增真实来源时要实现采集与授权，不能仅改提示词。
- 服务器重启验收覆盖“事件已落库、尚未调度”的恢复及基线保留。本地还模拟运行记录处于 running 时的中断标记；没有宣称已验证所有模型请求中断或外部副作用恢复。
- 保留单进程 SQLite、轮询调度、演示身份、无分布式锁等原有边界；不属于生产级多租户平台。
- 原有四个历史会议任务及两轮试验新建任务均保留；验收结束均暂停，无持续模型调用。

可复现服务器命令：

```bash
cd /home/ubuntu/xagent-mastra-lab
python3 scripts/verify-multi-agent.py --mode deepseek --restart
```

脚本要求没有其他活动实验，读取实验凭据到内存，报告不含 token / key；只暂停自己创建的任务。下一阶段建议继续补服务端故障与并发测试，不扩展客户端渲染。
