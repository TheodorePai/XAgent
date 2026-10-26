# 文档索引

从 [项目首页](../README.md) 开始：能力清单、离线快速启动、默认模式及端口集中在那里。下列指南随实现更新；验收报告保留事件发生时的版本、数据和结论。

## 日常开发与操作

| 文档 | 用途 |
| --- | --- |
| [开发规则](../AGENTS.md) | 开发范围、代码边界、真实 API / 页面验收、凭据与交付约束 |
| [架构与边界](architecture.md) | 已实现的层次、Agent / Workflow / Task 关系、待建设能力 |
| [扩展开发指南](development.md) | 新 Agent / Workflow 的文件、注册、SDK、任务适配和验证 |
| [Studio 指南](studio.md) | 上下文、模型选择、工具结果、聊天历史、Workflow 入口 |
| [参会 / 巡检输入](notes-studio.md) | 业务上下文示例；末尾为首次接入历史 |
| [Workflow 指南](workflows.md) | 参会流程、输入、SDK、取消和恢复边界 |
| [统一验证与部署](operations.md) | 当前 tencent-server 的受管 Studio 构建、排空、备份和回退 |
| [原设备调用实验](device-lab.md) | `/runs`、模拟手机、暂停恢复与原任务服务部署 |

## 验收与历史资料

按日期和范围阅读；这些报告不证明服务器今天的状态，数量、资源和路径也不作为当前默认配置。查询实时部署使用运维指南的 status 命令。

| 范围 | 报告 |
| --- | --- |
| 2026-10-23，模板与原生 Workflow | [本地、真实 API、Studio 页面、发布回退](workflow-validation.md) |
| 2026-10-23，统一默认模式 | [真实模型及三个业务助手](default-mode-validation.md) |
| 独立部署与统一 CLI 首次验收 | [发布、回退和数据保持](operations-validation.md)；[实施计划](operations-plan.md)仅作历史背景 |
| 参会 / 巡检原生工厂首次接入 | [接入说明与历史验收](notes-studio.md) |
| 出行浏览器首次验证 | [工具与历史结果](travel-assistant.md)、[任务行程](yanji-trip.md) |
| 出行 Studio 首次验证 | [失败与重试记录](studio-history.md)、[Studio 行程](yanji-studio-real.md) |
| 多种持久任务与设备事件 | [第二种 Agent](second-agent-validation.md)、[首个参会闭环](meeting-validation.md) |
| 原手机工具实验 | [本地与服务器实验记录](experiment.md) |

各报告链接到对应 JSON、截图和源码提交；A2UI 固定 Schema 来源见 [vendor 说明](vendor/a2ui/README.md)。

## 维护方式

入口指南只陈述当前源码支持的行为。新能力同步更新首页能力表、相关操作指南和验证场景；新增真实验收单独记录日期、构建提交、模式、结果及限制。历史失败、测试数量和运行数据保留原意，避免改成今天的结论。新增文档从本索引或所属指南链接，减少孤立文档。
