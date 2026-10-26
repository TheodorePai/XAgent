# Mastra Studio 使用与调试

Studio 是原生 Agent / Workflow 的开发调试界面，读取 `src/mastra/index.ts` 的注册结果。Agent 的业务逻辑仍写在 TypeScript 工厂中。当前能力清单与各入口模式见 [项目首页](../README.md#已实现的能力)，开发方式见 [扩展指南](development.md)。

## 启动与模型选择

完整离线安装、启动和首轮操作见 [快速开始](../README.md#本地快速开始)。本地默认端口 4111；通过环境变量 `STUDIO_PORT` 可修改端口，`STUDIO_DATA_DIR` 可指定独立数据目录。`npm run dev` 启动 4391 任务服务，`npm run studio` 启动 Studio，两个进程可同时运行。

Studio 入口默认 DeepSeek；离线启动需设置 `XAGENT_DEFAULT_MODE=mock`。请求的显式 `mode` 优先，旧会话保存的 `mode: mock` 不会因为服务器切换默认模型而改变。删除该字段并 **Save** 才采用服务默认。列表的 Provider 元数据与实际执行共用模型解析；查询列表不调用付费模型，但真实默认模式仍需要配置 key。

凭据只放在运行 Studio 的机器环境 / `.env`。本机没有服务器 key 时，可使用服务器已部署的 Studio；访问与状态检查见 [运维指南](operations.md#状态数据与访问)。参考服务器入口是 [4411](http://127.0.0.1:4411/agents)，需 SSH 转发，不能据页面地址推断服务正在运行。

## Agent 调试

1. 选择助手，在输入框下方打开 **Request context**。
2. 从 [studio-presets.json](../studio-presets.json) 选择对应预设并 **Save**。构建后的服务器页面没有预设选择器时，粘贴该条目的值，而非整个文件。
3. 输入用户要求并发送；核对工具返回、最终回复和本轮使用的模式。

出行填写 `config.destination` / `config.days`；参会填写 meeting / notes；巡检填写 observation / 可选 previous / notes；摘要模板填写非空 notes。业务输入须按对应 Schema 提供，不能仅写一段自然语言就省略必需字段。参会、巡检完整例子见 [上下文示例](notes-studio.md)。

提交工具应返回 `accepted: true` 和完整 `artifact`。`artifact.output` 是业务结果，`artifact.view` 是通过 A2UI Schema 校验的 JSON；Studio 展示聊天和工具数据。客户端页面渲染不在本仓库当前验证范围内。

出行每轮使用最新用户要求，但目的地和天数从 Request context 读取；改变目的地时先更新上下文并 Save。每轮重新收集来源，不把上一轮工具结果当成本轮证据。巡检的基线也来自显式输入，聊天历史不会自动成为已发布基线。

真实出行使用 `@mastra/agent-browser` 和 Chromium；可用 `CHROMIUM_PATH` 指定可执行文件。服务器 Studio 镜像内包含 Chromium。本机只需要摘要或参会调试时，无需为它们安装浏览器。出行来源与图片边界见 [浏览器说明](travel-assistant.md)。mock 模式使用测试网页和图片 URL，不访问网页。

## Workflow 与列表中的统计

从左侧 **Workflows** 打开 `meeting-brief`，把 [workflow-inputs.json](../workflow-inputs.json) 中对应值填入 **Workflow input** 并执行；离线运行显式加 `"mode": "mock"`，或继承服务的 mock 默认值。步骤、结果和 SDK 说明见 [Workflow 指南](workflows.md)。它的 input 与 Agent 聊天的 Request context 是不同入口。

Agent 列表中，Tools 统计该 Agent 注册的工具；Workflows / Agents 统计显式挂载在该 Agent 上的流程或子 Agent。当前各业务 Agent 使用自己的工具，未挂载 Workflow 或子 Agent，所以显示 `-` 是正常的；全局注册的参会流程出现在单独的 Workflows 页面。Provider 在 mock / 自定义模型配置下可能没有品牌标签，不能用标签判断真实请求是否成功，需核对运行记录与工具结果。

## 数据与代码边界

- `src/mastra/index.ts`：注册四个 Agent 和一个 Workflow，提供独立 LibSQL 存储、Agent Memory 和排空 guard。
- `src/agents/*.ts`：原生工厂、业务输入、工具和提交校验；`src/agents/model.ts` 统一模式与模型解析。
- `src/agents/travel-context.ts` / `notes-context.ts`：每轮可信执行状态、授权输入、证据和资源释放。
- `src/tasks/runtime.ts`：持久任务调度、取消、运行记录、版本检查与发布；通过定义的 prepareContext 复用原生工厂。
- `src/workflows/meeting-brief.ts`：独立三步流程，内部复用无聊天 Memory 的参会 Agent。

Studio 默认聊天库为 `data/studio/mastra.db`。Agent Memory 保留最近消息，关闭 semantic recall、working memory 和自动标题生成；Workflow 使用 Mastra 流程存储。Studio 不启动 TaskRuntime，也不打开正式任务库。手填 Request context 只用于可信调试，不能替代多用户身份鉴权。

原生 SDK 工厂不自动附加 Memory；每轮使用新的 RequestContext，或按现有模块明确支持的方式复用。Studio 的 sendMessage 可使用 signal 唤醒线程，输入处理器必须保留原消息和 signal，不能只假设普通 role:user 输入。更多约束见 [AGENTS.md](../AGENTS.md)。

## 验证与证据

使用 [统一验证入口](operations.md#统一验证)：本地回归、受管服务 Agent / Workflow API 分开验证。涉及 Studio 改动时，还须在实际页面发送请求，展开提交结果、检查最终回复；涉及历史时刷新确认持久化，并保存截图。CLI 的 all 不包含页面验收。

[模板与 Workflow 验收](workflow-validation.md)、[默认模式及三个业务助手验收](default-mode-validation.md)、[参会与巡检首次接入](notes-studio.md#2026-10-22-历史验收)分别保留对应版本的证据。[首次出行 Studio 记录](studio-history.md)保留早期 mock、真实 API、真实页面及失败重试，不能作为现行部署手册。
