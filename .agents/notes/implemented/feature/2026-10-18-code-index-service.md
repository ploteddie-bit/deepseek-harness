# Agent Note: Workspace code index service

Status: implemented

English | [中文](2026-10-18-code-index-service.zh.md)

## Problem

An agent that does not know a codebase searches it with shell tools: one `grep` per identifier, then a full read of every candidate file, then again for the next question. On a repository of 6,356 TypeScript and JavaScript files that is slow, wasteful in context, and imprecise, because text frequency ranks the file that merely mentions a name above the file that declares it. The question an agent actually asks is "where is this declared", and no existing harness capability answers it: `ctx.sessionQuery` indexes session transcripts, and the filesystem tools read files the agent already knows about.

The 2026-10-18 spike (`~/.dsh/docs/spike-code-index-20261018.html`) measured the options before anything was built. FTS5 with the `unicode61` tokenizer answered in 0.59 ms p95 but returned the defining file first for only 1 of 10 complete identifiers and matched 1 of 5 natural-language expressions. FTS5 with the `trigram` tokenizer cost 13.11 s and 236 MB for the same corpus and matched 5 of 5 natural-language expressions, while its hit@1 stayed at 0.10: BM25 ranks a file that mentions a name above the file that defines it. A symbol table alone reached hit@1 0.53 in 20–25 ms. The bottleneck was ranking, not coverage, and the fix had to place a declaration above incidental text.

## Decision

The [code-index package](../../../../packages/context/code-index/README.md) provides one service, `ctx.codeIndex`, over one workspace. It combines an FTS5 trigram table for file text with a plain symbol table filled by TypeScript AST extraction, then fuses both with path matching into a single per-path ranking. No embedding model runs, and the service owns no vector store.

### Service surface and lifecycle

`indexWorkspace({ force })` walks the workspace, extracts symbols, and replaces the whole corpus in one transaction. It is the only writer, it is explicit, and `search()` returns nothing before it has run. `status()` reports the covered workspace, whether a complete run recorded `updatedAt`, and the file and symbol counts. `dispose()` closes the database and every later call fails loudly.

The workspace is `process.cwd()`, captured once at construction. It is not the Session working directory: the service is process-scoped, one workspace per service instance, which matches the single working directory a launched harness process serves. `dbPath` defaults to `:memory:`, so the index is rebuilt by the first search of every process and never becomes stale state on disk unless a deployment names a path.

### Index and ranking

The walk admits `.ts`, `.tsx`, `.js`, and `.mjs` files under `maxFileBytes`, skips symbolic links and excluded directory names, and stops at `maxFiles`. Declarations come from `ts.createSourceFile`, not from regular expressions: functions, methods, classes, interfaces, type aliases, enums, and the first named variable of a statement. A directory that cannot be read is skipped, so one permission error does not fail a run.

Ranking uses fixed tiers decided before sorting, so the order is reproducible across runs rather than corpus-relative: an exact declaration name scores 1.0, a name prefix 0.8, a name substring 0.6, a path substring 0.5, and a text match `0.4 / (1 + |bm25|)`, capped below the path tier. The best candidate per path wins, results sort by descending score then by path, and each source is read up to four times the requested limit before merging. A query under three characters skips the trigram search, because a trigram index cannot serve it.

### Tool registration

The plugin registers `code_search` when `ctx.tools` is already mounted, reading the registry through `ctx.get('tools')` at apply time. The tool indexes on its first call, so a mount needs no separate startup step, and a deployment that wants only the service registers no tool.

### Measured budgets

Over 6,356 indexed files, the spike measured 13.11 s for one full trigram run and 235.99 MB for the SQLite file; text queries reached p50 4.04 ms and p95 8.25 ms, symbol-only search p50 19.55 ms and p95 24.94 ms, and symbol extraction 0.93 s over 173,593 declarations. The retained budgets are under 15 s per run, under 50 ms p95, and under 300 MB. Every measured figure sits far inside the 300 ms latency budget the spike set, so the constraints that matter are index size and re-index time, not query latency.

## Alternatives considered

**Add embeddings in the first version.** No embedding model runs locally, and shipping one would add a model download, its memory cost, and a new failure surface to answer a problem the measurements did not show. The measured gap was hit@1, which a symbol table closes structurally. Embeddings stay deferred and are reconsidered only if fused recall remains under 0.85 hit@10 on a corpus larger than this repository.

**Extend `ctx.sessionQuery` with source files.** `ctx.sessionQuery` owns session transcripts, their retention, and their logical corpus; source files are not session records and have no session lifecycle. Putting them in that store would couple the code index to session deletion and to the transcript query surface, and a trigram table of source text does not fit the session schema. A separate package with its own store keeps those lifecycles independent.

**Add a third search engine.** The two measured engines already separate the cases cleanly: `unicode61` is 0.59 ms p95 and unusable on phrases, trigram is 8 ms p95 and finds phrases. A third engine — an embedded library or an external service — would add a dependency and a deployment surface without addressing the ranking tier that the measurements identified as the actual defect. Spending that effort on symbol tiers cost no new dependency and removed the reason the text engine was alone. The spike projected hit@1 above 0.60 for the fused ranking; that projection stays unverified because no retrieval evaluation ships with the package, so a regression in ordering would not fail a gate.

## Consequences

The first search of a process pays a full workspace walk: 13 s of synchronous work on a repository this size, because the store uses `node:sqlite` `DatabaseSync` and the AST walk is synchronous. Any incremental re-index is deferred; a configured `dbPath` persists the corpus of the last complete run, and nothing re-indexes when a file changes. Four source suffixes are indexed, so a polyglot repository is covered only in part, and ranking is lexical — no camelCase splitting, stemming, or fuzzy matching, so `workspaceChanges` does not match a snake_case query. BM25 normalization is corpus-relative, which makes a score meaningful within one index run but not comparable across runs.