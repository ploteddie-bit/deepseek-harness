---
description: "Workspace code index for users and maintainers mounting, sizing, or debugging ctx.codeIndex and the code_search tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-code-index

English | [中文](README.zh.md)

## Summary

`dsh-code-index` indexes one workspace's TypeScript and JavaScript source into SQLite and serves it through `ctx.codeIndex` and the `code_search` tool. Declarations come from the TypeScript AST, file text from an FTS5 trigram index, and both fuse with path matching into one per-file ranking. Indexing is explicit: mounting the plugin walks nothing, `indexWorkspace()` runs the walk, and `search()` returns nothing before it. The default `:memory:` database rebuilds per process; a configured `dbPath` persists the index. No embeddings run: the measured bottleneck was ranking the defining file, not semantic coverage.

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

Mount this plugin when an agent should find code by declaration name, file path, or text phrase instead of running a shell `grep` and reading whole files. It is opt-in: no shipped profile mounts it, and the cost of the first search is one workspace walk.

### What the agent gets

The service is `ctx.codeIndex` with four methods.

| Method | Behavior |
|---|---|
| `indexWorkspace({ force? })` | Walks the workspace, extracts symbols, and replaces the whole index in one transaction. Without `force` an already-indexed workspace returns the current status instead of walking again; `force` discards and rebuilds. Concurrent calls serialize on the in-flight run. |
| `search(query, { limit? })` | Returns fused results ordered by descending score. Returns no results before the first index run. |
| `status()` | Reports the covered workspace and whether a complete run recorded `files`, `symbols`, and `updatedAt`. |
| `dispose()` | Closes the database; every later method call throws `code-index: the service is disposed`. |

The covered workspace is the directory the process was launched in, captured once when the service is constructed; it is not the Session working directory and it does not follow later navigation. The walk visits entries in name order, skips symbolic links and excluded directory names, and admits `.ts`, `.tsx`, `.js`, and `.mjs` files under `maxFileBytes`. A directory that cannot be read and a file that disappears between listing and read are skipped without failing the run.

The `code_search` tool registers when `ctx.tools` is already mounted: the Loader reads the registry through `ctx.get('tools')` at apply time. It indexes the workspace on its first call, so mounting the plugin is enough; a deployment that mounts the service without a tool registry never registers a tool.

### Configuration

Every field has a default, so an empty row is a valid configuration.

```yaml
- name: '@deepseek-ai/dsh-code-index'
  config:
    maxFiles: 20000
    maxFileBytes: 1000000
    exclude: ['.git', 'node_modules', 'lib', 'dist', 'build', 'vendor', '.agents']
    dbPath: ':memory:'
```

The accepted fields, at a glance:

```ts
export interface Config {
  maxFiles?: number
  maxFileBytes?: number
  exclude?: string[]
  dbPath?: string
}
```

| Field | Default | Meaning |
|---|---|---|
| `maxFiles` | `20000` | Maximum number of source files one index run collects; the walk stops there |
| `maxFileBytes` | `1000000` | Maximum UTF-8 bytes read from one source file; larger files are skipped |
| `exclude` | `['.git', 'node_modules', 'lib', 'dist', 'build', 'vendor', '.agents']` | Directory names skipped while walking the workspace |
| `dbPath` | `:memory:` | SQLite database path; `:memory:` keeps the index ephemeral |

`exclude` entries are plain directory names matched at any depth: an entry containing a path separator or only whitespace fails at load. `maxFiles` and `maxFileBytes` must be positive safe integers, and a blank `dbPath` fails at load. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-code-index) is the exhaustive source for every accepted field and its JSDoc.

### Observing an index run

`status()` reports `files`, `symbols`, and `updatedAt`; `updatedAt` is the ISO timestamp of the most recent complete replacement and stays null until one finishes. Each run deletes and refills both tables inside a single transaction, so a failed run leaves the previous index intact and the store rethrows the SQLite error.

Measured on this repository's own source with the 2026-10-18 spike, over 6,356 indexed files: 13.11 s for one full run, 236 MB for the SQLite file, p50 4.04 ms and p95 8.25 ms for trigram text queries, and p50 19.55 ms and p95 24.94 ms for symbol-only search. The retained budgets are under 15 s per run, under 50 ms p95, and under 300 MB.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The index answers one question well: which file defines this name. The spike measured FTS5 trigram text search alone at 0.10 hit@1 on that question, while a symbol table reached 0.53, so ranking a declaration above incidental text is the decision the package exists for. Scores are therefore fixed tiers chosen before ranking, not a relevance model.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, `resolveConfig`, service provision, optional tool registration |
| [`src/service.ts`](src/service.ts) | `CodeIndexService`: workspace walk, bounds, symbol collection, run serialization |
| [`src/store.ts`](src/store.ts) | SQLite storage: FTS5 trigram table, symbol table, run metadata, replacement transaction |
| [`src/symbols.ts`](src/symbols.ts) | Declaration extraction from the TypeScript AST |
| [`src/search.ts`](src/search.ts) | Score fusion across the three match sources |
| [`src/tool.ts`](src/tool.ts) | The model-facing `code_search` tool |
| [`src/types.ts`](src/types.ts) | Shared `CodeIndexStatus` and `CodeSearchResult` types |

### Main flow

