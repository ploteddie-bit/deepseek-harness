/**
 * Browser-side apply for the pre-send scan plugin. Registers a single
 * `conversation.input.right` entry (the composer tool row, just before the
 * submit action). The button reads the composer draft through the framework
 * `useInput` standard hook and scans it locally.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (the
// `conversation.input.right` seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-renderer Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PreSendScanButton } from './PreSendScanButton.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({
      name: 'conversation.input.right',
      id: 'pre-send-scan',
      order: 100,
    }, PreSendScanButton))
}
