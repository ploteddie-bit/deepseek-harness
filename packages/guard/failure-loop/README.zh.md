---
description: "建议性循环卫生 guard：当 agent 陷入失败或无进展的工具调用循环时提醒模型，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-failure-loop

[English](README.md) | 中文

## 概述

模型可能会卡在重试一个持续失败的工具调用上——以相同参数反复运行一条坏命令，或用不同参数轮番调用同一工具并看着每次都失败——也可能通过只读工具反复读取一个未变化的结果却毫无进展。`dsh-failure-loop` 会发现这些模式并让模型停下来：在选定的次数上，它送出一条提醒，要求模型检查最新错误并改变策略（换参数、换工具，或报告阻塞点），或者直接使用已经提供的结果而不是反复读取。提醒只是建议，绝非阻止：合理的重试不会被延迟分毫，是否继续、改变方法或停止仍由模型决定。设置 `hardStop: true` 可以把这条建议变成硬停止（hard stop）：一旦循环达到 `hardStopThreshold`，出问题的调用会被打断并收到纠正性反馈，而不是一条提醒。它分别跟踪每个 agent（智能体），一个 agent 的循环绝不会干扰另一个 agent 的工作，一次成功的调用或一条新的用户消息都会清零计数。它与 `repeat-tool-reminder` 互补——那个 guard 标记*完全相同的调用*（无论结果如何），这个 guard 标记*失败或停止取得进展*的调用——并且默认随包禁用，组合可以与其他 guard 一起按需启用。

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

当模型应当自行发现在失败的工具调用上循环，或通过只读工具反复读取未变化结果时，挂载此插件。无需任何接线：在 `cordis.yml` 组合中加一行，想让提醒来得更早、更晚或覆盖不同工具时，调优下面的阈值与工具范围即可。

### 何时选择

当模型长时间自主工作，而*失败*或*无进展*的循环正是你想用建议而非强制来打破的失败模式时，选择它。当相同的重试是合理且必须不受打扰地运行时避免使用它——guard 只会提醒，提醒只是重复调用之后的一条小消息；当你在意的循环是*成功*的完全相同调用时也避免使用它（那是 `repeat-tool-reminder` 的场景，不是本包的）。失败判定以工具自己的错误指示为准，因此模型自己认为成功的调用绝不会触发失败信号。

### 设置阈值与范围

想改变提醒何时触发或覆盖哪些工具时，用配置挂载插件：

