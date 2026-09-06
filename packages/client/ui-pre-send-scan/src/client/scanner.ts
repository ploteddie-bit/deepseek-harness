/**
 * Pre-send security scan: pure functions for detecting credentials, IPs,
 * secrets, and other sensitive material in user-authored text.
 *
 * Zero side effects, zero I/O, zero React. Browser-safe (no Node APIs).
 * Each rule returns one hit per match; `scan()` caps at 20 hits.
 *
 * Adding a rule: append to `RULES` with `{ id, severity, pattern }`. Keep
 * the pattern global (the `g` flag) and stable across calls — `scan()`
 * resets `lastIndex` defensively.
 */

export type Severity = 'critical' | 'warn' | 'info'

export interface ScanHit {
  readonly id: string
  readonly severity: Severity
  /** Up to ~80 chars of context around the match (for tooltip). */
  readonly snippet: string
}

interface Rule {
  readonly id: string
  readonly severity: Severity
  readonly pattern: RegExp
}

const RULES: readonly Rule[] = [
  // ── critical: API keys (longest prefix first to avoid sk- swallowing sk-ant-) ─
  { id: 'anthropic-key', severity: 'critical', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'aws-access-key', severity: 'critical', pattern: /AKIA[0-9A-Z]{16}/g },
  { id: 'openai-key', severity: 'critical', pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { id: 'github-token', severity: 'critical', pattern: /\bghp_[A-Za-z0-9]{30,}/g },
  { id: 'slack-token', severity: 'critical', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },

  // ── critical: private keys ───────────────────────────────────────────
  { id: 'ssh-private-key', severity: 'critical', pattern: /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/g },

  // ── warn: RFC1918 / loopback IPs ─────────────────────────────────────
  // 10.x.x.x and 127.x.x.x are 1-octet prefixes (need 3 more octets).
  // 192.168.x.x and 172.16-31.x.x are 2-octet prefixes (need 2 more).
  // Splitting into two rules avoids a backtracking mismatch in V8 between
  // literal-prefix length and the trailing `.octet` count.
  { id: 'ip-rfc1918-a', severity: 'warn', pattern: /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'ip-rfc1918-b', severity: 'warn', pattern: /\b(?:192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },

  // ── warn: cloud signed URLs ──────────────────────────────────────────
  { id: 's3-signed', severity: 'warn', pattern: /[?&]X-Amz-Signature=[A-Za-z0-9+/=]+/g },
  { id: 'gcs-signed', severity: 'warn', pattern: /[?&]GoogleAccessId=[^&]+/g },
  { id: 'azure-sas', severity: 'warn', pattern: /[?&]sv=\d{4}-\d{2}-\d{2}&sig=[A-Za-z0-9%+/=]+/g },

  // ── warn: passwords & bearer tokens (covers password/passwd/pwd, DB_PASS, _PASSWORD=) ──
  { id: 'password-keyword', severity: 'warn', pattern: /(?:password|passwd|pwd|PASS|PASSWORD)(?:_|\s*[:=]\s*)[^\s'"]{6,}/gi },
  { id: 'bearer-token', severity: 'warn', pattern: /Bearer\s+[A-Za-z0-9_\-.=]{20,}/g },

  // ── info: credential file paths ──────────────────────────────────────
  { id: 'cred-path', severity: 'info', pattern: /~\/\.(?:ssh|aws|azure|gcloud|kube)\/[\w./-]+/g },
]

const MAX_HITS = 20
const SNIPPET_MAX = 80
const SNIPPET_RADIUS = 12

/**
 * Scan a string for sensitive material.
 * @param text - The text to scan (typically the composer draft).
 * @returns Up to 20 hits; empty array if the input is empty or clean.
 */
export function scan(text: string): readonly ScanHit[] {
  if (!text) return []

  const hits: ScanHit[] = []
  const seen = new Set<string>()

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.pattern.exec(text)) !== null) {
      const key = `${rule.id}:${m.index}`
      if (seen.has(key)) continue
      seen.add(key)

      const start = Math.max(0, m.index - SNIPPET_RADIUS)
      const end = Math.min(text.length, m.index + m[0].length + SNIPPET_RADIUS)
      const raw = text.slice(start, end).replace(/\s+/g, ' ')
      hits.push({
        id: rule.id,
        severity: rule.severity,
        snippet: raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX - 3) + '...' : raw,
      })
      if (hits.length >= MAX_HITS) return hits
    }
  }
  return hits
}

/**
 * Return the worst severity present in a hit list (or null).
 * @param hits - A scan result.
 * @returns The highest severity, or null if empty.
 */
export function highestSeverity(hits: readonly ScanHit[]): Severity | null {
  if (hits.some(h => h.severity === 'critical')) return 'critical'
  if (hits.some(h => h.severity === 'warn')) return 'warn'
  if (hits.length > 0) return 'info'
  return null
}
