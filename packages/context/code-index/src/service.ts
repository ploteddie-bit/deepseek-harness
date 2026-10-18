/**
 * Concrete code-index service: walks one workspace, extracts declarations
 * with the TypeScript AST, stores text and symbols in SQLite, and fuses
 * per-path search scores.
 * @module @deepseek-ai/dsh-code-index/service
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { search } from './search.ts'
import { CodeIndexStore, type IndexDocument, type IndexSymbol } from './store.ts'
import { extractSymbols } from './symbols.ts'
import type { CodeIndexStatus, CodeSearchResult } from './types.ts'

/** Default maximum number of source files one index run collects. */
export const DEFAULT_MAX_FILES = 20_000
/** Default maximum UTF-8 bytes read from one source file. */
export const DEFAULT_MAX_FILE_BYTES = 1_000_000
/** Default directory names skipped while walking the workspace. */
export const DEFAULT_EXCLUDE = ['.git', 'node_modules', 'lib', 'dist', 'build', 'vendor', '.agents'] as const
/** Default maximum number of returned search results. */
export const DEFAULT_SEARCH_LIMIT = 10

/** Source file suffixes that enter the index. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.mjs'])

/** Validated runtime configuration, defaulted by {@link ./index.ts}. */
export interface ResolvedConfig {
  /** Maximum number of source files one index run collects. */
  maxFiles: number
  /** Maximum UTF-8 bytes read from one source file; larger files are skipped. */
  maxFileBytes: number
  /** Directory names skipped while walking the workspace. */
  exclude: readonly string[]
  /** SQLite database path; `:memory:` keeps the index ephemeral. */
  dbPath: string
}

/**
 * Own one workspace's code index.
 *
 * The index is process-scoped: it covers the directory the process was
 * launched in (the session working directory per the harness launch model),
 * captured once at construction. `indexWorkspace` is explicit and
 * idempotent; `search` is passive and returns no results before the first
 * index run. With the default `:memory:` database the index rebuilds on every
 * process start; a configured `dbPath` persists it across runs.
 */
export class CodeIndexService {
  private readonly config: ResolvedConfig
  private readonly workspace: string
  private readonly store: CodeIndexStore
  private disposed = false
  private indexing: Promise<CodeIndexStatus> | undefined

  constructor(config: ResolvedConfig, workspace: string) {
    this.config = config
    this.workspace = workspace
    this.store = new CodeIndexStore(config.dbPath)
  }

  /**
   * Index the workspace when it is not indexed yet, or re-index when forced.
   * Concurrent calls serialize on the in-flight run.
   * @param options - `force` discards the existing index and rebuilds.
   * @returns the post-run status.
   */
  async indexWorkspace(options: { force?: boolean } = {}): Promise<CodeIndexStatus> {
    this.assertOpen()
    const force = options.force === true
    const previous = this.indexing ?? Promise.resolve()
    const current = previous.then(() => {
      if (!force && this.status().indexed) return this.status()
      return this.runIndex()
    })
    this.indexing = current
    try {
      return await current
    } finally {
      if (this.indexing === current) this.indexing = undefined
    }
  }

  /**
   * Search the indexed corpus. An unindexed workspace returns no results.
   * @param query - declaration name, identifier fragment, path fragment, or text phrase.
   * @param options - `limit` bounds the result count; at least 1.
   * @returns fused results ordered by descending score.
   */
  async search(query: string, options: { limit?: number } = {}): Promise<CodeSearchResult[]> {
    this.assertOpen()
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`code-index: limit must be a positive integer, got ${String(limit)}`)
    }
    if (!this.status().indexed) return []
    return search(this.store, query, limit)
  }

  /** Current indexed state; `updatedAt` records the most recent complete run. */
  status(): CodeIndexStatus {
    this.assertOpen()
    const snapshot = this.store.snapshot()
    return {
      workspace: this.workspace,
      indexed: snapshot.updatedAt !== null,
      files: snapshot.files,
      symbols: snapshot.symbols,
      updatedAt: snapshot.updatedAt,
    }
  }

  /** Close the underlying database. The store owns idempotence; the service rejects further calls. */
  dispose(): void {
    this.disposed = true
    this.store.close()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('code-index: the service is disposed')
  }

  /** Walk, read, extract, and replace the full corpus in one transaction. */
  private runIndex(): CodeIndexStatus {
    const documents: IndexDocument[] = []
    const symbols: IndexSymbol[] = []
    const excluded = new Set(this.config.exclude)
    let collected = 0
    const collect = (directory: string): void => {
      /* v8 ignore next -- the caller-side cap check makes this entry guard unreachable */
      if (collected >= this.config.maxFiles) return
      let entries: Dirent[]
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        // One unreadable directory (permissions, deletion race) must not fail the run.
        return
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (collected >= this.config.maxFiles) return
        if (entry.isSymbolicLink()) continue
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name)) collect(absolute)
          continue
        }
        if (!entry.isFile() || !TEXT_EXTENSIONS.has(extensionOf(entry.name))) continue
        const path = relative(this.workspace, absolute).split(sep).join('/')
        let content: string
        try {
          if (statSync(absolute).size > this.config.maxFileBytes) continue
          content = readFileSync(absolute, 'utf8')
        } catch {
          /* v8 ignore next -- a file removed or made unreadable between listing and read is skipped */
          continue
        }
        collected += 1
        documents.push({ path, content })
        for (const symbol of extractSymbols(content, path)) {
          symbols.push({ name: symbol.name, path, line: symbol.line, kind: symbol.kind })
        }
      }
    }
    collect(this.workspace)
    this.store.replace(documents, symbols, new Date().toISOString())
    return this.status()
  }
}

/** Lowercase suffix of one file name, or the empty string without a dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}
