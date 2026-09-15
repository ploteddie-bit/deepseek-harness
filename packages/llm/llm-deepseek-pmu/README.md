---
description: "Run a second DeepSeek route with its own API key, so a PMU credential and the official credential appear as independent entries in the Models page."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-pmu

English | [中文](README.zh.md)

## Summary

You can talk to DeepSeek through a second, independent route that uses its own API key, while the official route keeps working beside it. Both appear as separate entries in the Models page, so you can pick one per conversation and compare them without touching the other's configuration. Nothing secret is stored in the repository: the key is read from `DEEPSEEK_PMU_API_KEY` at each request. Choose it when a second credential — a shared or departmental key — must stay isolated from your personal one.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Export the key in the launching environment:

```sh
export DEEPSEEK_PMU_API_KEY=sk-...
```

Then select the `deep-pmu` provider in the Models page or from the picker.

| Setting | Value |
|---|---|
| Provider route | `deep-pmu` |
| Display name | `DeepSeek PMU` |
| Settings namespace | `llm-deepseek-pmu` |
| API key | `DEEPSEEK_PMU_API_KEY`, read per request |

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the reused `DeepSeekAdapter` from `@deepseek-ai/dsh-llm-deepseek`, which owns every model-visible request field and the response rendering this route streams.

#### KV Cache effect

The route adds no cache behaviour of its own: the reused adapter's request assembly, image representation, and reasoning passback decide the reusable prefix, and a different API key or endpoint selects a different provider cache domain.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where this route stops and the reused adapter takes over. They are current package constraints, not a task backlog.

- **No `baseURL` or `protocol` setting** — the plugin declares neither, so the route resolves its endpoint the way the official route does and both reach the same root. Pointing it at an OpenAI-compatible gateway needs a `baseURL` field this plugin does not expose.
- **Only `apiKeyEnv` is configurable** — thinking policy, image budgets, request caps, and the retry policy keep the defaults that `resolveAdapterOptions` supplies.
- **The advisory catalog ships two text-only models** — `deepseek-flash` and `deepseek-v4-pro`; the route declares no image-capable entry and no model using `systemPromptUpdate: in-history`, so it cannot advertise vision or the in-history system-prompt mode.
- **A rejected settings section keeps the last good connection facts** — the plugin logs the failure and keeps serving, so an invalid `llm-deepseek-pmu` section degrades to the previous values instead of failing the next request. Only the first resolution, with no last good value, throws.
- **Provider registration duplicates the sibling adapter's wiring** — extracting a shared helper for the reuse pattern is deferred until a third route needs it.

<a id="dev-note"></a>
### Dev Note

The route reuses `DeepSeekAdapter` and its resolution logic from `@deepseek-ai/dsh-llm-deepseek`, owns a distinct provider route, and never modifies `llm-deepseek`.

**Runtime invariant:** No companion is published. This package registers a second adapter instance on the existing `ctx.llm` seam and exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