```yaml
- name: '@deepseek-ai/dsh-failure-loop'
  config:
    exactFailureThreshold: 3          # same tool + same args failing 3 times
    sameToolFailureThreshold: 5       # same tool failing 5 times (args may differ)
    idempotentNoProgressThreshold: 5  # read-only tool returning the same result 5 times
    window: 30                        # sliding window of tool calls inspected per agent
    idempotentTools: [read, glob, grep, 'list_*']  # read-only tools (wildcard patterns)
    exclude: []                       # transparent tools: never count, never reset
    hardStopThreshold: 3              # loops reaching this count are interrupted when hardStop is on
    hardStop: false                   # false = advisory reminders only (default); true = block at the threshold
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `exactFailureThreshold` | `3` | 同一工具以相同参数连续失败这么多次触发提醒 |
| `sameToolFailureThreshold` | `5` | 同一工具连续失败这么多次（参数可以不同）触发提醒 |
| `idempotentNoProgressThreshold` | `5` | 幂等工具连续返回相同结果这么多次触发提醒 |
| `window` | `30` | 每个 agent 的检测器检查最近多少次工具调用 |
| `idempotentTools` | `['read', 'glob', 'grep', 'list_*']` | 跟踪无进展情况的只读工具通配模式 |
| `exclude` | `[]` | 对检测器透明的工具通配模式（既不计数也不重置） |
| `hardStopThreshold` | `3` | 当 `hardStop` 启用时，信号达到此次数就阻止调用而不是提醒 |
| `hardStop` | `false` | 按需启用：`true` 在 `hardStopThreshold` 处打断调用；`false` 只保留建议性提醒 |

无效配置会在启动时以清晰错误失败——阈值或 `window` 小于 2、非整数、或 `window` 小于任何一个阈值（硬停止启用时包括 `hardStopThreshold`）——绝不会静默改变行为。

### 你会得到什么

按默认值，以相同参数重复同一失败调用的模型会在第三次失败时收到提醒；用一个工具轮番尝试不同失败参数的模型会在第五次失败时收到提醒；反复读取一个未变化文件的模型会在第五次未变化读取时收到提醒。每条提醒都点名工具与次数，并指出下一步——改变方法、使用已提供的结果，或报告外部阻塞点。一次成功的调用会重置失败序列，一个变化的结果会重置无进展序列，一条新的用户消息会清空窗口，因此全新指令或真实的修改后重试绝不会被当作循环。设置 `hardStop: true` 后，本该触发提醒的同一连续序列会在 `hardStopThreshold` 处阻止调用：工具结果变成一个内容为显式停止指令的错误，循环被打破而不是仅被轻推。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 guard 如何检测失败并投递提醒，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

guard 建立在四项承诺之上：

- **默认仅建议，硬停止按需启用。** guard 用模型上下文丰富 post-execute 决策；除非 `hardStop: true` 在 `hardStopThreshold` 处启用阻止，它从不阻止或改写调用。
- **在 post-execute 中计数。** 检测运行在 `tools/post-execute` 上，被拒绝的调用同样会经过它；在那里计数让一个监听器即可覆盖所有尝试，无需跨事件状态。
- **失败由工具自己的指示判定。** 一个调用当且仅当其结果携带 `isError: true` 时才算失败；无进展调用则是一个*成功*，其渲染内容与同一幂等调用上一次的成功内容相同。
- **加载时大声失败。** 每个阈值与窗口都在 `apply` 中校验并抛出错误，绝不回退到默认值。

### 检测：滑动窗口上的三个信号

每个 agent 拥有一份有界的近期工具调用观察历史（`window` 条目）；三个信号都作为该历史上尾部连续的连续序列计算，因此一次成功或一个变化的结果会自然重置序列，`window` 则约束记忆长度。

- **exact-failure**——同一 `(tool, canonical arguments)` 的尾部连续失败；在 `exactFailureThreshold` 触发。这是「同一条坏调用原样重放」循环。
- **same-tool-failure**——同一工具的尾部连续失败，忽略参数；在 `sameToolFailureThreshold` 触发（同一次调用同时满足两个信号时，精确信号优先）。这是「同一工具一直失败，每次尝试参数都不同」循环。
- **idempotent-no-progress**——对匹配 `idempotentTools` 的工具的成功调用，尾部连续的成功调用具有相同 `(tool, canonical arguments)` *且*相同的规范化结果内容；在 `idempotentNoProgressThreshold` 触发。这是「反复读取一个未变化的文件」循环。

- **不受跟踪的调用对检测器透明。** 被 `exclude` 排除的调用甚至不会被记录，因此它既不计数也不重置序列——穿插进循环的记录类工具不能掩盖循环。
- **忽略没有 agent 的调用。** 直接调用 `ctx.tools.execute()` 的调用方没有需要提醒的模型，也没有可作为键的活跃 agent 对象。
- **按 agent 分键，用户提示词时重置。** 一个 agent 的序列绝不会触发另一个 agent 的提醒；用户提示词（`agent/pre-step`）会删除提交该提示词的 agent 的历史，对象生命周期限制弱引用条目的寿命，无需 dispose（资源释放）监听器。
- **仅驻留内存。** 从持久化恢复的会话以全新窗口开始——guard 是启发式提醒，而非记录在案的不变量，因此恢复后的提醒延后是可接受的代价。

### 提醒传递

提醒随 post-execute 决策的 `additionalContexts`（来源为 `{kind: 'plugin', plugin: 'failure-loop', form: 'notice', summary: '<signal>: <tool> × <count>'}`）传递，绝不替换 `content`：用于审计的 `tool/result` 事件仍保留工具自己的输出。循环会缓冲这段上下文，并在该步骤的工具结果之后作为注入的 `user/message` 追加，会话将其渲染为普通的合成用户消息——模型可见、带有来源归属，且无需新会话事件即可从会话日志重建。guard 始终通过 `next()` 委派，并把提醒放在下游决策的上下文数组之前，因此两种决策变体（包括被阻止的调用）都会收到提醒，同时每个条目保留自己的来源与元数据。设置 `hardStop: true` 后，一旦信号达到 `hardStopThreshold`，guard 改为返回一个 `{ kind: 'block' }` 决策，其 `feedback` 是显式的停止指令；下游监听器的 `additionalContexts` 仍然保留，但建议性提醒被阻止反馈取代。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、大声失败校验、窗口监听器 |
| — | 不发布运行时不变式伴生入口；失败检测窗口私有于一个 post-execute 监听器，不暴露可供独立伴生入口观察的包级事件或快照。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具 waterfall 逐步进入穷尽式配置与 guard 组映射。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——本 guard 消费的 `tools/execute` waterfall、`additionalContexts` 与决策形态。
- [guard 组映射](../README.zh.md)——同组的 guard 包与循环卫生家族（`repeat-tool-reminder` 针对相同调用循环，`timeout-policy` 针对挂起的调用）。

-----

<a id="model-experience"></a>
## 模型体验

### 精确失败提醒

#### 模型看到什么

达到 `exactFailureThreshold` 次相同失败调用时，对应 agent 会收到下面的提醒。不会添加工具 schema 或正常调用文本。

##### 精确失败提醒

```markdown
<tool> failed <count> times with identical arguments. This looks like a failure loop. Inspect the latest error and change strategy — different arguments, a different tool, or report the blocker — instead of retrying the same call unchanged.
```

#### Token 影响

达到阈值前为零 token。每条提醒都会作为该 agent 的历史记录保留；`<tool>` 与 `<count>` 占位符是仅有的随数据变化的文本。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 同工具失败提醒

#### 模型看到什么

对同一工具达到 `sameToolFailureThreshold` 次失败调用（参数可以不同）时，对应 agent 会收到下面的提醒。

##### 同工具失败提醒

```markdown
<tool> failed <count> times in a row. This looks like a failure loop. Diagnose the latest error before retrying: try different arguments, a narrower query or path, or a different tool. If the blocker is external, report it after one diagnostic attempt.
```

#### Token 影响

达到阈值前为零 token。每条提醒都会作为该 agent 的历史记录保留；`<tool>` 与 `<count>` 占位符是仅有的随数据变化的文本。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 幂等无进展提醒

#### 模型看到什么

幂等工具达到 `idempotentNoProgressThreshold` 次未变化结果时，对应 agent 会收到下面的提醒。

##### 幂等无进展提醒

```markdown
<tool> returned the same result <count> times. Use the result already provided or change the query instead of repeating it unchanged.
```

#### Token 影响

达到阈值前为零 token。每条提醒都会作为该 agent 的历史记录保留；`<tool>` 与 `<count>` 占位符是仅有的随数据变化的文本。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 硬停止反馈

#### 模型看到什么

设置 `hardStop: true` 后，一旦信号达到 `hardStopThreshold`，出问题的调用会被阻止：它的 `tool/result` 变成一个错误，其内容是下面与三个信号一一对应的硬停止指令。

##### 精确失败硬停止

```markdown
Hard stop: <tool> failed <count> times with identical arguments (limit <threshold>). Stop retrying this call. Inspect the latest error and change strategy — different arguments, a different tool, or report the blocker — instead of repeating the same call.
```

##### 同工具失败硬停止

```markdown
Hard stop: <tool> failed <count> times in a row (limit <threshold>). Stop retrying. Diagnose the latest error and change approach — different arguments, a narrower query or path, or a different tool — or report an external blocker.
```

##### 幂等无进展硬停止

```markdown
Hard stop: <tool> returned the same result <count> times (limit <threshold>). Stop repeating this call. Use the result already provided or change the query instead.
```

#### Token 影响

达到 `hardStopThreshold` 前为零 token。被阻止调用的错误内容会取代调用自身的输出，因此模型看到的是停止指令而不是又一次失败；`<tool>`、`<count>` 与 `<threshold>` 占位符是仅有的随数据变化的文本。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明 guard 何时不合适。它们是当前包约束，不是任务积压。

- **失败仅由工具的错误标志判定**——一个「失败」但返回 `isError: false`、错误字符串放在内容里的工具对失败信号不可见；检测以注册表自己的成功／错误指示为准。
- **尾部连续序列，而非累计**——失败序列一旦有任何其他调用或一次成功穿插即告结束，因此一个与其他调用穿插失败的工具永远不会累积；这是有意为之（穿插意味着探索，而不是卡死的循环），但比按轮次计数更窄。
- **压缩（compaction）不会重置窗口**——跨越压缩检查点的窗口会继续计数。
- **硬停止按需启用且以序列为门**——只有当 `hardStop: true` 且某个检测到的信号达到 `hardStopThreshold` 时才阻止；序列始终低于自身信号阈值的循环，或与其他调用穿插（因此永不累积）的循环，仍然只会收到提醒。
- **subagent 之间不共享窗口**——窗口始终按 agent 隔离；父 agent 与其 subagent 在同一调用上失败也绝不合并。
- **无进展需要结果内容相同**——两次幂等读取以不同措辞给出相同事实算作进展，而不是循环。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

三信号分类（精确失败／同工具失败／幂等无进展）取自 Hermes Agents 的 `tool_guardrails.py` 失败词汇，并适配为本 harness 仅建议、按 agent 窗口的模型。

</details>
