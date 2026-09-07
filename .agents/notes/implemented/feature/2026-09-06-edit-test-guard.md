# Agent Note: Edit-test guard

Status: implemented

English | [中文](2026-09-06-edit-test-guard.zh.md)

## Problem

A model can edit files for a long stretch without ever running the test suite, accumulating changes that nothing has verified. Unlike the loop-hygiene guards, there was no nudge that tied editing to running tests.

## Decision

`dsh-edit-test-guard` is an advisory guard that, after an edit- or write-style tool call, checks whether the calling agent ran a test command within a recent window of tool calls; if not, it delivers a short reminder to run the relevant tests. It never blocks: the edit always lands, the tool result is unchanged, and the decision to test now, later, or never stays with the model.

Each agent keeps a bounded history of the last `window` serialized tool-call arguments in a `WeakMap`. When a call's name matches an `editTools` pattern, the guard scans that history for an entry whose serialized arguments contain one of the `testCommands` fragments (plain case-sensitive substring match). The reminder rides the post-execute decision's `additionalContexts`, attributed to the plugin, and a test run that falls out of the window stops suppressing it. Configuration (`editTools`, `testCommands`, `window`, `reminder`, optional `reminderText`) validates in `apply` and throws on invalid values.

Unlike the loop-hygiene siblings, this guard is not shipped in the `dsh` base bundle; a composition mounts it explicitly when "test after edit" discipline is wanted.

## Alternatives considered

**Block edits until a test runs.** Vetoing an edit would break legitimate quick changes and force a test for every file touch; advisory keeps the decision with the model.

**Track test commands structurally.** Parsing the `command` field of shell tools would be more precise but couples the guard to tool shapes; the substring match over serialized arguments is intentionally broad and configurable.

**A shared loop-hygiene counter.** Reusing the repeat/failure chain state would conflate "editing without testing" with "failing loops"; a separate per-agent window keeps the signals independent.

## Consequences

- The guard is advisory and ships disabled; enabling it is a composition choice.
- Substring matching over serialized arguments can read an edit to a file named `test.js` as a test having run; `testCommands` is the tuning surface.
- The window is in-memory, so a resumed session starts with a fresh history and an edit right after resume can draw a reminder.
