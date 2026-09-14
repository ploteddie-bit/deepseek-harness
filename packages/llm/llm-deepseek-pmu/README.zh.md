---
description: "用独立 API key 运行第二条 DeepSeek 路由，让 PMU 凭据与官方凭据在 Models 页面中作为两个独立条目出现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-pmu

[English](README.md) | 中文

## 概述

你可以通过第二条独立路由访问 DeepSeek，它使用自己的 API key，而官方路由继续并行工作。两者在 Models 页面中显示为两个独立条目，因此你可以按会话选用其中一个并对比二者，而不必改动另一方的配置。仓库中不保存任何密钥：每次请求都从 `DEEPSEEK_PMU_API_KEY` 读取。当第二份凭据——共享或部门级的 key——需要与你的个人 key 隔离时，选择这条路由。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在启动环境中导出密钥：

```sh
export DEEPSEEK_PMU_API_KEY=sk-...
```

然后在 Models 页面或模型选择器中选中 `deep-pmu` provider。

| 设置 | 值 |
|---|---|
| Provider 路由 | `deep-pmu` |
| 显示名称 | `DeepSeek PMU` |
| 设置命名空间 | `llm-deepseek-pmu` |
| API key | `DEEPSEEK_PMU_API_KEY`，每次请求读取 |

-----

<a id="model-experience"></a>
## 模型体验

通过复用 `@deepseek-ai/dsh-llm-deepseek` 的 `DeepSeekAdapter` 间接影响；该适配器负责本路由所有模型可见的请求字段与响应渲染。

#### KV Cache 影响

本路由不添加任何自己的缓存行为：可复用前缀由复用适配器的请求组装、图片表示与推理回传决定，更换 API key 或端点会选中不同的提供方缓存域。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本路由在哪里停止、由复用的适配器接续。它们是当前包约束，不是任务积压。

- **`baseURL` 固定为 `https://api.deepseek.com`**——插件始终解析 `PUBLIC_BASE_URL`，且不提供 `baseURL` 设置，因此本路由无法指向 OpenAI 兼容网关。
- **只有 `apiKeyEnv` 可配置**——思考策略、图片预算、请求上限与重试策略都沿用 `resolveAdapterOptions` 提供的默认值。
- **通告目录只包含两个纯文本模型**——`deepseek-flash` 与 `deepseek-v4-pro`；本路由不声明任何支持图片的条目，也不声明使用 `systemPromptUpdate: in-history` 的模型，因此无法通告视觉能力或 in-history 系统提示词模式。
- **被拒绝的设置节会保留上一次可用的连接事实**——插件记录失败并继续服务，因此非法的 `llm-deepseek-pmu` 设置节会退化为先前的值，而不是让下一个请求失败。只有首次解析且没有可用历史值时才抛出。
- **provider 注册与孪生适配器的接线重复**——抽取共享的复用辅助函数被推迟，直到出现第三条需要它的路由。

<a id="dev-note"></a>
### 开发备注

该路由复用 `@deepseek-ai/dsh-llm-deepseek` 的 `DeepSeekAdapter` 及其解析逻辑，拥有独立的 provider 路由，且从不修改 `llm-deepseek`。

**运行时不变式：** 不发布伴生入口。本包在既有的 `ctx.llm` seam 上注册第二个适配器实例，没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。
