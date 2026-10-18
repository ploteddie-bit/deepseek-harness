/**
 * The model-facing `code_search` tool over the code-index service.
 * @module @deepseek-ai/dsh-code-index/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CodeIndexService } from './service.ts'

/**
 * Build the registry-ready `code_search` tool bound to one index service.
 * The tool indexes the workspace on first use, so an opt-in mount is
 * immediately usable without a separate indexing step.
 * @param service - open code-index service.
 * @returns tool definition for `ctx.tools.register`.
 */
export function defineCodeSearchTool(service: CodeIndexService) {
  return defineTool({
    name: 'code_search',
    description:
      'Search the indexed workspace source code: declaration names (exact, prefix, and substring matches), '
      + 'file paths, and full-text phrases, fused into one per-file ranked list.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Declaration name, identifier fragment, path fragment, or text phrase.',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return. Defaults to 10.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            score: { type: 'number', required: true },
            kind: { type: 'string', required: true, enum: ['symbol', 'text', 'path'] },
            line: { type: 'number' },
            symbol: { type: 'string' },
            snippet: { type: 'string' },
          },
        },
      },
      render: (_args, results) => [{
        type: 'text',
        text: results.length === 0 ? '(no matches in the code index)' : results.map(renderLine).join('\n'),
      }],
    },
    async execute(args) {
      // The service exposes no implicit indexing; the tool owns that convenience.
      if (!service.status().indexed) await service.indexWorkspace()
      const options = typeof args.limit === 'number' ? { limit: args.limit } : {}
      return service.search(String(args.query), options)
    },
    presentCall: args => ({
      card: 'generic',
      title: `Search code index for ${String(args.query)}`,
      kind: 'search',
      rawInput: args.query,
    }),
  })
}

/** One display line: score, path with optional line, kind, and detail. */
function renderLine(result: { path: string; score: number; kind: string; line?: number; symbol?: string; snippet?: string }): string {
  const location = result.line === undefined ? result.path : `${result.path}:${result.line}`
  if (result.kind === 'symbol') return `${result.score.toFixed(2)}  ${location}  symbol  ${result.symbol ?? ''}`
  if (result.kind === 'text') return `${result.score.toFixed(2)}  ${location}  text  ${result.snippet ?? ''}`
  return `${result.score.toFixed(2)}  ${location}  path`
}
