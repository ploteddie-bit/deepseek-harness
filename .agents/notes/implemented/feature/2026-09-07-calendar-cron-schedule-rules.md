# Agent Note: Calendar Cron recurrence in Schedule

Status: implemented

English | [中文](2026-09-07-calendar-cron-schedule-rules.zh.md)

## Problem

The [bounded fixed-rate decision](../../archived/simplification/2026-08-09-bounded-fixed-rate-schedule.md) removed Cron and calendar expressions to keep Session-local reminders small: only `every_seconds` repeated, with no calendar grammar, evaluator dependency, or time-zone policy. That left calendar-style recurrence — "every weekday at 9" — outside the shipped protocol. Users who wanted a weekday, daily, or monthly reminder had to fall back to a fixed interval, which drifts relative to the wall-clock calendar.

## Decision

Schedule regains a `cron` selector alongside `after_seconds`, `at`, and `every_seconds`. A `cron` rule accepts either a five-field Cron expression such as `30 9 * * 1` or a simple calendar phrase such as `every weekday at 9`, both interpreted in UTC with minute granularity. The public parser normalizes the input to a `CronRule` — sorted, deduplicated `minutes`, `hours`, `daysOfMonth`, `months`, and `daysOfWeek` integer arrays — and derives deterministic next and previous occurrences without consulting a process time zone. Parsing, list/range/step support, named month/day aliases, and occurrence arithmetic are pure, dependency-free functions in `src/calendar.ts`.

The durable `cron` record stores its normalized `rule` and `scheduledAt` as the earliest pending occurrence. Dispatch uses the same latest-only catch-up as fixed-rate reminders: an overdue Cron record contributes only its latest due occurrence, and replay advances directly to the first rule-derived target after the decision time. Every recurring (Every or Cron) overdue record shares the one `[SCHEDULE REMINDER BATCH]` framing already used by fixed-rate reminders. Delivery stays intra-session — no email, SMS, push, or browser notification.

## Alternatives considered

**Reintroduce a general Cron subsystem.** A full calendar grammar, time-zone-sensitive occurrence search, tzdata replay rules, and a cross-record admission gate would re-create the surface the fixed-rate decision removed. The five-field UTC grammar with minute granularity covers the useful recurrence cases without that machinery.

**Keep calendar recurrence out of the protocol.** This preserved the fixed-rate decision's simplicity but left weekday/daily/monthly reminders unserved and forced users onto drifting fixed intervals.

**Time-zone-aware Cron.** Interpreting Cron in the caller's zone would require durable zone policy and daylight-saving replay; UTC keeps the selector self-contained at the cost of caller-side conversion.

## Consequences

- The durable rule union is After, At, Every, and Cron; the tool selector union adds `cron`.
- Calendar recurrence is a shipped product boundary rather than a future one; the bounded fixed-rate decision remains authoritative for `every_seconds`.
- UTC-only, minute-granular Cron cannot express seconds, a caller time zone, or a day-of-month/day-of-week AND relationship beyond the standard OR semantics.
