/**
 * Advisory per-agent edit-without-test detector. After an edit- or write-style
 * tool call it enriches the post-execute decision with a logged reminder when
 * the agent has not run a test command within a recent window of tool calls,
 * without vetoing or rewriting calls. Configuration and delivery semantics live
 * in the package README.
 * @module @deepseek-ai/dsh-edit-test-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'edit-test-guard'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty
 * `editTools` or `testCommands` list, or a non-integer `window` below 1, throws
 * at plugin load, never a silent fall-back). `editTools` entries are `*`-wildcard
 * predicates over tool names at call time; `testCommands` entries are plain
 * substrings matched against a tool call's serialized arguments.
 */
export interface Config {
  /** Tool-name patterns to treat as edits; `*` wildcard supported (default `["edit", "write"]`). */
  editTools?: string[]
  /** Command fragments that count as a test having run (default list). */
  testCommands?: string[]
  /** Number of prior tool calls inspected for a recent test (default 25, integer >= 1). */
  window?: number
  /** Static reminder text (default provided). */
  reminder?: string
  /** Reminder generator receiving the edit tool name; overrides `reminder` when set. */
  reminderText?: (tool: string) => string
}

export const Config: z<Config> = z.object({
  editTools: z.array(z.string()).default(['edit', 'write']),
  testCommands: z.array(z.string()).default([
    'test', 'pytest', 'vitest', 'jest', 'cargo test', 'go test',
    'make check', 'pnpm test', 'npm test', 'tsc', 'tox',
  ]),
  window: z.number().default(25),
  reminder: z.string().default(
    'You edited a file but no test command has run in the recent tool-call history. '
    + 'Run the relevant tests now to verify the change before continuing.',
  ),
  reminderText: z.function(),
})

/**
 * The `{kind:'plugin'}` source stamped on every reminder this guard injects —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'edit-test-guard' }

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Serialize a tool call's arguments into the content scanned for test fragments. */
function serialize(exec: ToolExecution): string {
  return exec.arguments === undefined ? '' : JSON.stringify(exec.arguments)
}

/** Prepend the guard's reminder while preserving every downstream context's source and metadata. */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; `editTools`, `testCommands`, and `window` are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the list/string/number fields are set after validation.
  const editPatterns = (config.editTools as string[]).map(wildcardToRegExp)
  const testFragments = config.testCommands as string[]
  const windowSize = config.window as number
  const reminder = config.reminder as string
  const reminderText = config.reminderText

  if (editPatterns.length === 0) {
    throw new Error('edit-test-guard: `editTools` must not be empty')
  }
  if (testFragments.length === 0) {
    throw new Error('edit-test-guard: `testCommands` must not be empty')
  }
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error(`edit-test-guard: invalid window ${windowSize} — must be an integer >= 1`)
  }

  const histories = new WeakMap<Agent, string[]>()

  function isEdit(toolName: string): boolean {
    return editPatterns.some(pattern => pattern.test(toolName))
  }

  function hasRecentTest(history: string[]): boolean {
    return history.some(content => testFragments.some(fragment => content.includes(fragment)))
  }

  function makeReminder(tool: string): UserMessage {
    const text = reminderText !== undefined ? reminderText(tool) : reminder
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${tool} without tests` },
    })
  }

  /**
   * Record the calling agent's latest call and return the reminder to deliver
   * when it is an edit and the prior window holds no test command. History is
   * keyed per agent and bounded to `window` entries; only agent-loop calls
   * participate.
   */
  function observe(exec: ToolExecution): UserMessage | undefined {
    // A direct `ctx.tools.execute()` caller has no model to remind and no id
    // to key on; only agent-loop calls participate.
    if (!exec.agent) return undefined
    const agent = exec.agent
    const prior = histories.get(agent) ?? []
    const reminderMessage = isEdit(exec.name) && !hasRecentTest(prior)
      ? makeReminder(exec.name)
      : undefined
    const next = [...prior, serialize(exec)]
    histories.set(agent, next.length > windowSize ? next.slice(next.length - windowSize) : next)
    return reminderMessage
  }

  // Observe-and-enrich, never veto: record first (state advances regardless of
  // the downstream outcome), DELEGATE so a later listener can still block or
  // replace, then fold the reminder onto whatever came back — additionalContexts
  // rides both decision variants, so a blocked call still gets the nudge.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const reminderMessage = observe(exec)
    const downstream = await next()
    if (!reminderMessage) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(reminderMessage, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(reminderMessage, downstream.additionalContexts),
    }
  })
}
