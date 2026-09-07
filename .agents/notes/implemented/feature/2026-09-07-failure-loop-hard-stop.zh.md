# Agent Note: 失败循环硬停止

Status: implemented

[English](2026-09-07-failure-loop-hard-stop.md) | 中文

## 问题

[失败循环检测器](../feature/2026-09-06-failure-loop.zh.md) 交付时仅提供建议：当 agent 重复失败或无进展的工具调用时，它用提醒丰富 post-execute 决策，但从不阻止调用，因此忽略提醒的模型会继续敲击同一个失败。`PostToolDecision` 的阻止形式早已在下游存在，但 guard 没有提供把检测转化为停止的途径。

## 决策

guard 增加两个配置字段：`hardStopThreshold`（默认 3）与 `hardStop`（默认 `false`）。`hardStop: false` 时行为不变——guard 把提醒放在下游决策的 `additionalContexts` 之前。`hardStop: true` 时，一旦检测到的信号达到 `hardStopThreshold`，guard 会返回 `{ kind: 'block' }` 决策，其 `feedback` 是与三个信号（`exact-failure`、`same-tool-failure`、`idempotent-no-progress`）一一对应的纠正性指令。下游监听器的 `additionalContexts` 会被保留，但建议提醒被阻止反馈取代。窗口校验现在会在硬停止启用时包含 `hardStopThreshold`，因此配置的窗口不能小于阻止阈值。

三条硬停止正文会指出工具、连续计数与上限，并要求模型停止重试、改变策略。它们是被阻止调用错误内容中仅有的随数据变化的文本。

## 已考虑的替代方案

**在提醒阈值处无条件阻止。** 无条件阻止会把建议性的提醒变成对每种组合的硬否决，并破坏合理的重试；显式的 `hardStop` 选择保留默认的建议姿态。

**单独做一个阻止插件。** 把阻止拆到另一个插件会复制检测器的窗口与连续状态，或强制一个共享抽象；把选择折叠进检测器可以复用同一个 post-execute 观察点。

**固定、不可配置的硬停止次数。** 硬编码阈值无法匹配已有的按信号提醒阈值；做成可配置与现有 `*Threshold` 字段保持一致。

## 后果

- guard 默认仅建议，只有 `hardStop: true` 且信号达到 `hardStopThreshold` 时才阻止。
- 被阻止调用的 `tool/result` 变成错误，其内容是纠正性硬停止指令，因此循环被打破而非仅仅被提醒。
- 硬停止受连续计数门控：连续计数低于自身信号阈值、或与其他调用穿插（因此不会累计）的循环仍只会被提醒。
