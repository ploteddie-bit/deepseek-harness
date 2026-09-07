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
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-renderer Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PreSendScanButton } from './PreSendScanButton.tsx'
import { en, zh, type PresendScanKey } from './locales.ts'

export type { PresendScanKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer pre-send scan badge's copy. */
    presendscan: PresendScanKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'presendscan'

/** Required services: the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-pre-send-scan: dictionaries')

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({
      name: 'conversation.input.right',
      id: 'pre-send-scan',
      order: 100,
      locale: NS,
    }, PreSendScanButton))
}
