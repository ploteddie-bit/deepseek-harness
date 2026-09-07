# Agent Note: Failure-loop guard

Status: implemented

English | [中文](2026-09-06-failure-loop.zh.md)

## Problem

A model can get stuck retrying a tool call that keeps failing — re-running a broken command with the same arguments, or cycling one tool through different failing arguments — or re-reading an unchanged result through a read-only tool that never makes progress. `repeat-tool-reminder` only flags the exact same call regardless of outcome, so failing and non-progressing loops went unreminded.

## Decision

`dsh-failure-loop` is an advisory guard that detects three failure signals over each agent's bounded window of recent tool-call observations: `exact-failure` (the trailing run of failures with the same tool and canonical arguments), `same-tool-failure` (the trailing run of failures on one tool, arguments ignored), and `idempotent-no-progress` (the trailing run of successful idempotent calls returning the same canonical result). Each signal has its own threshold (`exactFailureThreshold`, `sameToolFailureThreshold`, `idempotentNoProgressThreshold`).

Detection runs on `tools/post-execute`, which also fires for denied calls; a success resets the failure streaks and a changed result resets the no-progress streak, so a real edit-and-retry cycle is never treated as a loop. The guard never blocks: it prepends a reminder to the downstream decision's `additionalContexts`, attributed to the plugin. It tracks each agent separately in a `WeakMap`, clears on a new user message, and ships disabled by default so a composition opts in alongside the other guards. The [hard-stop feature](2026-09-07-failure-loop-hard-stop.md) later added an opt-in blocking form.

## Alternatives considered

**Fold failure detection into repeat-tool-reminder.** Reusing the exact-match chain would conflate "same call regardless of outcome" with "calls that fail or stop progressing"; separate detectors keep the signals independent.

**Block by default.** Vetoing failed calls would break legitimate retries and differ from the sibling guard's advisory posture; the default stays advisory.

**A cumulative per-turn counter.** A trailing-streak over the window is narrower than a per-turn total but matches the stuck-loop shape and bounds memory; a counter would flag exploration, not a loop.

## Consequences

- The guard is advisory and ships disabled; enabling it is a composition choice.
- Failure detection keys on the tool's own `isError` indicator, so a call the model considers successful never trips the failure signals.
- The window is in-memory and trailing-streak, not cumulative; a failure streak ends as soon as any other call or a success intervenes.
