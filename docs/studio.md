# 本地 Mastra Studio：出行助手

## 启动和查看

需要 Node.js 24+。在项目根目录执行：

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run studio
```

打开 http://127.0.0.1:4111，选择「出行助手」。点击输入框下方的 **Request context**，选择「延吉三日游（模拟，不联网）」预设，点击 **Save**，然后发送：

> 安排延吉三日游，偏重美食和步行，节奏轻松一些。

模型和浏览器动作都在 mock 模式模拟，回复及来源会标记 `[MOCK]`，图片 URL 是测试值。展开 **SubmitTripPlan** 的工具返回，可查看 `artifact.output` 中的完整行程、来源、图片，以及 `artifact.view` 中通过官方 Schema 校验的 A2UI 数据。Studio 展示的是聊天和工具 JSON，不会自动把 A2UI 数据渲染为专属行程页面。

Studio 使用 `data/studio/mastra.db` 保存调试会话，可刷新页面查看历史。它不启动任务调度器，不打开正式任务数据库，不发布或修改正式任务。仅监听本机回环地址；CLI 遥测由启动脚本关闭。

如 4111 被占用，可在 `.env` 设置 `STUDIO_PORT=4112`；也可设置独立的 `STUDIO_DATA_DIR`。`npm run dev` 仍启动原有任务服务，`npm run studio` 启动独立的 Mastra 开发服务，两者可同时运行。

## 真实模型与浏览器

本地 `.env` 需要 `DEEPSEEK_API_KEY`，并按需设置 `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL`。密钥只从服务端环境变量读取，不填入 Studio 上下文。服务器已有的密钥不会自动出现在本机。

真实浏览器需要可用的 Chromium，可通过 `CHROMIUM_PATH` 指定。然后选择「延吉三日游（DeepSeek + 浏览器）」预设运行；会产生实际 API 用量和网页访问。当前原有服务器 Docker 镜像包含 Chromium，本次没有部署或重启该服务器。

## 代码边界

- `src/mastra/index.ts`：标准 Mastra 入口，仅注册已迁移的出行助手；LibSQL 和 Memory 用于 Studio 会话。
- `src/agents/travel.ts` 的 `createTravelAgent()`：Studio 和任务系统共用的 Agent、模型选择、指令、处理器和工具。
- `src/agents/travel-context.ts`：校验配置、建立每次执行的状态、管理资源清理。内部状态是服务端类实例，不接受 JSON 冒充。
- `src/tools/browser.ts`：只依赖浏览器运行参数，不依赖任务数据库或完整 Task 对象。
- `travelDefinition.prepareContext()`：把持久任务快照转换为原生 RequestContext，把校验后的输出交还任务调度器。
- `src/tasks/runtime.ts`：继续管理调度、用户并发、取消、运行记录和版本检查后的正式发布。
- `src/tasks/view.ts` 的 `displayView()`：两种入口共享的 A2UI Schema 强制校验；任务发布前仍再次校验。

原有参会准备和信息监测 Agent 暂未迁移进 Studio，其任务 API 保持可用。没有为本次接入新增通用执行引擎。

## 每次执行与历史

在 Request context 中明确指定 `config.destination`、`config.days` 和 `mode`。每轮使用最新用户消息作为规划要求；目的地和天数不会从自然语言自动提取。修改目的地或天数时，先修改上下文并 Save。历史对话保留用于查看，但每次规划重新收集来源，不把上一轮的工具结果当成本轮证据。

普通 SDK 调用使用新建的 RequestContext。任务系统每次都创建新的上下文。模型选择不依赖任务运行表；没有配置也可列出 Agent，真正执行时必须通过配置校验。

Studio 的线程消息入口与直接 `agent.stream()` 不完全相同：`sendMessage()` 可用用户 signal 唤醒线程。输入处理器保留原始用户消息和系统/信号消息，通过标记的系统消息传递本轮配置，不向聊天记录追加内部参数 JSON；不能假设处理器收到的一定是普通 `role:user` 消息。

成功提交工具返回完整 artifact 后，真实模型会据此回复中文摘要和链接。mock 仅用于协议与执行链路验证，不评价模型规划质量。

## 验证

```powershell
npm.cmd test
node scripts/verify-studio.mjs
```

原有任务、事件、设备暂停恢复和 A2UI 测试继续执行。新增原生 generate/stream、Studio sendMessage、上下文隔离、重复调用、异常/取消清理、无效输入及 A2UI 拒绝发布测试。模拟清理测试验证执行状态关闭、证据会话释放，不代表已经实测本机真实 Chromium 进程退出。

`verify-studio.mjs` 需要 Studio 已启动，使用标准 HTTP API 运行 mock 验收，检查结果、工具链、A2UI 数据，以及默认正式任务文件未变化，报告写入 `docs/studio-verification.json`。它不调用真实模型或浏览器。

Studio CLI / Memory 是开发依赖；现有 Docker 部署继续运行任务 API。本次没有把 Studio 暴露到公网，也没有改为生产 Studio 部署。

## 本次本地验收

2026-10-22：`npm.cmd test` 共 34 项通过，其中 8 项为本次新增的原生 Agent / Studio 入口测试。标准 HTTP 验收通过：5 次工具调用、3 天行程、2 张模拟图片、3 条 A2UI 消息，默认正式任务文件摘要未变化。结构化报告见 [studio-verification.json](studio-verification.json)。

通过实际 Studio 页面发送了两轮规划要求，均显示 5 个成功工具步骤和对应回复；展开 SubmitTripPlan 可见完整 artifact，刷新页面后历史仍保留。此轮是 mock 验收，没有重跑 DeepSeek 或真实 Chromium，也没有修改服务器部署。界面记录：

![Studio 中的出行助手模拟回复](studio-preview.png)

参考：[Studio](https://mastra.ai/docs/studio/overview)、[RequestContext](https://mastra.ai/docs/server/request-context)、[Processors](https://mastra.ai/docs/agents/processors)。
