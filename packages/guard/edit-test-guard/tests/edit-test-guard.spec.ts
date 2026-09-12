import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as EditTestGuard from '@deepseek-ai/dsh-edit-test-guard'
import type { Config } from '@deepseek-ai/dsh-edit-test-guard'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const testToolSignal = new AbortController().signal

/**
 * Behavior suite for the edit-test guard: the reminder after an edit without a
 * recent test, suppression once a test command ran in the window, window
 * fall-off, wildcard edit-tool matching, per-agent isolation, custom reminder
 * text, fold-onto-downstream-decision (advisory, never blocking), and fail-loud
 * config validation — all driven through a real agent loop against a scripted
 * mock adapter (no network).
 */

/** Boot the core spine + the guard; the caller registers adapters and extra listeners. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(EditTestGuard, config)
  ctx.tools.register(defineContentToolFixture({ name: 'edit', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'w', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'run', description: 'r', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

/** Every injected-context user message in the agent's log, flattened to joined text + source for terse assertions. */
function reminders(agent: Agent): { text: string; source: unknown }[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind !== 'user')
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

// The reminder is a `notice`-form context; its summary names the edited tool
// so a reader sees it without expanding the row.
const guardSource = (tool: string) => ({
  kind: 'plugin',
  plugin: 'edit-test-guard',
  form: 'notice',
  summary: `${tool} without tests`,
})

describe('reminder after an edit without a recent test', () => {
  it('reminds after an edit with no recent test command', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { path: 'a.ts', content: 'x' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('Run the relevant tests')
    expect(found[0]!.source).toEqual(guardSource('edit'))
  })

  it('does not remind when a test command ran within the window', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'run', { command: 'npm test' }),
      toolCallResponse('c2', 'edit', { path: 'a.ts', content: 'x' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(0)
  })

  it('treats write as an edit and a non-test command as no test', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'run', { command: 'ls' }),
      toolCallResponse('c2', 'write', { path: 'b.ts', content: 'y' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.source).toEqual(guardSource('write'))
  })

  it('reminds again once the test command falls out of the window', async () => {
    const ctx = await harness({ window: 2 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'run', { command: 'npm test' }),
      toolCallResponse('c2', 'run', { command: 'ls' }),
      toolCallResponse('c3', 'run', { command: 'ls' }),
      toolCallResponse('c4', 'edit', { path: 'a.ts', content: 'x' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(1)
  })
})

describe('wildcard edit-tool matching', () => {
  it('matches edit tool patterns with a star wildcard', async () => {
    const ctx = await harness({ editTools: ['wr*'] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { path: 'a.ts', content: 'x' }), // not matched by 'wr*'
      toolCallResponse('c2', 'write', { path: 'b.ts', content: 'y' }), // matched
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.source).toEqual(guardSource('write'))
  })
})

describe('per-agent isolation', () => {
  it('one agent running tests never suppresses another agent\'s reminder', async () => {
    const ctx = await harness()
    ctx.llm.registerAdapter(['mock-a'], new MockAdapter([
      toolCallResponse('a1', 'run', { command: 'npm test' }),
      toolCallResponse('a2', 'edit', { path: 'a.ts', content: 'x' }),
      textResponse('done'),
    ]))
    ctx.llm.registerAdapter(['mock-b'], new MockAdapter([
      toolCallResponse('b1', 'edit', { path: 'b.ts', content: 'y' }),
      textResponse('done'),
    ]))
    const agentA = await ctx.agentLoop.create(SessionId('a'), { provider: 'mock-a', model: 'model-a' })
    const agentB = await ctx.agentLoop.create(SessionId('b'), { provider: 'mock-b', model: 'model-b' })
    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    agentB.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await Promise.all([waitForIdle(ctx, agentA), waitForIdle(ctx, agentB)])

    expect(reminders(agentA)).toHaveLength(0)
    expect(reminders(agentB)).toHaveLength(1)
  })
})

describe('reminder text', () => {
  it('honors a custom static reminder', async () => {
    const ctx = await harness({ reminder: 'custom nudge' })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { path: 'a.ts', content: 'x' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('custom nudge')
  })

  it('honors a reminderText generator receiving the tool name', async () => {
    const ctx = await harness({ reminderText: tool => `verify your ${tool}` })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { path: 'b.ts', content: 'y' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)[0]!.text).toContain('verify your write')
  })
})

describe('advisory fold onto the downstream decision', () => {
  it('folds the reminder onto a downstream block and keeps its feedback', async () => {
    const ctx = await harness()
    ctx.on('tools/post-execute', async () => ({
      kind: 'block' as const,
      feedback: [{ type: 'text' as const, text: 'nope' }],
      additionalContexts: [createUserMessage({
        content: [{ type: 'text' as const, text: 'downstream-ctx' }], source: { kind: 'plugin' as const, plugin: 'test' },
      })],
    }))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { path: 'a.ts', content: 'x' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(2)
    expect(found[0]!.text).toContain('Run the relevant tests')
    expect(found[0]!.source).toEqual(guardSource('edit'))
    expect(found[1]!.text).toBe('downstream-ctx')
    // The block's feedback reached the tool result unchanged.
    const results = agent.session.snapshotEvents().filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(results.every(r => r.data.message.content[0].isError)).toBe(true)
    expect(results[0]!.data.message.content[0].content).toEqual([{ type: 'text', text: 'nope' }])
  })

  it('never blocks: an edit still succeeds and the reminder rides as context', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { path: 'a.ts', content: 'x' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const results = agent.session.snapshotEvents().filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(results.every(r => !r.data.message.content[0].isError)).toBe(true)
  })
})

describe('config validation fails loud', () => {
  async function spine(): Promise<Context> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('rejects an empty editTools list', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(EditTestGuard, { editTools: [] })).rejects.toThrow(/editTools/)
  })

  it('rejects an empty testCommands list', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(EditTestGuard, { testCommands: [] })).rejects.toThrow(/testCommands/)
  })

  it('rejects a window below 1', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(EditTestGuard, { window: 0 })).rejects.toThrow(/window/)
  })

  it('rejects a fractional window', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(EditTestGuard, { window: 2.5 })).rejects.toThrow(/window/)
  })
})

describe('direct executes', () => {
  it('ignores direct executes with no agent', async () => {
    const ctx = await harness()
    const direct = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('d1'), name: 'edit', arguments: { path: 'a.ts', content: 'x' } })
    expect(direct.isError).toBe(false)

    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'edit', { path: 'a.ts', content: 'x' }),
      textResponse('done'),
    ]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(1)
  })
})
