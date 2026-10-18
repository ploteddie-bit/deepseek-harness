import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as codeIndex from '@deepseek-ai/dsh-code-index'
import type { CodeIndexService, Config } from '@deepseek-ai/dsh-code-index'
import { extractSymbols } from '@deepseek-ai/dsh-code-index'
import { CodeIndexStore } from '@deepseek-ai/dsh-code-index/src/store.ts'

const FIXTURES: Readonly<Record<string, string>> = {
  'src/auth.ts': `// Refresh token expiry in seconds.
export class UserStore {
  private tokens = new Map<string, string>()

  createToken(user: string): string {
    return \`token-\${user}\`
  }

  refreshToken(user: string): string {
    return this.createToken(user)
  }
}

export function createSession(store: UserStore): string {
  return store.createToken('session')
}

const MAX_RETRIES = 3
let attemptCount = 0
export var RETRY_LABEL = 'auth'

// target phrase for snippet edges

// trailing lines after the marker keep a snippet window open below the match
// so the excerpt ends with an ellipsis instead of the file end
`,
  'src/api.ts': `export interface UserProfile {
  id: string
  name: string
}

export type ProfileResult = UserProfile | null

export enum AuthStatus {
  Anonymous = 'anonymous',
  Verified = 'verified',
}

export function normalizeProfile(profile: UserProfile): UserProfile {
  return profile
}
`,
  'src/utils.ts': `export const DEFAULT_PAGE_SIZE = 20
export const TOKEN_PREFIX = 'tk_'

export function formatDate(value: Date): string {
  return value.toISOString()
}

export class DateRange {
  start: Date
  end: Date
  constructor(start: Date, end: Date) {
    this.start = start
    this.end = end
  }
}

const { destructured } = { destructured: 1 }
export function useDestructured(): number {
  return destructured
}
`,
  'legacy.js': `export function legacyHelper() {
  return 42
}
`,
  'node_modules/pkg/index.ts': 'export function excludedDependency() {}\n',
  'lib/generated.ts': 'export function generatedLib() {}\n',
  'notes.md': '# not a source file\n',
  'plainfile': 'export function noExtension() {}\n',
}

let workspace: string
let originalCwd: string

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = mkdtempSync(join(tmpdir(), 'code-index-'))
  for (const [path, content] of Object.entries(FIXTURES)) {
    const absolute = join(workspace, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  process.chdir(workspace)
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(workspace, { recursive: true, force: true })
})

/** Mount the plugin with the workspace as cwd. */
async function mount(config: Config = {}): Promise<{ ctx: Context; fiber: Fiber; service: CodeIndexService }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(codeIndex, config)
  return { ctx, fiber, service: ctx.codeIndex }
}

/** Minimal execution context for direct tool invocation. */
function toolExec(name: string): ToolRunContext {
  return {
    callId: ToolCallId(name),
    rootCallId: ToolCallId(name),
    name: 'code_search',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol() as ToolExecutionToken,
    deferContext() {},
    concludeTurn() {},
  }
}

const itOnPosix = process.platform === 'win32' ? it.skip : it

describe('extractSymbols', () => {
  it('collects named declarations of every supported form', () => {
    const symbols = extractSymbols(`function top(x: number): number { return x }
class Box { read(): number { return 1 } }
interface Shape { area: number }
type Alias = Shape
enum Color { Red, Green }
const CONSTANT = 1
let mutable = 2
var legacy = 3
export default function () {}
const { skipped } = { skipped: true }
`, 'sample.ts')
    expect(symbols.map(symbol => symbol.name)).toEqual([
      'top', 'Box', 'read', 'Shape', 'Alias', 'Color', 'CONSTANT', 'mutable', 'legacy',
    ])
    expect(symbols).toContainEqual({ name: 'top', kind: 'function', line: 1 })
    expect(symbols).toContainEqual({ name: 'read', kind: 'method', line: 2 })
    expect(symbols).toContainEqual({ name: 'Color', kind: 'enum', line: 5 })
  })

  it('keeps string-literal method names without their quotes', () => {
    const symbols = extractSymbols('class K { \'x-y\'() {} }', 'sample.ts')
    expect(symbols.find(symbol => symbol.kind === 'method')).toEqual({ name: 'x-y', kind: 'method', line: 1 })
    // Computed property names name no symbol.
    const computed = extractSymbols('class K { [\'x-y\']() {} }', 'sample.ts')
    expect(computed.some(symbol => symbol.kind === 'method')).toBe(false)
  })

  it('defaults unknown and missing extensions to the TypeScript script kind', () => {
    expect(extractSymbols('function f() {}', 'noextension')).toEqual([{ name: 'f', kind: 'function', line: 1 }])
    expect(extractSymbols('function g() {}', 'odd.rs').map(symbol => symbol.name)).toEqual(['g'])
  })

  it('returns no symbols for declaration-less or destructuring-only sources', () => {
    expect(extractSymbols('const = ;', 'broken.ts')).toEqual([])
    expect(extractSymbols('const { a } = { a: 1 }', 'destructure.ts')).toEqual([])
  })

  it('parses plain JavaScript sources with the matching script kind', () => {
    expect(extractSymbols('function plain() {}', 'plain.js').map(symbol => symbol.name)).toEqual(['plain'])
  })
})

