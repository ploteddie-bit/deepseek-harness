---
description: "Advisory loop-hygiene guard that nudges the model out of failing or non-progressing tool-call loops, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-failure-loop

English | [中文](README.zh.md)

## Summary

A model can get stuck retrying a tool call that keeps failing — re-running a broken command with the same arguments, or cycling the same tool with different arguments and watching each one fail — or re-reading an unchanged result through a read-only tool that never makes progress. `dsh-failure-loop` notices each pattern and tells the model to stop: at chosen counts it delivers a reminder to inspect the latest error and change strategy (different arguments, a different tool, or report the blocker), or to use the result already provided instead of re-reading it. The reminder is advice, never a block: a legitimate retry is delayed by nothing, and the decision to continue, change approach, or stop stays with the model. Set `hardStop: true` to turn that advice into a hard block once a loop reaches `hardStopThreshold` — the offending call is interrupted with corrective feedback instead of a reminder. It tracks each agent separately, so one agent's loop never disturbs another's work, and a successful call or a new user message clears the counts. It complements `repeat-tool-reminder` — that guard flags the *exact same call* regardless of outcome, this one flags calls that *fail or stop progressing* — and ships disabled by default so a composition can opt in alongside the other guards.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when the model should catch itself looping on tool calls that fail, or re-reading unchanged results through read-only tools. There is nothing to wire: add one row to a `cordis.yml` composition, tune the thresholds and tool scope below when you want the nudge sooner, later, or on different tools.

### When to choose it

Choose it when the model works autonomously for long stretches and a *failing* or *non-progressing* loop is the failure you want to break with advice rather than force. Avoid it when identical retries are legitimate and must run undisturbed — the guard only reminds, and a reminder is a small extra message after the repeated call — and when the loop you care about is *identical calls that succeed* (that is `repeat-tool-reminder`'s case, not this one's). Failure detection keys on the tool's own error indicator, so a call the model itself considers successful never trips the failure signals.

### Setting the thresholds and scope

When you want to change when reminders fire or which tools they cover, mount the plugin with configuration:

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

| Field | Default | Meaning |
|---|---|---|
| `exactFailureThreshold` | `3` | Same tool + same arguments failing this many times in a row triggers a reminder |
| `sameToolFailureThreshold` | `5` | Same tool failing this many times in a row (arguments may differ) triggers a reminder |
| `idempotentNoProgressThreshold` | `5` | An idempotent tool returning the same result this many times in a row triggers a reminder |
| `window` | `30` | How many recent tool calls per agent the detector inspects |
| `idempotentTools` | `['read', 'glob', 'grep', 'list_*']` | Wildcard patterns for read-only tools tracked for no-progress |
| `exclude` | `[]` | Wildcard patterns for tools transparent to the detector (neither count nor reset) |
| `hardStopThreshold` | `3` | When `hardStop` is on, a signal reaching this count blocks the call instead of reminding |
| `hardStop` | `false` | Opt-in: `true` interrupts the call at `hardStopThreshold`; `false` keeps advisory reminders only |

Invalid configuration fails at startup with a clear error — a threshold or `window` below 2, a non-integer, a `window` smaller than any threshold (including `hardStopThreshold` when hard stop is armed) — never a silent change of behavior.

### What you get

With the defaults, a model that repeats the same failing call receives a reminder on the third failure; a model cycling one tool through different failing arguments receives one on the fifth failure; and a model re-reading an unchanged file receives one on the fifth unchanged read. Each reminder names the tool and the count and points at the next move — change approach, use the result already provided, or report an external blocker. A successful call resets the failure streaks, a changed result resets the no-progress streak, and a new user message clears the window, so a fresh instruction or a real edit-and-retry cycle is never treated as a loop. With `hardStop: true`, the same streak that would remind instead blocks the call at `hardStopThreshold`: the tool result becomes an error whose content is an explicit stop instruction, and the loop is broken rather than merely nudged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard detects failures and delivers reminders, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Advisory by default, hard stop opt-in.** The guard enriches post-execute decisions with model context and never blocks or rewrites a call unless `hardStop: true` arms a block at `hardStopThreshold`.
- **Count in post-execute.** Detection runs on `tools/post-execute`, which also fires for denied calls; counting there lets one listener cover every attempt with no cross-event state.
- **Failure judged by the tool's own indicator.** A call is a failure exactly when its result carries `isError: true`, and a no-progress call is a *success* whose rendered content matches the previous success of the same idempotent call.
- **Fail loud at load.** Every threshold and the window validate in `apply` and throw, never falling back to defaults.

### Detection: three signals over a sliding window

Each agent owns a bounded history (`window` entries) of the recent tool-call observations; all three signals are computed as a trailing-consecutive streak over that history, so a success or a changed result resets a streak naturally, and `window` bounds the memory.

- **exact-failure** — the trailing run of failures with the same `(tool, canonical arguments)`; fires at `exactFailureThreshold`. This is the "same broken call replayed unchanged" loop.
- **same-tool-failure** — the trailing run of failures on the same tool, arguments ignored; fires at `sameToolFailureThreshold` (the exact signal wins when both would fire on one call). This is the "one tool keeps failing, different attempts each time" loop.
- **idempotent-no-progress** — for a successful call to a tool matching `idempotentTools`, the trailing run of successful calls with the same `(tool, canonical arguments)` *and* the same canonical result content; fires at `idempotentNoProgressThreshold`. This is the "re-reading an unchanged file" loop.

