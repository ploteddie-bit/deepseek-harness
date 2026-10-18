/**
 * Shared contract types for the workspace code index.
 * @module @deepseek-ai/dsh-code-index/types
 */

/** How one search result matched: a declaration, file text, or the file path. */
export type CodeSearchKind = 'symbol' | 'text' | 'path'

/** Snapshot of one workspace index run. */
export interface CodeIndexStatus {
  /** Absolute workspace directory the index covers. */
  workspace: string
  /** Whether at least one complete index run has recorded its metadata. */
  indexed: boolean
  /** Number of source files whose text entered the full-text table. */
  files: number
  /** Number of extracted declarations in the symbol table. */
  symbols: number
  /** ISO timestamp of the most recent index run, or null when never indexed. */
  updatedAt: string | null
}

/** One fused search hit: the best per-path match across symbol, text, and path sources. */
export interface CodeSearchResult {
  /** Workspace-relative source file path, `/`-separated. */
  path: string
  /** Fused relevance score in (0, 1]; higher is better. */
  score: number
  /** Match source: a declaration, the file text, or the file path. */
  kind: CodeSearchKind
  /** 1-based source line of a symbol match. */
  line?: number
  /** Declaration name for a symbol match. */
  symbol?: string
  /** Short source excerpt around a text match. */
  snippet?: string
}
