/**
 * Register a second {@link DeepSeekAdapter} instance for the `deep-pmu`
 * provider route on `ctx.llm`, reusing the official adapter and resolution
 * logic so the PMU key and the official key stay two independent routes side
 * by side in the Models page. The PMU key resolves per request from the
 * `DEEPSEEK_PMU_API_KEY` environment variable (or the credential seam), so
 * this plugin never inlines a secret and never touches `llm-deepseek`.
 * @module @deepseek-ai/dsh-llm-deepseek-pmu
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  DEFAULT_CONTEXT_WINDOW,
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'

export { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'

export const name = 'llm-deepseek-pmu'
export const inject = ['llm']

const NS = 'llm-deepseek-pmu'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_PMU_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'deep-pmu'

/** Advisory model catalog for the PMU route, with the real API model ids. */
const PMU_MODELS: DeepSeekCatalogModel[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-Flash (PMU)', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro (PMU)', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

/** Plugin config; the API key env name defaults to `DEEPSEEK_PMU_API_KEY`. */
export interface Config {
  apiKeyEnv?: string
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
})

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: DeepSeekConnectionOptions | undefined
  const options = (): DeepSeekConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const apiKeyEnv = raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV
      const next = resolveAdapterOptions(
        { apiKeyEnv, models: PMU_MODELS },
        launchEnvironmentOf(ctx),
      )
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-deepseek-pmu: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: DeepSeekConnectionOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek-pmu', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-deepseek-pmu', ref)
      }
    }
    throw new LlmError(
      `llm-deepseek-pmu: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const adapter = new DeepSeekAdapter({
    options,
    resolveApiKey,
    resolveUserId,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    prepareExtensions: (request) => {
      const extensions = ctx.get('deepseekLlmApiExtensions')
      return extensions?.prepare(request)
        ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() })
    },
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek PMU', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {},
    })
  })
}