describe('code index service', () => {
  it('reports an unindexed workspace before the first run', async () => {
    const { service } = await mount()
    expect(service.status()).toEqual({
      workspace,
      indexed: false,
      files: 0,
      symbols: 0,
      updatedAt: null,
    })
    expect(await service.search('UserStore')).toEqual([])
    expect(await service.search('  ')).toEqual([])
  })

  it('indexes the workspace and reports counts', async () => {
    const { service } = await mount()
    const status = await service.indexWorkspace()
    expect(status.indexed).toBe(true)
    expect(status.files).toBe(4)
    expect(status.symbols).toBe(17)
    expect(status.updatedAt).not.toBeNull()
  })

  it('ranks an exact case-insensitive declaration match first', async () => {
    const { service } = await mount()
    await service.indexWorkspace()
    const [first] = await service.search('userstore')
    expect(first).toMatchObject({
      path: 'src/auth.ts',
      score: 1,
      kind: 'symbol',
      line: 2,
      symbol: 'UserStore',
    })
  })

  it('scores prefix and substring declaration matches below exact matches', async () => {
    const { service } = await mount()
    await service.indexWorkspace()
    const [prefix] = await service.search('UserSt')
    expect(prefix).toMatchObject({ symbol: 'UserStore', score: 0.8, kind: 'symbol' })
    const [prefixLower] = await service.search('normaliz')
    expect(prefixLower).toMatchObject({ symbol: 'normalizeProfile', score: 0.8, kind: 'symbol' })
    const results = await service.search('rofile', { limit: 20 })
    expect(results.find(result => result.kind === 'symbol')).toMatchObject({
      symbol: 'UserProfile',
      score: 0.6,
    })
  })

  it('matches file paths below declaration matches', async () => {
    const { service } = await mount()
    await service.indexWorkspace()
    const results = await service.search('utils')
    expect(results.find(result => result.path === 'src/utils.ts' && result.kind === 'path')).toMatchObject({
      score: 0.5,
    })
  })

  it('finds multi-word text phrases with a snippet below path matches', async () => {
    const { service } = await mount()
    await service.indexWorkspace()
    const results = await service.search('token expiry')
    const text = results.find(result => result.kind === 'text')
    expect(text).toBeDefined()
    expect(text?.score).toBeGreaterThan(0)
    expect(text?.score).toBeLessThanOrEqual(0.4)
    expect(text?.snippet).toContain('Refresh token expiry')
    // Trigram phrase queries cannot serve sub-3-character queries.
    expect((await service.search('ab')).filter(result => result.kind === 'text')).toEqual([])
    // Blank queries return nothing, on the indexed store too.
    expect(await service.search('  ')).toEqual([])
  })

  it('keeps one best result per path with deterministic ties', async () => {
    const { service } = await mount()
    await service.indexWorkspace()
    const results = await service.search('re', { limit: 20 })
    expect(results.length).toBeGreaterThan(0)
    expect(new Set(results.map(result => result.path)).size).toBe(results.length)
    expect(results.find(result => result.path === 'src/auth.ts')).toMatchObject({
      kind: 'symbol',
      symbol: 'refreshToken',
      score: 0.8,
    })
    // Equal-score paths order lexicographically.
    expect(results.filter(result => result.score === 0.6).map(result => result.path))
      .toEqual(['src/api.ts', 'src/utils.ts'])
  })

  it('escapes LIKE wildcards in prefix queries', async () => {
    const { service } = await mount()
    await service.indexWorkspace()
    const [result] = await service.search('max_')
    expect(result).toMatchObject({ symbol: 'MAX_RETRIES', score: 0.8, kind: 'symbol' })
    // A match deep in the file exercises both snippet ellipses.
    const deep = await service.search('target phrase', { limit: 20 })
    const snippet = deep.find(hit => hit.kind === 'text')?.snippet
    expect(snippet?.startsWith('…')).toBe(true)
    expect(snippet?.endsWith('…')).toBe(true)
    // A match at the file end drops the trailing ellipsis.
    const tail = await service.search('file end')
    const tailSnippet = tail.find(hit => hit.kind === 'text')?.snippet
    expect(tailSnippet?.startsWith('…')).toBe(true)
    expect(tailSnippet?.endsWith('…')).toBe(false)
  })

  it('survives quote characters in the query', async () => {
    const { service } = await mount()
    await service.indexWorkspace()
    await expect(service.search('"token"')).resolves.toBeInstanceOf(Array)
  })

  it('enforces and defaults the result limit', async () => {
    const { service } = await mount()
    await service.indexWorkspace()
    expect(await service.search('token', { limit: 1 })).toHaveLength(1)
    expect(await service.search('token')).toHaveLength(2)
    for (const limit of [0, -1, 1.5]) {
      await expect(service.search('token', { limit })).rejects.toThrow(/limit must be a positive integer/)
    }
  })

  it('replaces the default exclusion set with the configured one', async () => {
    const { service: excluded } = await mount({ exclude: ['src'] })
    // Without `node_modules` and `lib` in the configured set they re-enter the corpus.
    expect((await excluded.indexWorkspace()).files).toBe(3)
    const { service: tiny } = await mount({ maxFileBytes: 10 })
    const status = await tiny.indexWorkspace()
    expect(status).toMatchObject({ indexed: true, files: 0, symbols: 0 })
  })

  it('stops collecting at the configured file cap', async () => {
    const { service } = await mount({ maxFiles: 2 })
    expect((await service.indexWorkspace()).files).toBe(2)
  })

  it('does not reindex without force and reindexes with it', async () => {
    const { service } = await mount()
    const first = await service.indexWorkspace()
    expect((await service.indexWorkspace()).updatedAt).toBe(first.updatedAt)
    writeFileSync(join(workspace, 'src', 'extra.ts'), 'export function extra() {}\n')
    try {
      const forced = await service.indexWorkspace({ force: true })
      expect(forced.files).toBe(5)
      expect(forced.updatedAt).not.toBe(first.updatedAt)
    } finally {
      rmSync(join(workspace, 'src', 'extra.ts'))
    }
  })

  it('serializes concurrent index requests on one run', async () => {
    const { service } = await mount()
    const [left, right] = await Promise.all([service.indexWorkspace(), service.indexWorkspace({ force: true })])
    expect(left).toMatchObject({ indexed: true })
    expect(right).toMatchObject({ indexed: true })
  })

  it('persists the index across service instances with a configured database path', async () => {
    const dbPath = join(workspace, '.dsh', 'code-index.sqlite')
    const first = await mount({ dbPath })
    expect((await first.service.indexWorkspace()).files).toBe(4)
    await first.ctx.fiber.dispose()
    const second = await mount({ dbPath })
    expect(second.service.status()).toMatchObject({ indexed: true, files: 4 })
    expect(await second.service.search('UserStore')).toHaveLength(1)
    await second.ctx.fiber.dispose()
  })

  it('indexes an absent workspace as an empty corpus', async () => {
    const gone = mkdtempSync(join(tmpdir(), 'code-index-gone-'))
    rmSync(gone, { recursive: true, force: true })
    const missing = new codeIndex.CodeIndexService(codeIndex.resolveConfig({}), gone)
    expect(await missing.indexWorkspace()).toMatchObject({ indexed: true, files: 0, symbols: 0 })
    missing.dispose()
  })

  itOnPosix('skips symbolic links while walking', async () => {
    symlinkSync(join(workspace, 'src'), join(workspace, 'link-src'))
    try {
      const { service } = await mount()
      expect((await service.indexWorkspace()).files).toBe(4)
    } finally {
      rmSync(join(workspace, 'link-src'))
    }
  })

  it('disposes with the plugin fiber and rejects later calls', async () => {
    const { ctx, fiber, service } = await mount()
    await service.indexWorkspace()
    await fiber.dispose()
    expect(ctx.get('codeIndex')).toBeUndefined()
    await expect(service.search('UserStore')).rejects.toThrow(/disposed/)
    expect(() => service.status()).toThrow(/disposed/)
    await expect(service.indexWorkspace()).rejects.toThrow(/disposed/)
    // Idempotent disposal.
    expect(() => service.dispose()).not.toThrow()
  })

  it('rejects invalid configuration at plugin load', async () => {
    // Schema-level bounds fail the Loader with schemastery diagnostics.
    await expect(mount({ maxFiles: 0 })).rejects.toThrow(/maxFiles/)
    await expect(mount({ maxFileBytes: 1.5 })).rejects.toThrow(/maxFileBytes/)
    // Direct construction validates the same bounds.
    expect(() => codeIndex.resolveConfig({ maxFiles: 0 })).toThrow(/maxFiles must be a positive safe integer/)
    expect(() => codeIndex.resolveConfig({ maxFileBytes: 1.5 })).toThrow(/maxFileBytes must be a positive safe integer/)
    await expect(mount({ dbPath: '  ' })).rejects.toThrow(/dbPath must not be blank/)
    await expect(mount({ exclude: ['a/b'] })).rejects.toThrow(/plain directory name/)
  })

  it('rolls back a failed replacement and rethrows the cause', () => {
    const store = new CodeIndexStore(':memory:')
    store.replace([{ path: 'a.ts', content: 'keep' }], [], '2026-10-18T00:00:00.000Z')
    function* broken() {
      yield { path: 'b.ts', content: 'next' }
      throw new Error('injected indexing failure')
    }
    expect(() => store.replace(broken(), [], '2026-10-18T00:00:01.000Z')).toThrow(/injected indexing failure/)
    // The rollback preserved the previous corpus and metadata.
    expect(store.snapshot()).toMatchObject({ files: 1, updatedAt: '2026-10-18T00:00:00.000Z' })
    store.close()
  })

  it('rejects a database path that cannot open as a database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'code-index-dbdir-'))
    try {
      await expect(mount({ dbPath: directory })).rejects.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('code_search tool', () => {
  async function mountWithTools(config: Config = {}): Promise<{ ctx: Context }> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(codeIndex, config)
    return { ctx }
  }

  it('registers only when the tool registry is mounted', async () => {
    const plain = new Context()
    await plain.plugin(codeIndex)
    expect(plain.get('tools')).toBeUndefined()
    await plain.fiber.dispose()

    const { ctx } = await mountWithTools()
    expect(ctx.tools.get('code_search')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('indexes on first use and renders ranked lines', async () => {
    const { ctx } = await mountWithTools()
    const tool = ctx.tools.get('code_search')
    expect(tool).toBeDefined()
    const results = await tool!.execute({ query: 'UserStore' }, toolExec('first'))
    const [first] = results as Array<{ path: string; score: number; kind: string; symbol?: string }>
    expect(first).toMatchObject({ path: 'src/auth.ts', score: 1, kind: 'symbol', symbol: 'UserStore' })
    const rendered = tool!.output.render({}, [{
      path: 'src/auth.ts',
      score: 1,
      kind: 'symbol',
      line: 2,
      symbol: 'UserStore',
    }])
    expect(rendered[0]).toMatchObject({ type: 'text', text: '1.00  src/auth.ts:2  symbol  UserStore' })
    // Every result kind renders one readable line, joined in one text block;
    // optional fields fall back to empty details.
    const lines = tool!.output.render({}, [
      { path: 'src/utils.ts', score: 0.8, kind: 'symbol', symbol: 'TOKEN_PREFIX' },
      { path: 'src/auth.ts', score: 0.3, kind: 'text', snippet: '…excerpt…' },
      { path: 'src/api.ts', score: 0.5, kind: 'path' },
      { path: 'src/plain.ts', score: 0.8, kind: 'symbol' },
      { path: 'src/bare.ts', score: 0.3, kind: 'text' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      type: 'text',
      text: '0.80  src/utils.ts  symbol  TOKEN_PREFIX\n'
        + '0.30  src/auth.ts  text  …excerpt…\n'
        + '0.50  src/api.ts  path\n'
        + '0.80  src/plain.ts  symbol  \n'
        + '0.30  src/bare.ts  text  ',
    })
    const [emptyBlock] = tool!.output.render({}, [])
    expect(emptyBlock?.type === 'text' ? emptyBlock.text : undefined).toBe('(no matches in the code index)')
    expect(tool!.presentCall?.({ query: 'UserStore' })).toMatchObject({
      card: 'generic',
      kind: 'search',
      title: 'Search code index for UserStore',
    })
    // A second call reuses the existing index and honors an explicit limit.
    const limited = await tool!.execute({ query: 'token', limit: 1 }, toolExec('second'))
    expect(limited).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
