# XAgent

基于 Mastra 的专用 Agent 服务端开发实验：复用模型、工具、业务校验与任务运行层，开发不同用途的 Agent 和 Workflow。当前聚焦后台能力；业务结果保留 A2UI Schema 强制校验，客户端渲染由具体产品决定。

## 已实现的能力

| 能力 / ID | 原生调用与 Studio | 持久任务 `/v1/tasks` |
| --- | --- | --- |
| 出行助手 `travel-assistant` | 行程、网页来源和图片元数据；真实模式使用 Chromium | 用户请求创建后执行，可修改要求重新规划 |
| 参会助手 `meeting-prep` | 根据输入会议与授权资料生成简报 | 合成日历事件触发、用户刷新 |
| 信息巡检 `information-watch` | 比较观察和基线，给出提醒决策 | 合成事件触发、基线与结果版本管理 |
| 资料摘要模板 `reference-summary` | 新 Agent 的最小开发示例 | 尚未提供适配器 |
| 参会 Workflow `meeting-brief` | 校验输入 → 参会 Agent → 校验产物 | 尚未提供适配器 |

一个 Agent 定义可服务多个用户和任务。Studio 注册、持久任务登记是独立入口；全局注册 Workflow 后从 Studio 的 Workflows 进入。Studio 预览不会创建订阅或发布正式任务结果。

已验证真实 DeepSeek API、Studio 页面调用及发布回退，详见 [2026-10-23 验收](docs/workflow-validation.md)。真实浏览器已用于出行检索；手机、日历事件和测试资料仍为合成输入，巡检的 `notify` 只是决策字段。生产登录与组织权限、多实例、长期负载、Workflow 中途崩溃恢复尚未完成验证。

## 本地快速开始

需要 Git、Node.js 24+、npm、Python 3.12+。包脚本调用 `python`，请确认该命令可用且版本正确。以下为 Windows PowerShell；Linux 使用 `npm` / `npx`，也需提供 `python` 命令。

```powershell
git clone https://github.com/TheodorePai/XAgent.git
cd XAgent
node --version
python --version
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run check

# 首次离线启动：无需模型 key，也不访问真实浏览器
$env:XAGENT_DEFAULT_MODE = 'mock'
npm.cmd run studio
```

仓库已公开，可直接 clone。已有工作区可跳过 clone / cd。Linux 的离线启动命令是 `XAGENT_DEFAULT_MODE=mock npm run studio`。

打开 [本地 Studio](http://127.0.0.1:4111/agents)，选择「资料摘要助手（模板）」，在 **Request context** 选择「资料摘要（服务默认模型）」并 **Save**，发送「提取负责人、超时规则和回滚要求」。展开 `SubmitSummary`，核对 `accepted: true`、`artifact.output`、`artifact.view` 和最终回复。固定的脚本模型会标记 `[MOCK]`；它验证执行链路，不评价生成质量。

真实模型调试：停止离线 Studio，在本地 `.env` 配置凭据（字段见 [.env.example](.env.example)），再执行以下命令。密钥属于运行服务的机器；服务器的 key 不会自动传到本机。

```powershell
$env:XAGENT_DEFAULT_MODE = 'deepseek'
npm.cmd run studio
```

已有 Request context 的显式 `mode: mock` 仍会覆盖默认值；删除该字段并 Save，或改为 `deepseek`。真实出行助手还需 Chromium，详见 [Studio 使用说明](docs/studio.md)。

## 入口、模式与数据

| 入口 | 省略 mode 时 | 默认监听 / 数据 |
| --- | --- | --- |
| 本地 Studio：`npm run studio` | DeepSeek；可由 `XAGENT_DEFAULT_MODE` 覆盖 | `127.0.0.1:4111`；`data/studio/mastra.db` |
| 独立 SDK Agent / Workflow 工厂 | `XAGENT_DEFAULT_MODE`，未配置则 mock | 调用方管理；工厂不自动启用聊天 Memory |
| 任务服务：`npm run dev`，含 `/v1/tasks` 与原 `/runs` | mock；任务保存自己的 mode | `127.0.0.1:4391`；`data/` |
| 服务器受管 Studio | 入口默认 DeepSeek，可被服务环境覆盖 | `127.0.0.1:4411`；独立 Studio 库，需 SSH 转发 |

请求显式模式优先。真实模式缺 key 会报错，不会回退为 mock。不同进程可以运行不同版本；以上是代码默认值和参考端口，实时状态用 `npm run studio:status` 查询。任务服务的 `npm start` 需要先 `npm run build`。

## 开发、验证与发布

- [开发指南](docs/development.md)：新增 Agent 写在哪里，如何注册、调用、测试及接入持续任务。
- [Workflow 指南](docs/workflows.md)：固定步骤、输入样例、SDK 和 Studio 运行。
- [架构与实现边界](docs/architecture.md)：Mastra、任务层、设备层及用户隔离分别负责什么。
- [统一验证与 Studio 发布](docs/operations.md)：`npm run check`、真实 API、部署、查询和回退。
- [文档索引](docs/README.md)：操作指南、历史验收与原设备实验；开发约束见 [AGENTS.md](AGENTS.md)。

依赖版本由 [package.json](package.json) 和锁文件固定。新增能力以当前源码契约为准，历史报告仅证明注明版本与场景；测试数量和临时部署记录保留在对应验收报告中。
