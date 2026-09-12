---
description: "建议性循环卫生 guard：当 agent 编辑文件后提醒模型运行测试，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-edit-test-guard

[English](README.md) | 中文

## 概述

模型可能长时间连续编辑文件却从不运行测试套件，累积起无人验证的改动。本 guard 能识别这种模式并提醒模型测试：在一次编辑类或写入类调用之后，它检查最近的窗口内是否运行过测试命令；若没有，就提醒模型运行相关测试。提醒只是建议，从不阻断：编辑总是照常落盘，决定权仍在模型。每个 agent（智能体）分别计数。它不随 base 组合发行——需要由组合显式挂载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型应当在编辑文件后被提醒运行测试时，挂载此插件。它是建议性的且默认禁用，因此组合添加它之前什么都不会改变。

### 在 `cordis.yml` 中挂载

把插件加入组装 agent 插件的组合：

```yaml
- name: '@deepseek-ai/dsh-edit-test-guard'
  config:
    editTools: [edit, write]            # tool-name patterns that count as an edit
    testCommands: [test, pytest, vitest, jest, cargo test, go test, make check, pnpm test, npm test, tsc, tox]
    window: 25                          # how many prior tool calls to inspect for a test
    reminder: "You edited a file but no test command has run recently; run the tests."
```

在 TypeScript 组合中，像挂载任何函数插件一样挂载它：

```ts
import EditTestGuard from '@deepseek-ai/dsh-edit-test-guard'
await ctx.plugin(EditTestGuard, { window: 25 })
```

### 配置参考

| 字段 | 默认值 | 含义 |
|---|---|---|
| `editTools` | `['edit', 'write']` | 触发检查的工具名模式；`*` 是通配符 |
| `testCommands` | 见下文 | 计为「测试已运行」的命令片段 |
| `window` | `25` | 为寻找近期测试而检查的先前工具调用数（整数 >= 1） |
| `reminder` | 见下文 | 检查未通过时投递的静态提醒文本 |
| `reminderText` | 未设置 | 可选的 `(tool) => string` 生成器，覆盖 `reminder` |

默认 `testCommands`：`test`、`pytest`、`vitest`、`jest`、`cargo test`、`go test`、`make check`、`pnpm test`、`npm test`、`tsc`、`tox`。

无效配置会在启动时以清晰错误失败——`editTools` 或 `testCommands` 列表为空，或 `window` 小于 1——绝不会静默改变行为。

### 你会得到什么

编辑之后没有近期测试时，模型会收到下面的提醒，归属为该插件。编辑的工具结果不受影响；提醒作为注入的上下文消息出现在工具结果之后。一旦 agent 运行了一条参数包含某个 `testCommands` 片段的命令（例如 `bash` 配 `npm test`），提醒就会停止触发，直到该测试滑出窗口。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 guard 如何检测「编辑后无测试」并投递提醒，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

guard 建立在三项承诺之上：

- **仅建议，不否决。** guard 用模型上下文丰富 post-execute 决策；它从不阻止或改写调用，因此 `PostToolDecision` 阻止仍是后续监听器的事。
- **在 post-execute 中检测。** 检测运行在 `tools/post-execute` 上，每一次已结算的调用——包括被拒绝的调用——都在同一处带着 agent 与参数可被观察。
- **加载时大声失败。** `editTools`、`testCommands` 与 `window` 在 `apply` 中校验并抛出错误，绝不回退到默认值。

### 检测：近期测试窗口

每个 agent 在 `WeakMap<Agent, string[]>` 中保存最近 `window` 条序列化工具调用参数的有界历史。当某次调用的名称匹配某个 `editTools` 模式时，guard 会扫描该 agent 的先前历史，寻找任何序列化参数包含某个 `testCommands` 片段的条目（普通的区分大小写子串匹配）。找不到时提醒触发；随后当前编辑调用被追加进历史并保持边界。

- **只有 agent 循环中的调用参与。** 直接调用 `ctx.tools.execute()` 的调用方没有需要提醒的模型，也没有可作为键的活跃 agent 对象，因此被忽略。
- **按 agent 分键。** 一个 agent 的测试运行绝不会让另一个 agent 的提醒静默；对象生命周期限制弱引用条目的寿命，无需 dispose（资源释放）监听器。
- **窗口有界。** 历史最多保存 `window` 条先前调用；滑出窗口的测试不再抑制提醒。
- **仅驻留内存。** 从持久化恢复的会话以全新窗口开始——guard 是启发式提醒，而非记录在案的不变量。

### 提醒传递

提醒随 post-execute 决策的 `additionalContexts`（来源为 `{kind: 'plugin', plugin: 'edit-test-guard', form: 'notice', summary: '<tool> without tests'}`）传递，绝不替换 `content`：用于审计的 `tool/result` 事件仍保留工具自己的输出。循环会缓冲这段上下文，并在该步骤的工具结果之后作为注入的 `user/message` 追加，会话将其渲染为普通的合成用户消息——模型可见、带有来源归属，且无需新会话事件即可从会话日志重建。guard 始终通过 `next()` 委派，并把提醒放在下游决策的上下文数组之前，因此两种决策变体（包括被阻止的调用）都会收到提醒，同时每个条目保留自己的来源与元数据。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、大声失败校验、窗口监听器 |
| — | 不发布运行时不变式伴生入口；编辑/测试窗口私有于一个 post-execute 监听器，不暴露可供独立伴生入口观察的包级事件或快照。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具 waterfall 逐步进入穷尽式配置与 guard 组映射。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——本 guard 消费的 `tools/execute` waterfall、`additionalContexts` 与决策形态。
- [guard 组映射](../README.zh.md)——同组的 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 编辑后未测试的上下文消息

#### 模型看到什么

编辑类或写入类工具调用之后、近期窗口内没有测试命令时，对应 agent 会收到下面的提醒。不会添加工具 schema 或正常调用文本。自定义 `reminder` 会原样替换这段文本；`reminderText` 函数则根据工具名动态生成它。

##### 编辑后未测试提醒

```markdown
You edited a file but no test command has run in the recent tool-call history. Run the relevant tests now to verify the change before continuing.
```

#### Token 影响

第一次编辑后未测试前为零 token。每条提醒都会作为该 agent 的历史记录保留。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明 guard 何时不合适。它们是当前包约束，不是任务积压。

- **对序列化参数做子串匹配**——`testCommands` 片段可以匹配调用序列化参数的任何位置，因此编辑一个名为 `test.js` 的文件可能被认作测试已运行；裸 `test` 片段被有意放宽。需要精度时调优 `testCommands`。
- **不感知命令执行器**——guard 不区分 shell 命令工具与其他工具；任何序列化参数包含某个片段的调用都计为测试。它不会专门解析 `command` 字段。
- **仅提供建议**——尚未实现升级为阻止形式，但 `PostToolDecision` 已支持阻止。
- **仅驻留内存的窗口**——恢复的会话以空窗口开始，因此恢复后立刻编辑会收到提醒，即使恢复之前运行过测试。
- **subagent 之间不共享**——窗口始终按 agent 隔离；父 agent 与其 subagent 的历史绝不合并。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
