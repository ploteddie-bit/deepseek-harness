---
description: "Browser-side pre-send security scan that flags credentials, IPs, and secrets in the composer draft, for users choosing or disabling the indicator."
kind: "package-reference"
---

# @deepseek-ai/dsh-ui-pre-send-scan

English | [中文](README.zh.md)

## Summary

The composer draft can carry material that should not be sent — an API key pasted by accident, a private SSH key, a `Bearer` token, or an internal IP. `dsh-ui-pre-send-scan` reads the draft through the `useInput` standard hook and scans it locally for that material, then shows a coloured badge in the `conversation.input.right` slot with the worst severity and hit count. It is an indicator, never a blocker: the send action is not intercepted, the draft is sent to the model unchanged, and no scan result text enters the session log or model context. The scan runs entirely in the browser with no network call, no host behavior, and no model-visible effect.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The plugin contributes a single badge to the composer's right-side tool row. Nothing is wired or configured; it is off by default until a composition adds the row. The badge shows `OFF` when disabled, `OK` when enabled and clean, or the hit count when enabled and hits exist. Clicking toggles the scan on and off, persisted in `localStorage` under `dsh.pre-send-scan.enabled`. The badge colour is keyed to the worst hit severity: `critical` (red), `warn` (amber), `info` (blue), or grey when inactive.

### What you get

A `critical` badge for a detected API key, private key, or GitHub/Slack token; a `warn` badge for an RFC 1918 or loopback IP, a cloud signed URL, a `Bearer` token, or a `password=`/`passwd=`-style assignment; and an `info` badge for a credential-file path such as `~/.ssh/...`. Each hit carries a short context snippet, capped at ~80 characters. The scan stops at 20 hits per draft.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

The plugin is built on three commitments:

- **Indicator, not blocker.** The button observes the draft and reports hits in the browser; it never intercepts the send action, so the model request is unchanged.
- **Local only.** The scan is a pure function over the draft string with zero side effects, zero I/O, and zero network use; nothing leaves the browser.
- **Browser-safe.** The rules are static `RegExp` patterns with no Node APIs, so the client bundle runs anywhere the web GUI runs.

### Detection: the rule list

`scan(text)` runs each rule's global pattern over the draft (resetting `lastIndex` defensively) and returns up to 20 `ScanHit` records (`id`, `severity`, `snippet`). `highestSeverity(hits)` collapses the list to the worst severity. Rules cover API keys (Anthropic, AWS, OpenAI, GitHub, Slack), private-key `BEGIN` headers, RFC 1918/loopback IPs, cloud signed URLs (S3, GCS, Azure SAS), `password`/`passwd`/`pwd` assignments, `Bearer` tokens, and credential-file paths.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Empty host apply; the browser half ships via `exports["./client"]`. |
| [`src/client/index.ts`](src/client/index.ts) | Browser apply: registers the `conversation.input.right` badge. |
| [`src/client/PreSendScanButton.tsx`](src/client/PreSendScanButton.tsx) | Badge component: reads `useInput`, scans, renders severity and count. |
| [`src/client/scanner.ts`](src/client/scanner.ts) | Pure scan rules and `ScanHit` types. |
| — | No runtime invariant companion is published; the scan is browser-local and exposes no package-owned event or snapshot that an independent companion can observe. |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Pre-send scan indicator

#### What the model sees

Nothing changes in the model request. The scan reads the composer draft through the `useInput` standard hook and reports hits only in the browser badge; the draft is sent to the model unchanged, and no scan result text is added to the session log or model context.

#### Token effect

None. The plugin adds no model-visible tokens.

#### KV Cache effect

None. No model-request content is modified.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the indicator is a poor fit. They are current package constraints, not a task backlog.

- **Indicator only** — the scan never blocks a send, so a user who ignores the badge can still send sensitive material; blocking or confirmation is not implemented.
- **Static pattern matching** — the rules are regular expressions with no semantic validation, so a well-formed key outside the known formats, or a secret spelled differently, is not flagged.
- **No host-side scan** — the browser half alone scans the draft; there is no server-side or logged counterpart.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package name `@deepseek-ai/dsh-ui-pre-send-scan` deviates from the `dsh-client-<name>` convention for `packages/client/*` ([rule](../../AGENTS.md#web-client-stack)). Renaming to `@deepseek-ai/dsh-client-ui-pre-send-scan` would touch the `paths` mapping in `tsconfig.base.json` and require regenerating `pnpm-lock.yaml`, both outside the scoped cleanup that added this README; the rename is deferred until the package is wired into a bundle.

</details>
