# Agent Note: Failure-loop hard stop

Status: implemented

English | [中文](2026-09-07-failure-loop-hard-stop.zh.md)

## Problem

The [failure-loop detector](../feature/2026-09-06-failure-loop.md) shipped advisory-only: it enriched a post-execute decision with a reminder when an agent repeated failing or non-progressing tool calls, but it never blocked a call, so a model that ignored the reminders kept hammering the same failure. The `PostToolDecision` blocking form already existed downstream, but the guard offered no way to turn its detection into a stop.

## Decision

The guard gains two configuration fields: `hardStopThreshold` (default 3) and `hardStop` (default `false`). With `hardStop: false` the behavior is unchanged — the guard prepends its reminder to the downstream decision's `additionalContexts`. With `hardStop: true`, once a detected signal reaches `hardStopThreshold` the guard returns a `{ kind: 'block' }` decision whose `feedback` is a per-signal corrective instruction keyed to the same three signals (`exact-failure`, `same-tool-failure`, `idempotent-no-progress`). The downstream listener's `additionalContexts` are preserved, but the advisory reminder is replaced by the block's feedback. Window validation now includes `hardStopThreshold` when the hard stop is armed, so a configured window cannot be smaller than the blocking threshold.

The three hard-stop bodies name the tool, the trailing count, and the limit, and tell the model to stop retrying and change strategy. They are the only data-dependent text in the blocked call's error content.

## Alternatives considered

**Block unconditionally at the reminder threshold.** Always blocking would turn an advisory nudge into a hard veto for every composition and break legitimate retries; an explicit `hardStop` opt-in keeps the default advisory.

**A separate blocking plugin.** Splitting blocking into another plugin would duplicate the detector's window and streak state, or force a shared abstraction; folding the opt-in into the detector reuses the one post-execute observation point.

**A fixed, non-configurable hard-stop count.** A hardcoded threshold would not match the per-signal reminder thresholds already in place; making it configurable mirrors the existing `*Threshold` fields.

## Consequences

- The guard is advisory by default and blocking only when `hardStop: true` and a signal reaches `hardStopThreshold`.
- A blocked call's `tool/result` becomes an error whose content is the corrective hard-stop instruction, so the loop is broken rather than nudged.
- The hard stop is streak-gated: a loop whose streak stays under its own signal threshold, or one interleaved with other calls, is still only reminded.
