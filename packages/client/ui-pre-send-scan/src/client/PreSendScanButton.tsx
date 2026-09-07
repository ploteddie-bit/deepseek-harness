/**
 * PreSendScanButton — renders in `conversation.input.right`. Reads the
 * composer draft through the framework `useInput` standard hook, scans it
 * locally, and shows a coloured badge with the worst hit severity + count.
 * Clicking toggles the ON/OFF state (persisted in localStorage). The send
 * action is never intercepted — the button is an indicator, not a blocker.
 */
import { useCallback, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the
// `conversation.input.right` seat and its `useInput` standard hook).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { scan, highestSeverity } from './scanner.ts'
import css from './PreSendScanButton.module.css'

const STORAGE_KEY = 'dsh.pre-send-scan.enabled'

function readEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  const v = localStorage.getItem(STORAGE_KEY)
  return v === null ? true : v === '1'
}

function writeEnabled(v: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
}

export function PreSendScanButton({
  useInput,
  t,
}: PropsRuntime<'conversation.input.right'> & PropsLocale<'presendscan'>) {
  const draft = useInput(s => s.draft)
  const [enabled, setEnabled] = useState<boolean>(() => readEnabled())

  const hits = useMemo(
    () => (enabled ? scan(draft) : []),
    [draft, enabled],
  )
  const sev = highestSeverity(hits)

  const onClick = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      writeEnabled(next)
      return next
    })
  }, [])

  const label: string | number = enabled
    ? (hits.length > 0 ? hits.length : t('badge.label.ok'))
    : t('badge.label.off')

  const title = enabled
    ? (sev
      ? t('badge.title.on.severity', { hits: hits.length, severity: sev })
      : t('badge.title.on', { hits: hits.length }))
    : t('badge.title.off')

  return (
    <button
      type="button"
      className={css.badge}
      aria-label={t('badge.aria')}
      aria-pressed={enabled}
      title={title}
      onClick={onClick}
      data-severity={sev ?? 'off'}
      data-hits={hits.length}
    >
      <span aria-hidden="true">🛡</span>
      <span>{label}</span>
    </button>
  )
}
