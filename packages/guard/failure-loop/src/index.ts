/**
 * Advisory per-agent failure-loop detector. It enriches post-execute decisions
 * with logged model context when an agent repeats tool calls that fail — the
 * exact same failing call, a run of failing calls to one tool — or idempotent
 * (read-only) calls that succeed without changing their result. It never
 * vetoes or rewrites a call: blocking stays a downstream listener's job.
 * Configuration and chain semantics live in the package README.
 * @module @deepseek-ai/dsh-failure-loop
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export const name = 'failure-loop'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: a threshold or
 * `window` below 2, a non-integer, or a `window` smaller than any threshold
 * throws at plugin load, never a silent fall-back). `idempotentTools` and
 * `exclude` entries are `*`-wildcard predicates over tool names at call time,
 * not references to registry entries — a pattern matching no currently
 * registered tool is valid (`exclude: [mcp_*]` must stay legal in a deployment
 * that loads no MCP tools).
 */
export interface Config {
  /** Same tool + same arguments failing N times before a reminder (default 3). */
  exactFailureThreshold?: number
  /** Same tool failing N times (arguments may differ) before a reminder (default 5). */
  sameToolFailureThreshold?: number
  /** An idempotent tool returning the same result N times before a reminder (default 5). */
  idempotentNoProgressThreshold?: number
  /** Sliding window of per-agent tool calls inspected for each signal (default 30). */
  window?: number
  /** Tool-name wildcard patterns classified as idempotent (read-only). */
  idempotentTools?: string[]
  /** Tool-name patterns transparent to the detector (neither count nor reset). */
  exclude?: string[]
}

export const Config: z<Config> = z.object({
  exactFailureThreshold: z.number().default(3),
  sameToolFailureThreshold: z.number().default(5),
  idempotentNoProgressThreshold: z.number().default(5),
  window: z.number().default(30),
  idempotentTools: z.array(z.string()).default(['read', 'glob', 'grep', 'list_*']),
  exclude: z.array(z.string()).default([]),
})

/**
 * The `{kind:'plugin'}` source stamped on every reminder this guard injects —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'failure-loop' }

/** The failure taxonomy this detector classifies, modeled on Hermes Agents' guardrails. */
type FailureSignal = 'exact-failure' | 'same-tool-failure' | 'idempotent-no-progress'

/** One observation of a tool call outcome inside an agent's sliding window. */
interface Observation {
  /** Tool name. */
  readonly name: string
  /** Canonical `(name, arguments)` identity for exact-failure and no-progress matching. */
  readonly key: string
  /** Whether the call settled as an error. */
  readonly failed: boolean
  /** Canonical model-visible content identity, set only for successful idempotent calls. */
  readonly resultKey: string | undefined
}

/** One agent's bounded observation history (the sliding window). */
interface AgentState {
  history: Observation[]
}

/** The three reminder bodies, keyed by the signal that fired. */
const REMINDERS: Record<FailureSignal, (tool: string, count: number) => string> = {
  'exact-failure': (tool, count) =>
    `${tool} failed ${count} times with identical arguments. This looks like a failure loop. `
    + 'Inspect the latest error and change strategy — different arguments, a different tool, '
    + 'or report the blocker — instead of retrying the same call unchanged.',
  'same-tool-failure': (tool, count) =>
    `${tool} failed ${count} times in a row. This looks like a failure loop. `
    + 'Diagnose the latest error before retrying: try different arguments, a narrower query or '
    + 'path, or a different tool. If the blocker is external, report it after one diagnostic attempt.',
  'idempotent-no-progress': (tool, count) =>
    `${tool} returned the same result ${count} times. Use the result already provided `
    + 'or change the query instead of repeating it unchanged.',
}

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach the guard
 * as the loop's `JSON.parse` output, and result content as the registry's
 * lossless-JSON materialization, so JSON's value domain is the whole input
 * domain — no bigint, cycle, or `undefined` handling exists because no input
 * path can produce them.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Canonical string form of a value: deep key-sort, then stringify. */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Validate one reminder threshold against the fail-loud contract. */
function validateThreshold(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error(`failure-loop: invalid ${field} ${value} — must be an integer >= 2`)
  }
  return value
}