- **Untracked calls are transparent.** A call excluded by `exclude` is not even recorded, so it neither counts nor resets a streak — bookkeeping tools interleaved into a loop do not launder it.
- **Calls without an agent are ignored.** A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on.
- **Per-agent keying, reset on user prompts.** One agent's streak never trips another's reminder; a user prompt (`agent/pre-step`) deletes the submitting agent's history, and object lifetime bounds the weak entry without a disposal listener.
- **In-memory only.** A session resumed from persistence starts with a fresh window — the guard is a heuristic nudge, not a logged invariant, so reminders after a resume are the accepted cost.

### Reminder delivery

Reminders ride the post-execute decision's `additionalContexts` (source `{kind: 'plugin', plugin: 'failure-loop', form: 'notice', summary: '<signal>: <tool> × <count>'}`), never a `content` replacement: the `tool/result` event stays the tool's own output for audit. The loop buffers the context and appends it as an injected `user/message` after the step's tool results, which the session renders as a plain synthetic user message — model-visible, source-attributed, and reconstructable from the session log with no new session event. The guard always delegates via `next()` and prepends its reminder to the downstream decision's context array, so both decision variants (a blocked call included) still get the nudge while every entry retains its own source and metadata. With `hardStop: true`, once a signal reaches `hardStopThreshold` the guard instead returns a `{ kind: 'block' }` decision whose `feedback` is an explicit stop instruction; the downstream listener's `additionalContexts` are still preserved, but the advisory reminder is replaced by the block's feedback.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, window listeners |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant: the window is private to one post-execute listener) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools waterfall to exhaustive configuration and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` waterfall, `additionalContexts`, and decision shapes this guard consumes.
- [Guard group map](../README.md) — the sibling guard packages and the loop-hygiene family (`repeat-tool-reminder` for identical-call loops, `timeout-policy` for hung calls).

-----

<a id="model-experience"></a>
## Model Experience

### Exact-failure reminder

#### What the model sees

At `exactFailureThreshold` identical failing calls, that agent receives the reminder below. No tool schema or normal-call text is added.

```markdown
<tool> failed <count> times with identical arguments. This looks like a failure loop. Inspect the latest error and change strategy — different arguments, a different tool, or report the blocker — instead of retrying the same call unchanged.
```

### Same-tool-failure reminder

#### What the model sees

At `sameToolFailureThreshold` failing calls to one tool (arguments may differ), that agent receives the reminder below.

```markdown
<tool> failed <count> times in a row. This looks like a failure loop. Diagnose the latest error before retrying: try different arguments, a narrower query or path, or a different tool. If the blocker is external, report it after one diagnostic attempt.
```

### Idempotent no-progress reminder

#### What the model sees

At `idempotentNoProgressThreshold` unchanged results from an idempotent tool, that agent receives the reminder below.

```markdown
<tool> returned the same result <count> times. Use the result already provided or change the query instead of repeating it unchanged.
```

### Hard-stop feedback

#### What the model sees

With `hardStop: true`, once a signal reaches `hardStopThreshold` the offending call is blocked: its `tool/result` becomes an error whose content is the hard-stop instruction below, keyed to the same three signals.

```markdown
Hard stop: <tool> failed <count> times with identical arguments (limit <threshold>). Stop retrying this call. Inspect the latest error and change strategy — different arguments, a different tool, or report the blocker — instead of repeating the same call.
```

```markdown
Hard stop: <tool> failed <count> times in a row (limit <threshold>). Stop retrying. Diagnose the latest error and change approach — different arguments, a narrower query or path, or a different tool — or report an external blocker.
```

```markdown
Hard stop: <tool> returned the same result <count> times (limit <threshold>). Stop repeating this call. Use the result already provided or change the query instead.
```

#### Token effect

Zero tokens before `hardStopThreshold`. The blocked call's error content replaces the call's own output, so the model sees the stop instruction instead of a repeated failure; the `<tool>`, `<count>`, and `<threshold>` placeholders are the only data-dependent text.

Zero tokens before a threshold. Each reminder is retained history for that agent; the `<count>` and `<tool>` placeholders are the only data-dependent text.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Failure judged by the tool's error flag only** — a tool that "fails" but returns `isError: false` with an error string in its content is invisible to the failure signals; detection keys on the registry's own success/error indicator.
- **Trailing-streak, not cumulative** — a failure streak ends as soon as any other call or a success intervenes, so a tool failing with other calls interleaved never accumulates; this is deliberate (interleaving suggests exploration, not a stuck loop) but narrower than a per-turn counter.
- **Compaction does not reset windows** — a window spanning a compaction checkpoint keeps counting.
- **Hard stop is opt-in and streak-gated** — it blocks only when `hardStop: true` and a detected signal reaches `hardStopThreshold`; a loop whose streak stays under its own signal threshold, or a loop interleaved with other calls (which never accumulates), is still only reminded.
- **No subagent window-sharing** — windows stay isolated per agent; a parent and its subagent failing the same call never combine.
- **No-progress needs matching result content** — two idempotent reads that answer the same question with the same facts but different phrasing count as progress, not a loop.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The three-signal taxonomy (exact failure / same-tool failure / idempotent no-progress) is drawn from Hermes Agents' `tool_guardrails.py` failure vocabulary, adapted to the harness's advisory-only, per-agent window model.

</details>
