---
description: "浏览器端的发送前安全扫描，标记草稿中的凭据、IP 与密钥，供选择或禁用该指示器的用户阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-pre-send-scan

[English](README.md) | 中文

## 概述

composer 草稿可能携带不应发送的内容——误粘贴的 API key、私钥、`Bearer` token 或内网 IP。本插件在本地扫描草稿，并显示一个标出最严重级别与命中数的彩色徽标。它是指示器，从不阻断：发送动作不会被拦截，草稿原样送达模型，扫描结果也不进入会话日志或模型上下文。扫描完全在浏览器内进行，无网络调用，对模型不可见。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

插件向 composer 右侧工具行贡献一个徽标。无需接线或配置；组合加入该行之前默认关闭。徽标在禁用时显示 `OFF`，启用且干净时显示 `OK`，启用且有命中时显示命中数。点击切换扫描开关，状态持久化在 `localStorage` 的 `dsh.pre-send-scan.enabled` 键下。徽标颜色按最严重命中级别：`critical`（红）、`warn`（琥珀）、`info`（蓝），未激活时灰色。

### 你会得到什么

检测到 API key、私钥或 GitHub/Slack token 时显示 `critical` 徽标；检测到 RFC 1918 或回环 IP、云签名 URL、`Bearer` token 或 `password=`/`passwd=` 式赋值时显示 `warn`；检测到 `~/.ssh/...` 等凭据文件路径时显示 `info`（此为草稿中的通用模式，特意不带机器前缀；在本机 Edy 上即 `Edy:~/.ssh/...`）。每条命中带一段简短上下文片段，上限约 80 字符。扫描在每个草稿上最多停在 20 条命中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

插件建立在三项承诺之上：

- **指示器，非阻止器。** 按钮观察草稿并在浏览器中报告命中；它从不拦截发送动作，因此模型请求不变。
- **仅本地。** 扫描是对草稿字符串的纯函数，零副作用、零 I/O、零网络；任何内容都不离开浏览器。
- **浏览器安全。** 规则是静态 `RegExp` 模式，无 Node API，因此客户端 bundle 可在 Web GUI 运行的任何地方运行。

### 检测：规则列表

`scan(text)` 用每条规则的全局模式遍历草稿（防御性重置 `lastIndex`），返回最多 20 条 `ScanHit`（`id`、`severity`、`snippet`）。`highestSeverity(hits)` 把列表折叠为最严重级别。规则覆盖 API key（Anthropic、AWS、OpenAI、GitHub、Slack）、私钥 `BEGIN` 头、RFC 1918/回环 IP、云签名 URL（S3、GCS、Azure SAS）、`password`/`passwd`/`pwd` 赋值、`Bearer` token 与凭据文件路径。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 空的 host apply；浏览器半边通过 `exports["./client"]` 交付。 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器 apply：注册 `conversation.input.right` 徽标。 |
| [`src/client/PreSendScanButton.tsx`](src/client/PreSendScanButton.tsx) | 徽标组件：读取 `useInput`、扫描、渲染级别与计数。 |
| [`src/client/scanner.ts`](src/client/scanner.ts) | 纯扫描规则与 `ScanHit` 类型。 |
| — | 不发布运行时不变式伴生入口；扫描仅限浏览器本地，不暴露可供独立伴生入口观察的包级事件或快照。 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 发送前扫描指示器

#### 模型看到什么

模型请求没有任何变化。扫描通过 `useInput` 标准 hook 读取 composer 草稿，并只在浏览器徽标中报告命中；草稿原样发给模型，扫描结果文本也不会加入会话日志或模型上下文。

#### Token 影响

无。插件不添加任何模型可见 token。

#### KV Cache 影响

无。模型请求内容不被修改。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明指示器何时不合适。它们是当前包约束，不是任务积压。

- **仅指示器**——扫描从不阻止发送，因此忽略徽标的用户仍可能发送敏感内容；阻止或确认尚未实现。
- **静态模式匹配**——规则是正则表达式，没有语义校验，因此已知格式之外构造良好的密钥，或拼写不同的密钥不会被标记。
- **无 host 端扫描**——仅浏览器半边扫描草稿；没有服务端或记录在案的对应物。
