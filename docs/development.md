# 扩展开发指南：Agent 与 Workflow

适用于仓库锁定的 Node 24 / Mastra 版本。先读根目录 [AGENTS.md](../AGENTS.md) 的边界与验收规则；本指南说明具体开发路径。首次安装与离线启动见 [快速开始](../README.md#本地快速开始)，统一验证和服务器发布见 [运维入口](operations.md)。

本文模板与 Workflow 的真实 API、Studio 页面及部署回退结果见 [验收记录](workflow-validation.md)。

## 1. 先选择扩展类型

| 需求 | 入口 | 需要编写的内容 |
| --- | --- | --- |
| 一个明确外部操作 | `src/tools/` | 工具输入/输出、权限检查、超时和清理 |
| 根据目标自主检索、判断、生成 | `src/agents/` | 原生工厂、业务 Schema、工具组合、结果提交 |
| 多个有明确顺序的步骤 | `src/workflows/` | 步骤 Schema、执行顺序、失败及取消处理 |
| 持续订阅、事件驱动、用户刷新 | `src/tasks/` 的现有适配契约 | AgentDefinition、事件与配置、基线和版本发布规则 |

用户和任务是数据实例，不为每个用户复制一个 Agent 定义。Workflow 的步骤可以调用普通代码、工具或 Agent；只有需要模型判断的步骤才调用模型。

## 2. 开发前准备

需要 Node.js 24+、npm、Git 和 Python 3.12+，且 `python` 命令可用。在仓库根目录执行以下命令；Windows 使用 `npm.cmd` / `npx.cmd`，Linux 使用 `npm` / `npx`。

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run check
```

本地 Studio 使用本地 `.env`；服务器 key 不会自动出现在本机。纯离线调试设置 `XAGENT_DEFAULT_MODE=mock`，真实模式需要服务端已有 `DEEPSEEK_API_KEY`。不要把 key 放入 RequestContext、Workflow input 或 Git。

先确定职责、可访问资料/设备、输入、输出、副作用、步骤/时间预算，以及成功和失败的代表性样例。

## 3. 可运行的 Agent 最小模板

以 [src/agents/reference.ts](../src/agents/reference.ts) 的 `createReferenceAgent()` 为起点。它已注册为 `reference-summary` /「资料摘要助手（模板）」：

```text
用户要求 + 授权资料
    → 输入校验与本轮状态
    → searchReferenceNotes
    → submitSummary（来源、业务 Schema、A2UI 校验）
    → 中文摘要和来源编号
```

该模板只适合小型授权资料检索与摘要。浏览器类型参考 `travel.ts` / `travel-context.ts`；新的设备或长等待工具应使用相应协议和持久账本，不把全部业务都塞进 notes。

复制模板时逐项修改：

| 修改项 | 位置与要求 |
| --- | --- |
| 稳定 ID、中文名称、处理器 ID | 使用自己的业务标识，避免执行状态键冲突 |
| 工厂名 | 导出 `createXxxAgent()`，由不同入口复用 |
| 输入和输出 Schema | 约束大小和合法值，输出保留可核对的来源 |
| instructions | 描述职责、资料边界、工具顺序及最终回复要求 |
| 工具 | 只开放该业务需要的能力，服务器确定授权范围 |
| 提交检查 | 校验业务结果、实际来源和展示 JSON，再返回 accepted / artifact |
| mock 策略 | 更新 scriptedModel 的工具名、输入和输出；真实失败不得回退 mock |
| 预算和清理 | 成功、异常、取消、超时都释放本轮资源 |

模式继续复用 `resolveModel()` 与 `executionModeSchema`。资料类可复用 `notes-context.ts` 的可信运行状态；其他业务建立自己的运行上下文。完整 Task、凭据、数据库和发布回调不能作为模型输入。

## 4. 注册与 Studio 调试

在 `src/mastra/index.ts` 的 `agents` 中增加工厂实例，沿用独立 Memory 和 Studio guard。按实际业务添加 `studio-presets.json` 示例。

```ts
import { createReferenceAgent } from '../agents/reference.js';
// 在当前入口已有的 agents 对象中登记：
// referenceAgent: createReferenceAgent({ memory: memory(), guard })
```

```powershell
npm.cmd run studio
```

打开本地 4111 或已部署服务器的 4411，选择助手，在 Request context 填入对应预设并 Save。摘要模板只需授权 notes；Studio 省略 mode 默认 DeepSeek，也可显式传 mock。聊天输入「总结负责人、15秒超时规则和回滚要求，保留来源编号」。

验收须实际发送，展开 SubmitSummary 核对 accepted、artifact.output 和 artifact.view，并查看模型最终回复。浏览器保存的显式模式优先于服务默认。

## 5. 直接 SDK 调用

在仓库根目录执行 `New-Item -ItemType Directory -Force .cache`，把下面代码保存为 `.cache/reference-example.ts`，然后运行 `npx.cmd tsx .cache/reference-example.ts`。Linux 用 `mkdir -p .cache` 和 `npx`。示例显式使用 mock，无需 key；`.cache/` 已忽略，不提交临时脚本。

```ts
import { RequestContext } from '@mastra/core/request-context';
import { createReferenceAgent } from '../src/agents/reference.js';

const agent = createReferenceAgent();
const requestContext = new RequestContext(Object.entries({
  mode: 'mock',
  notes: [{ id: 'reference-101', text: '负责人林舟，超时15秒停止。' }],
}));
const result = await agent.generate('提取负责人和超时规则', { requestContext });
console.log(result.text);
if (!result.text.includes('[MOCK]')) throw new Error('Expected mock result');
```

原生 Agent 可以独立使用；Studio 使用 Mastra 注册来获得页面、Memory 和服务接口。工厂直接调用省略 mode 时先读取 `XAGENT_DEFAULT_MODE`，未配置则 mock；Studio 入口会设置自己的 DeepSeek 默认值。SDK 真实调用需先加载凭据环境，例如 `npx.cmd tsx --env-file-if-exists=.env .cache/reference-example.ts`，并把示例 mode 改为 deepseek。每轮创建新上下文，或使用已有模块明确支持的上下文复用方式。

## 6. 什么时候接入持久任务

只需要聊天或单次 SDK / 原生 Agent API 的能力，注册 Studio 后即可独立运行。需要现有 `/v1/tasks` 生命周期时，再实现 [AgentDefinition](../src/tasks/types.ts)。

参考 `meetingDefinition`、`inspectionDefinition`、`travelDefinition`：

1. 定义配置 Schema、稳定 ID / version、运行预算和输出契约。
2. 用户主动请求可提供 initialEvent；监测类型提供 subscription 和 parseEvent。
3. prepareContext 将可信任务快照、事实、基线及资料转换为原生输入，并返回清理函数。
4. 提交结果通过可信的 onResult 绑定交给任务层，不能由模型提供回调。
5. 实现 validateOutput、display、fixture 和 prompt，在 `src/agents/registry.ts` 登记。
6. 测试事件幂等、用户隔离、刷新、暂停、版本竞争和重启恢复。

`reference-summary` 当前是原生 Agent 模板，未提供持久任务适配器。Studio 注册与任务 registry 是两个不同入口。持久任务层仍强制校验展示 JSON，发布前再次检查任务版本；预览成功不等于正式发布。

## 7. 新建 Workflow

从 [src/workflows/meeting-brief.ts](../src/workflows/meeting-brief.ts) 开始，完整示例见 [Workflow 开发与运行](workflows.md)。

1. 定义整个流程和每一步的输入/输出 Schema。
2. 用 createStep 编写普通代码或 Agent 调用，用 createWorkflow 串联并 commit。
3. 复用 Agent 工厂，传入最小授权上下文。传播 abortSignal，限定预算，不返回含推理和凭据的原始 Agent 响应。
4. 使用 `WorkflowLifecycle` 跟踪整个流程，成功、失败、取消时释放；使用 Studio guard 阻止排空时启动新流程。
5. 在 `src/mastra/index.ts` 的 workflows 登记，ID 与注册 key 保持一致；添加 workflow-inputs.json 示例。
6. 补本地、真实 API 和 Studio Workflow 页面验收。

当前示例是只读的三步流程，不包含挂起等待或外部写操作。新增 suspend / resume、外部回调或副作用时，需增加身份归属、执行账本、幂等与恢复验证。原生 Workflow 当前不直接接入 `/v1/tasks`；该入口的 TaskRuntime 仍调用 Agent。

## 8. 验证与交付

```powershell
# 针对模板与流程的本地行为检查
npx.cmd tsx --test --test-concurrency=1 tests/reference.test.ts tests/workflows.test.ts
# 完整本地验证
npm.cmd run check
# 提交通过本地验证的改动，再发布 Studio
npm.cmd run studio:deploy
# 真实模板 Agent API，一轮
npm.cmd run check -- --suite agent-api --agents reference-summary --mode deepseek
# 真实 Workflow API，一轮
npm.cmd run check -- --suite workflow-api --mode deepseek
```

以上远端命令针对已配置的 tencent-server，需要相应 SSH 与部署权限，不能直接作为任意新服务器的初始化脚本。远端命令要求干净提交和运行输入摘要一致。`all` 包含本地、Agent、Workflow 和隔离任务 API，仍不包含页面验收。

新增 Agent 的远端场景需要更新 `scripts/verify-agent-api.mjs` 的 definitions 和业务断言、`scripts/verify-server.py` 的允许 ID，以及 `scripts/project.py` 的默认选择。新增 Workflow 当前需为 `verify-workflow-api.mjs` 添加相应场景；该脚本目前只验证 meeting-brief。这仍是显式代码登记，不是自动插件发现。

报告注明实际构建提交、输入、模式、工具与 artifact、失败、用量和清理情况。涉及 Agent / 工具 / 流程链路的改动完成真实 API；涉及 Studio 同时实际点击页面运行并截图。新部署检查状态与真实结果，保留数据备份和旧镜像。

一个新能力交付前应能回答：输入与权限从哪里来；成功的 artifact 是什么；哪些入口已注册；预算与失败如何收尾；真实 API 和受影响 Studio 页面的证据在哪里。需要持久任务的，再检查事件、归属、基线和版本发布。规则与最低验证以 [AGENTS.md](../AGENTS.md#7-验证要求用户明确要求必须保留) 为准。

## 9. 团队分工建议

公共运行层负责身份、任务、数据版本、资源管理和部署；业务开发者负责 Agent / Workflow、业务 Schema、工具组合与样例；工具适配者负责真实外部系统。契约通过 Schema 和行为测试协作，不能让业务 Agent 绕开公共授权和发布规则。

当前适合开发者在同一代码库内新增专用能力。真实用户登录、生产权限、多实例运行、Workflow 接入持久任务和长期负载，按实际需求单独设计与验收。
