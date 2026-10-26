# 首次出行 Studio 接入与真实验收（2026-10-22）

以下为当日记录。测试数量、容器资源、工作目录、线程与“当前”均指当时环境，不作为今天的部署或浏览器状态证明。现行使用方式见 [Studio 指南](studio.md)，部署方式见 [运维入口](operations.md)，后续模板和 Workflow 验收见 [2026-10-23 报告](workflow-validation.md)。

## 本次本地验收

2026-10-22：`npm.cmd test` 共 34 项通过，其中 8 项为本次新增的原生 Agent / Studio 入口测试。标准 HTTP 验收通过：5 次工具调用、3 天行程、2 张模拟图片、3 条 A2UI 消息，默认正式任务文件摘要未变化。结构化报告见 [studio-verification.json](studio-verification.json)。

通过实际 Studio 页面发送了两轮规划要求，均显示 5 个成功工具步骤和对应回复；展开 SubmitTripPlan 可见完整 artifact，刷新页面后历史仍保留。上述首轮是 mock 验收；随后补做的真实验证见下节。界面记录：

![Studio 中的出行助手模拟回复](studio-preview.png)

## 改造后的真实验证

2026-10-22 在 tencent-server 的独立验证目录、隔离数据和临时容器中，使用提交 `0524c76` 的源码和锁文件构建标准 Mastra 服务。密钥通过服务器已有的 env 文件注入临时容器，没有复制回本机或写入报告。

通过 `POST /api/agents/travel-assistant/generate` 执行一轮 `mode=deepseek`：DeepSeek `deepseek-flash` 实际调用 AgentBrowser / Chromium。共 4 次搜索、3 次页面读取、1 次图片整理、1 次计划提交；耗时 52.221 秒，得到 3 天行程、3 个来源页面、4 张网页加载图片及 3 条通过校验的 A2UI 消息。Mastra 汇总用量为 54,169 tokens。模型最终回复及原始结果见 [真实验证报告](studio-real-verification.json)、[可读行程](yanji-studio-real.md)。

3 个来源页面来自腾讯和搜狐，其中两个页面转载了同一篇文章；这证明真实调用链可运行，不代表旅行信息已由三个独立来源交叉核验。图片说明来自网页，未逐张目视核验。

请求结束后检查临时容器的 `/proc`，未发现 Chromium / agent-browser 残留进程。正式服务的 14 个任务、运行记录及数据库内容摘要与验证前一致，活跃任务和运行中记录均为 0。验证容器均已停止并移除；正式服务未更新或重启。

首次启动遇到 Studio 构建超过 Node 默认约 512 MiB 堆上限，尚未发出模型请求。随后在独立构建进程中使用 768 MiB 堆、单构建并发完成构建，再直接运行 `.mastra/output/index.mjs`，不同时保留开发构建监听器。成功的真实请求运行在 768 MiB 容器预算内；应区分开发构建开销与 Agent API 的运行开销。

真实验证脚本是 `scripts/verify-studio-real.mjs`，供带有 Chromium、服务器端密钥和标准 Mastra 服务的隔离容器执行；默认只请求本机 4411 端口、只运行一轮，不会暗中回退 mock。报告写入容器 `/app/data/studio-real-verification.json`。复现时应使用独立数据目录，不指向正式任务数据。

## Studio 页面真实调用验收

2026-10-22 补做实际浏览器聊天验证：从 Studio 输入框发送延吉三日游要求，使用 `mode=deepseek` 和服务器已有密钥，成功收到 `deepseek-flash` 的流式工具调用及最终中文回复。此前的 HTTP generate 验证不能代替这项界面验证。

本轮共 9 次工具调用：3 次搜索、3 次网页读取、1 次图片整理、2 次计划提交。第一次提交因为每天活动数量及多余字段被 Schema 拒绝，模型根据错误反馈修正，第二次返回 `accepted: true`。最终 artifact 包含 3 天行程、3 个来源页面、4 张网页加载图片和 3 条经过校验的 A2UI 消息；聊天回复提供图片链接，没有内嵌图片预览。刷新后真实会话历史仍保留。报告见 [studio-real-ui-verification.json](studio-real-ui-verification.json)。来源包含转载文章，不代表三个独立来源交叉验证。

![Studio 中真实 DeepSeek 回复](studio-real-ui.png)

第一次界面请求在原 768 MiB 容器中触及 Node 默认堆上限，进程退出；这轮不计通过。重试把独立 Studio 容器调整为 1280 MiB，显式设置 `NODE_OPTIONS=--max-old-space-size=768`，成功完成。请求结束后容器内存约 675 MiB，未发现 Chromium / agent-browser 残留进程；正式服务 14 个任务及运行记录内容摘要未变化。这是单轮成功验证，尚未验证长时间运行或并发容量。

本轮重试明确要求最多搜索三次，再读取页面。原提示词在政府来源无结果时可能反复搜索，不能据此声称默认检索策略已经足够稳定；后续应在工具层为页面读取预留预算并改善无结果反馈。

真实 Studio 保留在服务器容器 `xagent-studio`，仅监听 `127.0.0.1:4411`，使用独立 `data/studio`；密钥仍只在服务器。当前本机通过 SSH 转发访问，原来的本地 `4111` 页面仍是 mock 会话。转发断开后可重新建立：

```powershell
ssh -N -L 127.0.0.1:4411:127.0.0.1:4411 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 tencent-server
```

[打开本次真实会话](http://127.0.0.1:4411/agents/travel-assistant/threads/02ba92f2-2061-4308-b3ec-1f0c16759c8d)。当前浏览器上下文已设为 `{"config":{"destination":"延吉","days":3},"mode":"deepseek"}`。如果重设上下文，在 Request context 编辑器输入后点击 Save，并确认模型显示 DeepSeek；编辑器仅修改 DOM value 不会更新应用状态。

参考：[Studio](https://mastra.ai/docs/studio/overview)、[RequestContext](https://mastra.ai/docs/server/request-context)、[Processors](https://mastra.ai/docs/agents/processors)。
