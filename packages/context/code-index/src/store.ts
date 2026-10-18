/**
 * SQLite backing store for the workspace code index.
 *
 * One FTS5 trigram table holds file text, one plain table holds extracted
 * symbols, and one key-value table holds run metadata. The store owns schema
 * creation, opening, closing, and the replacement transaction; query SQL
 * lives in {@link ./search.ts}.
 * @module @deepseek-ai/dsh-code-index/store
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Text row entering the full-text table. */
export interface IndexDocument {
  /** Workspace-relative source file path, `/`-separated. */
  path: string
  /** Raw file text. */
  content: string
}

/** Symbol row entering the symbol table. */
export interface IndexSymbol {
  /** Declared name. */
  name: string
  /** Workspace-relative source file path, `/`-separated. */
  path: string
  /** 1-based source line of the declaration. */
  line: number
  /** Declaration form. */
  kind: string
}

/** Run metadata the store serves back through `status()`. */
export interface IndexSnapshot {
  /** Number of indexed documents. */
  files: number
  /** Number of indexed symbols. */
  symbols: number
  /** ISO timestamp of the most recent complete replacement, or null. */
  updatedAt: string | null
}

const META_UPDATED_AT = 'updatedAt'

type CountRow = {
  count: number
}

type MetaRow = {
  value: string | null
}

/**
 * Open (creating when needed) the code-index database and ensure its schema.
 * @param path - database file path or `:memory:` for an ephemeral index.
 * @returns store owning the open handle.
 */
export class CodeIndexStore {
  private readonly db: DatabaseSync
  private closed = false

  constructor(path: string) {
    const actual = path === ':memory:' ? path : resolve(path)
    if (actual !== ':memory:') mkdirSync(dirname(actual), { recursive: true })
    const db = new DatabaseSync(actual)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
          path UNINDEXED,
          content,
          tokenize = 'trigram'
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS symbols (
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          line INTEGER NOT NULL,
          kind TEXT NOT NULL
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name)')
      db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    /* v8 ignore start -- a failed open throws before the try; schema failure requires a broken SQLite build */
    } catch (error: unknown) {
      db.close()
      throw error
    }
    /* v8 ignore stop */
    this.db = db
  }

  /** Open database handle; queries in {@link ./search.ts} run against it. */
  get handle(): DatabaseSync {
    return this.db
  }

  /** Read the current indexed state. */
  snapshot(): IndexSnapshot {
    const files = this.db.prepare('SELECT count(*) AS count FROM docs').get() as CountRow
    const symbols = this.db.prepare('SELECT count(*) AS count FROM symbols').get() as CountRow
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(META_UPDATED_AT) as MetaRow
    return { files: files.count, symbols: symbols.count, updatedAt: row?.value ?? null }
  }

  /** Replace the full corpus and metadata in one transaction. */
  replace(documents: Iterable<IndexDocument>, symbols: Iterable<IndexSymbol>, updatedAt: string): void {
    let began = false
    try {
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      this.db.exec('DELETE FROM docs')
      this.db.exec('DELETE FROM symbols')
      const insertDoc = this.db.prepare('INSERT INTO docs (path, content) VALUES (?, ?)')
      for (const document of documents) insertDoc.run(document.path, document.content)
      const insertSymbol = this.db.prepare('INSERT INTO symbols (name, path, line, kind) VALUES (?, ?, ?, ?)')
      for (const symbol of symbols) insertSymbol.run(symbol.name, symbol.path, symbol.line, symbol.kind)
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(META_UPDATED_AT, updatedAt)
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      if (began) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // The original SQLite failure remains the actionable cause.
        }
      }
      throw error
    }
  }

  /** Close the handle; further reads fail. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
