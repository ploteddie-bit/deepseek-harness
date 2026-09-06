/**
 * PreSendScanButton — renders in `conversation.input.right`. Reads the
 * composer draft through the framework `useInput` standard hook, scans it
 * locally, and shows a coloured badge with the worst hit severity + count.
 * Clicking toggles the ON/OFF state (persisted in localStorage). The send
 * action is never intercepted — the button is an indicator, not a blocker.
 */
import { useCallback, useMemo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the
// `conversation.input.right` seat and its `useInput` standard hook).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { scan, highestSeverity, type Severity } from './scanner.ts'

const STORAGE_KEY = 'dsh.pre-send-scan.enabled'

const COLOR: Record<Severity, string> = {
  critical: '#dc2626', // red-600
  warn: '#d97706',     // amber-600
  info: '#2563eb',     // blue-600
}

const INACTIVE = '#94a3b8' // slate-400

function readEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  const v = localStorage.getItem(STORAGE_KEY)
  return v === null ? true : v === '1'
}

function writeEnabled(v: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
}

export function PreSendScanButton({ useInput }: PropsRuntime<'conversation.input.right'>) {
  const draft = useInput(s => s.draft)
  const [enabled, setEnabled] = useState<boolean>(() => readEnabled())

  const hits = useMemo(
    () => (enabled ? scan(draft) : []),
    [draft, enabled],
  )
  const sev = highestSeverity(hits)
  const bg = sev ? COLOR[sev] : INACTIVE

  const onClick = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      writeEnabled(next)
      return next
    })
  }, [])

  const label = enabled
    ? (hits.length > 0 ? `${hits.length}` : 'OK')
    : 'OFF'

  const title = enabled
    ? `Pre-send scan: ${hits.length} hit(s)` + (sev ? `, worst: ${sev}` : '')
    : 'Pre-send scan disabled (click to enable)'

  return (
    <button
      type="button"
      aria-label="Security scan"
      aria-pressed={enabled}
      title={title}
      onClick={onClick}
      data-severity={sev ?? 'off'}
      data-hits={hits.length}
      style={{
        background: bg,
        opacity: enabled ? 1 : 0.55,
        color: '#fff',
        border: 'none',
        borderRadius: 18,
        padding: '0 14px',
        height: 36,
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'inherit',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true">🛡</span>
      <span>{label}</span>
    </button>
  )
}
