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

<a id="dev-note"></a>
## Dev Note

The route reuses `DeepSeekAdapter` and its resolution logic from `@deepseek-ai/dsh-llm-deepseek`, owns a distinct provider route, and never modifies `llm-deepseek`.
