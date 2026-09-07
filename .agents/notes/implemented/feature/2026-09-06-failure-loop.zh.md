# Agent Note: 失败循环 guard

Status: implemented

[English](2026-09-06-failure-loop.md) | 中文

## 问题

模型可能卡在反复重试持续失败的工具调用上——用相同参数反复运行损坏的命令，或用不同参数循环同一个工具并看着每次调用都失败——或通过只读工具反复读取不变的结果却毫无进展。`repeat-tool-reminder` 只标记无论结果如何都完全相同的调用，因此失败与无进展的循环得不到提醒。

## 决策

`dsh-failure-loop` 是一个建议性 guard，在每个 agent 近期的工具调用观察有界窗口上检测三种失败信号：`exact-failure`（相同工具与规范化参数连续失败的尾部）、`same-tool-failure`（同一工具连续失败、忽略参数的尾部）与 `idempotent-no-progress`（幂等工具返回相同规范化结果的连续成功尾部）。每种信号有各自的阈值（`exactFailureThreshold`、`sameToolFailureThreshold`、`idempotentNoProgressThreshold`）。

检测运行在 `tools/post-execute` 上，被拒绝的调用同样经过它；成功会重置失败连续计数，变化的结果会重置无进展连续计数，因此真实的“编辑-重试”周期绝不会被当作循环。guard 从不阻止：它把提醒放在下游决策的 `additionalContexts` 之前并归属于插件。它在 `WeakMap` 中按 agent 分别跟踪，新用户消息时清零，默认不随组合交付，以便组合与其他 guard 一起选择加入。[硬停止功能](2026-09-07-failure-loop-hard-stop.zh.md) 后来增加了可选的阻止形式。

## 已考虑的替代方案

**把失败检测折叠进 repeat-tool-reminder。** 复用精确匹配链会把“无论结果都相同的调用”与“失败或无进展的调用”混为一谈；分开的检测器让信号互不干扰。

**默认阻止。** 否决失败调用会破坏合理的重试，也与兄弟 guard 的建议姿态不一致；默认保持建议。

**每个轮次的累计计数器。** 窗口上的连续计数比每轮总数更窄，却匹配卡死循环的形状并限制内存；计数器会标记探索行为而非循环。

## 后果

- guard 仅建议且默认不启用；启用它是组合的选择。
- 失败检测以工具自身的 `isError` 指示为准，因此模型自认为成功的调用绝不会触发失败信号。
- 窗口驻留内存且是连续计数而非累计；一旦任何其他调用或成功介入，失败连续计数即结束。