/** Validate the window against the fail-loud contract, including reachability of every threshold. */
function validateWindow(value: number, maxThreshold: number): number {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error(`failure-loop: invalid window ${value} — must be an integer >= 2`)
  }
  if (value < maxThreshold) {
    throw new Error(`failure-loop: window ${value} is smaller than a threshold (${maxThreshold}) — every threshold must be reachable within the window`)
  }
  return value
}

/** Prepend the guard's reminder while preserving every downstream context's source and metadata. */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/** Count the trailing consecutive observations matching `pred`, ending at the newest entry. */
function trailingCount(history: readonly Observation[], pred: (observation: Observation) => boolean): number {
  let count = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const observation = history[index]
    if (observation === undefined || !pred(observation)) break
    count += 1
  }
  return count
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; thresholds and window are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const exactFailureThreshold = validateThreshold(config.exactFailureThreshold as number, 'exactFailureThreshold')
  const sameToolFailureThreshold = validateThreshold(config.sameToolFailureThreshold as number, 'sameToolFailureThreshold')
  const idempotentNoProgressThreshold = validateThreshold(config.idempotentNoProgressThreshold as number, 'idempotentNoProgressThreshold')
  const window = validateWindow(
    config.window as number,
    Math.max(exactFailureThreshold, sameToolFailureThreshold, idempotentNoProgressThreshold),
  )
  const idempotentPatterns = (config.idempotentTools as string[]).map(wildcardToRegExp)
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)

  const states = new WeakMap<Agent, AgentState>()

  /** Whether a tool participates in the detector (excluded tools are transparent). */
  function tracked(toolName: string): boolean {
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /** Whether a tool name is classified idempotent (read-only). */
  function idempotent(toolName: string): boolean {
    return idempotentPatterns.some(pattern => pattern.test(toolName))
  }

  /**
   * Advance the calling agent's window with this outcome and return the
   * reminder to deliver, if this call's trailing streak reaches a threshold.
   * Counting happens here — in post-execute — because denied calls also flow
   * through this waterfall, and a model hammering a denied call is exactly the
   * loop worth breaking. A success breaks a failure streak; a changed result
   * breaks a no-progress streak — both fall out of the trailing-count scan
   * naturally.
   */
  function observe(exec: ToolExecution, result: Readonly<ToolExecutionResult>): UserMessage | undefined {
    // A direct `ctx.tools.execute()` caller has no model to remind and no id
    // to key on; only agent-loop calls participate.
    if (!exec.agent) return undefined
    if (!tracked(exec.name)) return undefined
    const failed = result.isError === true
    const observation: Observation = {
      name: exec.name,
      key: JSON.stringify([exec.name, canonicalize(exec.arguments)]),
      failed,
      resultKey: failed ? undefined : canonicalize(result.content),
    }
    let state = states.get(exec.agent)
    if (state === undefined) {
      state = { history: [] }
      states.set(exec.agent, state)
    }
    state.history.push(observation)
    const history = state.history
    if (history.length > window) history.splice(0, history.length - window)

    let signal: FailureSignal | undefined
    let count = 0
    if (failed) {
      const exact = trailingCount(history, o => o.failed && o.key === observation.key)
      if (exact >= exactFailureThreshold) {
        signal = 'exact-failure'
        count = exact
      } else {
        const sameTool = trailingCount(history, o => o.failed && o.name === observation.name)
        if (sameTool >= sameToolFailureThreshold) {
          signal = 'same-tool-failure'
          count = sameTool
        }
      }
    } else if (idempotent(observation.name)) {
      const noProgress = trailingCount(history, o =>
        !o.failed && o.name === observation.name && o.key === observation.key && o.resultKey === observation.resultKey)
      if (noProgress >= idempotentNoProgressThreshold) {
        signal = 'idempotent-no-progress'
        count = noProgress
      }
    }
    if (signal === undefined) return undefined
    return createUserMessage({
      content: [{ type: 'text', text: REMINDERS[signal](observation.name, count) }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${signal}: ${observation.name} × ${count}` },
    })
  }

  // Observe-and-enrich, never veto: count first (state advances regardless of
  // the downstream outcome), DELEGATE so a later listener can still block or
  // replace, then fold the reminder onto whatever came back — additionalContexts
  // rides both decision variants, so a blocked call still gets the nudge.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const reminder = observe(exec, result)
    const downstream = await next()
    if (!reminder) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(reminder, downstream.additionalContexts),
    }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: always delegates (attaching nothing, vetoing
  // nothing).
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) states.delete(agent)
    return next()
  })
}
