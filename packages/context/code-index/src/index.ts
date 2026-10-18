/**
 * Workspace code index plugin.
 *
 * Provides `ctx.codeIndex` and, when the tool registry is already mounted,
 * registers the `code_search` tool. The index is explicit: nothing is
 * indexed at plugin load, so mounting the plugin is cheap and a deployment
 * that only wants the service pays no walk cost.
 *
 * @module @deepseek-ai/dsh-code-index
 */

import type {} from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CodeIndexService,
  DEFAULT_EXCLUDE,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  type ResolvedConfig,
} from './service.ts'
import { defineCodeSearchTool } from './tool.ts'

export {
  CodeIndexService,
  DEFAULT_EXCLUDE,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_SEARCH_LIMIT,
} from './service.ts'
export type { ResolvedConfig } from './service.ts'
export { extractSymbols } from './symbols.ts'
export type { CodeSymbol, SymbolKind } from './symbols.ts'
export type { CodeIndexStatus, CodeSearchKind, CodeSearchResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Workspace code index: explicit indexing plus fused symbol/text/path search. */
    codeIndex: CodeIndexService
  }
}

/** Stable Loader identity. */
export const name = 'code-index'

/** Deployment-facing code-index configuration; every field has a default. */
export interface Config {
  /** Maximum number of source files one index run collects. Defaults to 20000. */
  maxFiles?: number
  /** Maximum UTF-8 bytes read from one source file; larger files are skipped. Defaults to 1000000. */
  maxFileBytes?: number
  /**
   * Directory names skipped while walking the workspace. Defaults to
   * `['.git', 'node_modules', 'lib', 'dist', '.dist', 'build', '.turbo', 'coverage', 'vendor', '.agents']`.
   */
  exclude?: string[]
  /** SQLite database path. Defaults to `:memory:`, an ephemeral index rebuilt per process. */
  dbPath?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxFiles: z.number().step(1).min(1).default(DEFAULT_MAX_FILES),
  maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
  exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE]),
  dbPath: z.string(),
})

/**
 * Default and validate the deployment-facing configuration.
 * @param config - plugin configuration row.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    maxFiles: config.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    exclude: config.exclude ?? [...DEFAULT_EXCLUDE],
    dbPath: config.dbPath ?? ':memory:',
  }
  if (!Number.isSafeInteger(resolved.maxFiles) || resolved.maxFiles < 1) {
    throw new Error('code-index: maxFiles must be a positive safe integer')
  }
  if (!Number.isSafeInteger(resolved.maxFileBytes) || resolved.maxFileBytes < 1) {
    throw new Error('code-index: maxFileBytes must be a positive safe integer')
  }
  if (resolved.dbPath.trim().length === 0) {
    throw new Error('code-index: dbPath must not be blank')
  }
  for (const entry of resolved.exclude) {
    if (entry.trim().length === 0 || /[\\/]/.test(entry)) {
      throw new Error(`code-index: exclude entry must be a plain directory name, got ${JSON.stringify(entry)}`)
    }
  }
  return resolved
}

/**
 * Provide `ctx.codeIndex` and, when the tool registry is already mounted,
 * register `code_search`.
 * @param ctx - host context.
 * @param config - validated bounds and database path.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const service = new CodeIndexService(resolved, process.cwd())
  ctx.effect(() => ctx.provide('codeIndex', service), 'codeIndex.provide')
  ctx.effect(() => () => service.dispose(), 'codeIndex.dispose')
  // Optional tool registration: without `ctx.tools` the service alone remains
  // usable, and no tool appears.
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    ctx.effect(() => tools.register(defineCodeSearchTool(service)), 'codeIndex.tool')
  }
}
