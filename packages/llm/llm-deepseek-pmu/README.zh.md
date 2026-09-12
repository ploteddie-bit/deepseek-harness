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

<a id="dev-note"></a>
## 开发备注

该路由复用 `@deepseek-ai/dsh-llm-deepseek` 的 `DeepSeekAdapter` 及其解析逻辑，拥有独立的 provider 路由，且从不修改 `llm-deepseek`。