One run reads every admitted file once, extracts its declarations in memory, then hands both lists to a single `replace()` transaction. Search runs four queries — exact, prefix, and substring over the symbol table, substring over indexed paths, and an FTS5 phrase when the query holds at least three characters — and merges the candidates per path, keeping the highest score. Symbol tiers are 1.0 exact, 0.8 prefix, 0.6 substring; a path match is 0.5; a text match is `0.4 / (1 + |bm25|)`, so it never outranks a path match. Each source is read up to `limit × 4` rows and the fused list is truncated to `limit`, ordered by descending score and then by path.

### Invariants

The service never indexes implicitly and never watches the filesystem: the corpus changes only when a run replaces it. A disposed service rejects every call rather than reopening the database. The default `:memory:` database means the index does not survive the process that built it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the decision that selected this ranking to the exhaustive configuration.

- [Code index service decision record](../../../.agents/notes/implemented/feature/2026-10-18-code-index-service.md) — measured budgets and the alternatives this ranking rejected.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-code-index) — every accepted config field and its source declaration.
- [Context group map](../README.md) — sibling request-context packages.

-----

<a id="model-experience"></a> <a id="prompt-shape"></a>
## Model Experience

### Code search tool

#### What the model sees

A mounted plugin with a tool registry contributes one tool to every request in that agent's tool view. The description and the two parameters are fixed text. The required `query` parameter is described as a declaration name, identifier fragment, path fragment, or text phrase; the optional numeric `limit` caps the returned rows and defaults to 10. A blank or whitespace-only query returns no matches rather than the whole corpus.

##### code_search description

```markdown
Search the indexed workspace source code: declaration names (exact, prefix, and substring matches), file paths, and full-text phrases, fused into one per-file ranked list.
```

#### Token effect

One fixed description and two parameter descriptions on every request while the tool is visible. The tool contributes no system-prompt section and no Session event of its own.

#### KV Cache effect

Prefix-stable while the visible tool set and its registration lifecycle are unchanged; mounting or unmounting the plugin invalidates reuse from the first changed tool token.

### Code search result

#### What the model sees

An empty result is exactly `(no matches in the code index)`. A non-empty result is one line per hit: the score with two decimals, two spaces, the workspace-relative path, and the declaration line for a symbol match, then the match kind and its detail. A symbol line ends with the declaration name; a text line ends with a source excerpt around the first match, shortened with `…` where the surrounding text was cut; a path line has no detail. The recorded result carries the structured fields — `path`, `score`, `kind`, and `line`, `symbol`, or `snippet` — while this rendering is what the model reads.

##### Code search result text

```markdown
1.00  packages/context/code-index/src/service.ts:49  symbol  CodeIndexService
0.80  packages/context/code-index/src/store.ts:61  symbol  CodeIndexStore
0.50  packages/context/code-index/src/search.ts  path
```

#### Token effect

At most `limit` lines per call, default 10, and each text excerpt shows at most 60 characters on each side of the match. Repeated searches accumulate in session history until compaction.

#### KV Cache effect

Append-only; result content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the index is a poor fit or needs operational awareness. They are current package constraints, not a task backlog.

- **The workspace is the process working directory** — the service captures `process.cwd()` when it is constructed, so a Session that changes directories keeps searching the original tree, and a deployment serving several trees needs one service per tree.
- **Indexing is full and explicit** — `indexWorkspace()` walks and replaces the whole corpus, `force` does the same again, and nothing re-indexes after a file changes. A configured `dbPath` still holds the corpus of its last complete run.
- **One run blocks the event loop** — the walk, the AST extraction, and the SQLite writes are synchronous. On this repository that is over 13 s of blocked event loop per run, so a first search inside a request holds the turn.
- **Only four file suffixes are indexed** — `.ts`, `.tsx`, `.js`, and `.mjs`. Python, Rust, Go, and every other source file, plus Markdown and JSON, are outside the corpus.
- **Declaration coverage is narrow** — functions, methods, classes, interfaces, type aliases, enums, and the first named variable of a statement. Re-exports, default exports without a name, computed or private member names, and destructuring patterns record nothing.
- **Short queries skip the text index** — an FTS5 trigram cannot serve a query under three characters, so those queries match symbols and paths only.
- **Ranking is lexical** — no camelCase splitting, stemming, fuzzy matching, or embeddings. `workspaceChanges` misses a snake_case query, and BM25 normalization is corpus-relative, so a score is comparable within one index run, not across runs.
- **Symbol extraction is TypeScript-only** — the AST path understands TypeScript and JavaScript; other languages contribute file text but never a symbol row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The store uses `node:sqlite` `DatabaseSync`, so every query is synchronous; `indexWorkspace()` returns a promise only so concurrent calls can serialize on the in-flight run. The AST walk uses `ts.createSourceFile` with `setParentNodes` enabled, which is what makes `getStart(sourceFile)` usable for line numbers.

Adding an incremental run means recording per-file identity in the store and replacing only changed paths; `replace()` currently deletes both tables, so a partial refresh needs its own transaction and its own decision about symbols whose file vanished.

The symbol tiers, the path tier, and the BM25 cap are exported constants in `src/search.ts`; changing one changes model-visible ordering and belongs with the [decision record](../../../.agents/notes/implemented/feature/2026-10-18-code-index-service.md).

</details>