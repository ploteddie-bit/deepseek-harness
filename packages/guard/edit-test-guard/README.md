---
description: "Advisory loop-hygiene guard that nudges the model to run tests after editing files, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-edit-test-guard

English | [中文](README.zh.md)

## Summary

A model can edit files for a long stretch without ever running the test suite, accumulating changes that nothing has verified. `dsh-edit-test-guard` notices the pattern and reminds the model to test: after an edit- or write-style tool call it checks whether the agent has run a test command within a recent window of tool calls, and if not, delivers a short reminder to run the relevant tests before continuing. The reminder is advice, never a block: the edit always lands, the tool result is unchanged, and the decision to test now, later, or never stays with the model. It tracks each agent separately, so one agent's test run never silences another agent's reminder, and the window bounds how far back it looks.

Unlike the loop-hygiene siblings, this guard is **not shipped in the `dsh` base bundle** — a composition mounts it explicitly when "test after edit" discipline is wanted.

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

Mount this plugin when the model should be reminded to run tests after editing files. It is advisory and ships disabled, so nothing changes until a composition adds it.

### Mounting it in `cordis.yml`

Add the plugin to the composition that assembles the agent's plugins:

```yaml
- name: '@deepseek-ai/dsh-edit-test-guard'
  config:
    editTools: [edit, write]            # tool-name patterns that count as an edit
    testCommands: [test, pytest, vitest, jest, cargo test, go test, make check, pnpm test, npm test, tsc, tox]
    window: 25                          # how many prior tool calls to inspect for a test
    reminder: "You edited a file but no test command has run recently; run the tests."
```

In a TypeScript bundle, mount it like any function plugin:

```ts
import EditTestGuard from '@deepseek-ai/dsh-edit-test-guard'
await ctx.plugin(EditTestGuard, { window: 25 })
```

### Config reference

| Field | Default | Meaning |
|---|---|---|
| `editTools` | `['edit', 'write']` | Tool-name patterns that trigger the check; `*` is a wildcard |
| `testCommands` | see below | Command fragments that count as a test having run |
| `window` | `25` | Number of prior tool calls inspected for a recent test (integer >= 1) |
| `reminder` | see below | Static reminder text delivered when the check fails |
| `reminderText` | unset | Optional `(tool) => string` generator that overrides `reminder` |

Default `testCommands`: `test`, `pytest`, `vitest`, `jest`, `cargo test`, `go test`, `make check`, `pnpm test`, `npm test`, `tsc`, `tox`.

Invalid configuration fails at startup with a clear error — an empty `editTools` or `testCommands` list, or a `window` below 1 — never a silent change of behavior.

### What you get

After an edit with no recent test, the model receives the reminder below, attributed to the plugin. The edit's tool result is untouched; the reminder appears as an injected context message after the tool result. Once the agent runs a command whose arguments contain one of the `testCommands` fragments (for example `bash` with `npm test`), the reminder stops firing until that test falls out of the window.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard detects an edit without a test and delivers the reminder, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on three commitments:

- **Advisory, not veto.** The guard enriches post-execute decisions with model context; it never blocks or rewrites a call, so `PostToolDecision` blocking stays a later listener's job.
- **Detect in post-execute.** Detection runs on `tools/post-execute`, where every settled call — including a denied one — is observable with its agent and arguments in one place.
- **Fail loud at load.** `editTools`, `testCommands`, and `window` validate in `apply` and throw, never falling back to defaults.

### Detection: the recent-test window

Each agent keeps a bounded history of the last `window` serialized tool-call arguments in a `WeakMap<Agent, string[]>`. When a call's name matches an `editTools` pattern, the guard scans that agent's prior history for any entry whose serialized arguments contain one of the `testCommands` fragments (plain case-sensitive substring match). If none is found, the reminder fires; the current edit call is then appended to the history, keeping the bound.

- **Only agent-loop calls participate.** A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on, and is ignored.
- **Per-agent keying.** One agent's test run never silences another agent's reminder; object lifetime bounds the weak entry without a disposal listener.
- **Window-bounded.** History holds at most `window` prior calls; a test that falls out of the window stops suppressing reminders.
- **In-memory only.** A session resumed from persistence starts with a fresh window — the guard is a heuristic nudge, not a logged invariant.

### Reminder delivery

Reminders ride the post-execute decision's `additionalContexts` (source `{kind: 'plugin', plugin: 'edit-test-guard', form: 'notice', summary: '<tool> without tests'}`), never a `content` replacement: the `tool/result` event stays the tool's own output for audit. The loop buffers the context and appends it as an injected `user/message` after the step's tool results, which the session renders as a plain synthetic user message — model-visible, source-attributed, and reconstructable from the session log with no new session event. The guard always delegates via `next()` and prepends its reminder to the downstream decision's context array, so both decision variants (a blocked call included) still get the nudge while every entry retains its own source and metadata.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, window listener |
| — | No runtime invariant companion is published; the edit/test window is private to one post-execute listener and exposes no package-owned event or snapshot that an independent companion can observe. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools waterfall to exhaustive configuration and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` waterfall, `additionalContexts`, and decision shapes this guard consumes.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Edit-without-test context message

#### What the model sees

After an edit- or write-style tool call with no test command in the recent window, that agent receives the reminder below. No tool schema or normal-call text is added. A custom `reminder` replaces this text verbatim; a `reminderText` function produces it dynamically from the tool name.

##### Edit-without-test reminder

```markdown
You edited a file but no test command has run in the recent tool-call history. Run the relevant tests now to verify the change before continuing.
```

#### Token effect

Zero tokens before the first edit without a test. Each reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Substring matching over serialized arguments** — a `testCommands` fragment matches anywhere in a call's serialized arguments, so an edit to a file named `test.js` can read as a test having run; the bare `test` fragment is intentionally broad. Tune `testCommands` for precision.
- **No command-executor awareness** — the guard does not distinguish shell command tools from other tools; any call whose serialized arguments contain a fragment counts as a test. It does not parse `command` fields specifically.
- **Advisory only** — escalating to a blocking form is not implemented, though `PostToolDecision` already supports blocking.
- **In-memory window** — a resumed session starts with an empty window, so an edit immediately after a resume draws a reminder even when tests ran before the resume.
- **No subagent sharing** — windows stay isolated per agent; a parent and its subagent never combine their histories.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
