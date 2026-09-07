# Agent Note: Schedule 中的日历 Cron 周期

Status: implemented

[English](2026-09-07-calendar-cron-schedule-rules.md) | 中文

## 问题

[有界固定速率决策](../simplification/2026-08-09-bounded-fixed-rate-schedule.zh.md) 移除了 Cron 与日历表达式，以保持 Session 内提醒的精简：只有 `every_seconds` 会重复，没有日历语法、求值器依赖或时区策略。这让日历式周期——例如“每个工作日早上 9 点”——被排除在已交付协议之外。想要工作日、每日或每月提醒的用户只能退回到固定间隔，而固定间隔会相对墙钟日历漂移。

## 决策

Schedule 在 `after_seconds`、`at` 与 `every_seconds` 之外重新加入 `cron` selector。`cron` 规则接受五字段 Cron 表达式（如 `30 9 * * 1`）或简单日历短语（如 `every weekday at 9`），两者都以 UTC 解释、粒度为分钟。公开 parser 把输入规范化为 `CronRule`——排序去重的 `minutes`、`hours`、`daysOfMonth`、`months` 与 `daysOfWeek` 整数数组——并在不读取进程时区的前提下推导确定性的下一次与上一次发生时点。解析、列表/区间/步长支持、月份/星期别名与发生时点运算都是 `src/calendar.ts` 中纯函数、无依赖的实现。

持久化的 `cron` 记录保存其规范化后的 `rule`，并以 `scheduledAt` 作为最早待派发发生时点。派发使用与固定速率提醒相同的仅最新追赶：逾期的 Cron 记录只贡献其最新的到期发生时点，重放会直接推进到决策时点之后的第一个由规则推导的目标。所有逾期的周期（Every 或 Cron）记录共享固定速率提醒已有的同一个 `[SCHEDULE REMINDER BATCH]` framing。交付仍仅在 Session 内——没有邮件、短信、推送或浏览器通知。

## 已考虑的替代方案

**重新引入通用 Cron 子系统。** 完整的日历语法、时区敏感的发生时点搜索、tzdata 回放规则与跨记录准入门控会重新制造固定速率决策已移除的表面。五字段 UTC 语法加上分钟粒度足以覆盖实用的周期场景，无需那套机制。

**把日历周期继续排除在协议之外。** 这保留了固定速率决策的简洁，却让工作日/每日/每月提醒得不到服务，并迫使用户使用会漂移的固定间隔。

**时区感知的 Cron。** 在调用方时区解释 Cron 需要持久的时区策略与夏令时回放；UTC 让 selector 自成一体，代价是调用方需要自行换算。

## 后果

- 持久规则 union 包含 After、At、Every 与 Cron；工具 selector union 增加了 `cron`。
- 日历周期已成为已交付的产品边界，而非未来边界；有界固定速率决策对 `every_seconds` 仍然权威。
- 仅 UTC、分钟粒度的 Cron 无法表达秒、调用方时区，或超出标准 OR 语义的 day-of-month/day-of-week AND 关系。
