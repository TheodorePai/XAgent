# 出行助手：原生浏览器工具验证

范围：服务端生成计划与图片元数据；不开发客户端、不预订或支付。验证目的地为延吉，默认三天，出发地、日期和预算未指定时在结果中说明假设。

本地出行助手现已支持标准 Mastra Studio 调试，与任务 API 复用 Agent、工具和校验；使用方式及本次 mock 验收见 [studio.md](studio.md)。本文后面的服务器真实验证数据记录的是此前部署版本。

## 工具是怎样接入的

Mastra 支持两种浏览器接入：原生 Browser Provider，以及通过 MCP 加载浏览器工具。本实验使用官方 `@mastra/agent-browser@0.5.4`，与已有 Core 1.78.0 的 peer 版本范围兼容。它以 Playwright / agent-browser 控制服务器上的无头 Chromium，不需要搜索 API key。

官方 Provider 已有导航、快照、点击、输入和页面脚本等能力。当前出行任务在这些原生方法上注册三个只读工具，以增加来源绑定、网络限制、调用预算和结构化记录：

| 注册工具 | 能力 |
|---|---|
| browserSearch | 用 AgentBrowser 打开必应搜索，提取指定政府 / 公开资讯来源（含媒体平台自媒体文章） |
| browserRead | 按本次运行发现的 sourceId 打开页面，取得正文和已加载图片 |
| browserImages | 返回已读取页面的图片 ID、URL、原页面、说明及加载尺寸 |
| submitTripPlan | 提交行程，校验引用和图片 ID，服务端附加实际来源元数据 |

工具代码位于 `src/tools/browser.ts`，可被其他 Agent 使用；出行业务在 `src/agents/travel.ts`，通过 registry 注册。现阶段工具和 Agent 在代码中登记，没有提供可视化工具市场或任意远程工具安装接口。

参考：[Mastra Browser](https://mastra.ai/docs/browser)、[AgentBrowser](https://mastra.ai/integrations/browsers/agent-browser)、[MCP](https://mastra.ai/docs/connections/mcp)。

## 请求与输出

认证后 `POST /v1/tasks`：

```json
{
  "name": "延吉三日游",
  "agentId": "travel-assistant",
  "mode": "deepseek",
  "instruction": "体验朝鲜族文化、美食与城市散步，希望附带图片",
  "config": { "destination": "延吉", "days": 3 },
  "notes": []
}
```

新增公共能力是“用户请求型任务”：创建时生成初始输入并运行，subscription 为 not_required，不返回设备 token。现有参会和巡检仍由设备 / 观察事件触发。修改 instruction 可以重新规划；暂停沿用共同接口。

`GET /v1/tasks/:id` 的 output 包括 destination、summary、assumptions、days、budgetEstimate、notes、sources、images。每个活动包含来源 ID；来源包含实际页面 URL、标题、读取时间。图片 URL 和 sourcePage 来自浏览器读取结果，由服务端附加，模型不能自行编造。至少读取两个不同页面才允许发布。

发布前 A2UI Schema 强制校验保持不变。现有 A2UI 文本适配显示每日活动，完整图片保存在业务 JSON 中，不为此新增客户端渲染。

## 运行与验证边界

- 每次运行独立 AgentBrowser 实例与线程，结束后关闭；同一运行内串行浏览，避免并行工具相互改变页面。浏览器状态和来源账本不跨用户或运行复用。
- 原全局并发 2、每用户并发 1 保留；出行 Agent 额外限制并发 1。每次运行最多 8 次浏览操作、10 个模型步骤、150 秒模型运行预算，单次导航有独立超时。
- 没有向模型暴露任意页面 JavaScript、文件访问、下载或提交表单工具。只读工具执行服务端持有的提取脚本；浏览器请求限制 GET、HTTP(S)、公共地址。内容导航只允许指定政府 / 新闻域名及当前运行搜索结果。
- 网络过滤是实验保护，不宣称是完整的网络隔离或浏览器沙箱；生产需要独立执行边界和更完整的出站策略。
- Chromium 配置 / 缓存放入容器临时目录，兼容只读根文件系统；开启 init 回收子进程，进程 / 线程上限从 128 调为 256。仍保持非 root、768 MiB 内存上限与浏览器并发 1。
- 实测服务器访问部分来源超时，百度返回验证页；这些不能当作成功页面。图片来自网页的已加载图像，不是生成图；说明来自网页元数据，未逐张目视确认，不推断图片授权。
- 未指定日期，不输出冒充实时查询的天气；预算只能标为估算或待核实，不声称查询过实时车票、酒店、门票或营业状态。
- mock 模式仍是脚本模型与测试网页数据，不联网，不是浏览器成功证据。真实验证使用服务器 DeepSeek 与 Chromium。
- 新 Provider 引入额外浏览器 / CLI 依赖。当前 npm audit 的 19 个报告（6 moderate、13 high，含继承项）已记录为实验依赖差距，部分来自 webdriverio 下载 / 代理依赖链。没有因此升级已锁定的 Mastra Core；不将当前演示视为已完成生产依赖治理。

本地验收 `npm.cmd test`；服务器真实验收 `python3 scripts/verify-travel.py`。既有任务在部署前检查为闲置并备份，验收脚本比较已有结果摘要。真实运行结果保存到 `docs/travel-verification.json`，本文件的运行结论以该报告为准。

## 实际结果

2026-10-22 已完成真实 DeepSeek + Mastra 原生 AgentBrowser + Chromium 验收：5 组检查通过。最终一轮耗时 49.479 秒，模型运行 48.707 秒，实际读取 2 个页面，输出 3 天行程、2 条来源与 3 张原页面图片；Mastra 汇总用量 46,530 tokens。浏览器操作为 6 次搜索、2 次页面读取，图片 / 计划提交另计工具调用。这说明能力可运行，也说明搜索质量与尝试次数会明显影响成本；不是生产响应时间保证。

来源实际为搜狐与腾讯平台旅游文章，模型在 notes 中注明未取得政府官网资料。引用与图片 ID 校验不等于旅行事实已逐项核实，时间、价格、路线与图片内容仍有资料质量局限。完整行程保存为 [yanji-trip.md](yanji-trip.md)，结构化结果和工具轨迹见 [travel-verification.json](travel-verification.json)。

首次模型运行因 Chromium 无法写入只读配置目录失败，记录保留在 [travel-attempt-1.json](travel-attempt-1.json)。通过独立浏览器检查定位并修正临时目录、子进程回收和线程预算后重跑通过，不用模型知识代替失败的浏览结果。最终一轮用量不包含该次失败和独立浏览器检查。

原有 12 个任务的已发布结果摘要保持一致。本地共 26 项测试通过，部署后原设备实验 6 组检查通过。真实验证任务结束后暂停，不保留运行中的浏览器或持续模型调用。

本地回归曾遇到 Windows 子进程启动超过旧的 12 秒限制，启动失败的辅助函数又未清理子进程，导致该次测试挂起。已增加启动失败清理，将服务启动等待调整为 30 秒，并将各文件的端到端测试串行执行以避免资源竞争；同一服务内的多用户并发测试仍保留。
