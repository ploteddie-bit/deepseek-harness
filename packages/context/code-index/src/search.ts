/**
 * Score fusion across the symbol table, path matching, and FTS5 trigram text search.
 *
 * Each source proposes candidates with a fixed tier score; the best per-path
 * candidate wins, and results sort by descending score.
 * @module @deepseek-ai/dsh-code-index/search
 */

import type { CodeIndexStore } from './store.ts'
import type { CodeSearchResult } from './types.ts'

/** Case-insensitive exact declaration-name match. */
export const SYMBOL_EXACT_SCORE = 1
/** Case-insensitive declaration-name prefix match. */
export const SYMBOL_PREFIX_SCORE = 0.8
/** Case-insensitive declaration-name substring match. */
export const SYMBOL_SUBSTRING_SCORE = 0.6
/** Case-insensitive file-path substring match. */
export const PATH_MATCH_SCORE = 0.5
/** Upper bound for normalized BM25 text matches. */
export const TEXT_BM25_CAP = 0.4

/** Minimum query length a trigram index can serve. */
const MIN_TRIGRAM_LENGTH = 3
/** Characters of context shown on each side of a text match. */
const SNIPPET_RADIUS = 60
/** Candidates collected per source to bound worst-case merging. */
const SOURCE_LIMIT_FACTOR = 4

type SymbolRow = {
  name: string
  path: string
  line: number
  kind: string
}

type PathRow = {
  path: string
}

type TextRow = {
  path: string
  content: string
  rank: number
}

/**
 * Fuse all match sources into one per-path ranking.
 * @param store - open index store.
 * @param query - raw query text; trimmed inside.
 * @param limit - maximum returned results; at least 1.
 * @returns results ordered by descending score, then path.
 */
export function search(store: CodeIndexStore, query: string, limit: number): CodeSearchResult[] {
  const normalized = query.trim()
  if (normalized.length === 0) return []
  const lower = normalized.toLowerCase()
  const escaped = escapeLike(lower)
  const db = store.handle
  const byPath = new Map<string, CodeSearchResult>()
  const merge = (candidate: CodeSearchResult): void => {
    const existing = byPath.get(candidate.path)
    if (existing === undefined || candidate.score > existing.score) byPath.set(candidate.path, candidate)
  }
  const bound = limit * SOURCE_LIMIT_FACTOR

  for (const row of db.prepare(
    'SELECT name, path, line, kind FROM symbols WHERE lower(name) = ? ORDER BY path, line, name LIMIT ?',
  ).all(lower, bound) as SymbolRow[]) {
    merge({ path: row.path, score: SYMBOL_EXACT_SCORE, kind: 'symbol', line: row.line, symbol: row.name })
  }
  for (const row of db.prepare(
    'SELECT name, path, line, kind FROM symbols WHERE lower(name) LIKE ? ESCAPE \'\\\' ORDER BY path, line, name LIMIT ?',
  ).all(`${escaped}%`, bound) as SymbolRow[]) {
    merge({ path: row.path, score: SYMBOL_PREFIX_SCORE, kind: 'symbol', line: row.line, symbol: row.name })
  }
  for (const row of db.prepare(
    'SELECT name, path, line, kind FROM symbols WHERE instr(lower(name), ?) > 0 ORDER BY path, line, name LIMIT ?',
  ).all(lower, bound) as SymbolRow[]) {
    merge({ path: row.path, score: SYMBOL_SUBSTRING_SCORE, kind: 'symbol', line: row.line, symbol: row.name })
  }
  for (const row of db.prepare(
    'SELECT path FROM docs WHERE instr(lower(path), ?) > 0 ORDER BY path LIMIT ?',
  ).all(lower, bound) as PathRow[]) {
    merge({ path: row.path, score: PATH_MATCH_SCORE, kind: 'path' })
  }
  if (normalized.length >= MIN_TRIGRAM_LENGTH) {
    const matched = db.prepare(
      'SELECT path, content, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank, path LIMIT ?',
    ).all(quoteFtsQuery(normalized), bound) as TextRow[]
    for (const row of matched) {
      merge({
        path: row.path,
        score: TEXT_BM25_CAP / (1 + Math.abs(row.rank)),
        kind: 'text',
        snippet: makeSnippet(row.content, lower),
      })
    }
  }
  return [...byPath.values()].sort(compareResults).slice(0, limit)
}

/** Order by descending score; equal scores keep the lexicographically first path. */
function compareResults(left: CodeSearchResult, right: CodeSearchResult): number {
  return right.score - left.score || left.path.localeCompare(right.path)
}

/** Quote one FTS5 phrase, doubling internal double quotes. */
function quoteFtsQuery(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

/** Escape `%`, `_`, and `\` for a LIKE pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

/** Excerpt one source file around its first case-insensitive query match. */
function makeSnippet(content: string, lowerQuery: string): string {
  const index = content.toLowerCase().indexOf(lowerQuery)
  /* v8 ignore next -- an FTS5 phrase match implies a case-insensitive substring match */
  if (index < 0) return content.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(content.length, index + lowerQuery.length + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}
