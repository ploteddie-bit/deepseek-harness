/**
 * Unit tests for the pure scanner. No DOM, no React, no cordis — just the
 * regex rules.
 */

import { describe, expect, it } from 'vitest'
import { scan, highestSeverity, type ScanHit } from '../src/client/scanner.ts'

describe('scan', () => {
  it('returns empty for empty input', () => {
    expect(scan('')).toEqual([])
  })

  it('returns empty for clean text', () => {
    expect(scan('Bonjour, peux-tu m\'aider à configurer nginx ?')).toEqual([])
    expect(scan('Run the test suite and report failures')).toEqual([])
    expect(scan('Sk-or-bb is too short to match')).toEqual([])
  })

  it('detects AWS access key (critical)', () => {
    const hits = scan('My key is AKIAIOSFODNN7EXAMPLE ok?')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe('aws-access-key')
    expect(hits[0]!.severity).toBe('critical')
  })

  it('detects OpenAI sk- key (critical)', () => {
    const hits = scan('sk-proj-abcdefghijklmnopqrstuvwxyz')
    expect(hits[0]!.id).toBe('openai-key')
    expect(hits[0]!.severity).toBe('critical')
  })

  it('detects GitHub ghp_ token (critical)', () => {
    const hits = scan('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789')
    expect(hits[0]!.id).toBe('github-token')
  })

  it('detects Anthropic sk-ant- key (critical)', () => {
    const hits = scan('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890')
    expect(hits[0]!.id).toBe('anthropic-key')
  })

  it('detects SSH private key header (critical)', () => {
    const hits = scan('-----BEGIN OPENSSH PRIVATE KEY-----')
    expect(hits[0]!.id).toBe('ssh-private-key')
    expect(hits[0]!.severity).toBe('critical')
  })

  it('detects RFC1918 IPv4 (warn)', () => {
    const h1 = scan('connect to 10.0.0.223 first')
    expect(h1[0]!.id).toMatch(/^ip-rfc1918/)
    expect(h1[0]!.severity).toBe('warn')
    const h2 = scan('192.168.1.42 is the gateway')
    expect(h2[0]!.id).toMatch(/^ip-rfc1918/)
    expect(h2[0]!.severity).toBe('warn')
    const h3 = scan('172.20.10.5 is the docker bridge')
    expect(h3[0]!.id).toMatch(/^ip-rfc1918/)
    expect(h3[0]!.severity).toBe('warn')
  })

  it('detects S3 signed URL (warn)', () => {
    const hits = scan('https://x.s3.amazonaws.com/foo?X-Amz-Signature=abcDEF1234567890xyz=')
    expect(hits[0]!.id).toBe('s3-signed')
  })

  it('detects password= in URL or text (warn)', () => {
    expect(scan('password=hunter2please')[0]!.id).toBe('password-keyword')
    expect(scan('DB_PASS=verysecretvalue')[0]!.id).toBe('password-keyword')
  })

  it('detects Bearer token (warn)', () => {
    expect(scan('Authorization: Bearer abc123def456ghi789jkl012mno')[0]!.id).toBe('bearer-token')
  })

  it('detects credential path (info)', () => {
    expect(scan('see ~/.ssh/id_rsa for the key')[0]!.id).toBe('cred-path')
    expect(scan('check ~/.aws/credentials')[0]!.id).toBe('cred-path')
  })

  it('caps results at 20 hits', () => {
    const text = Array(50).fill('AKIAIOSFODNN7EXAMPLE ').join('')
    expect(scan(text).length).toBeLessThanOrEqual(20)
  })

  it('preserves snippet context (~80 chars around match)', () => {
    const hits = scan('before AKIAIOSFODNN7EXAMPLE after with extra context to test truncation behavior here')
    expect(hits[0]!.snippet).toContain('AKIAIOSFODNN7EXAMPLE')
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(80)
  })
})

describe('highestSeverity', () => {
  it('returns null when empty', () => {
    expect(highestSeverity([])).toBeNull()
  })

  it('returns critical when any critical present', () => {
    const hits: ScanHit[] = [
      { id: 'a', severity: 'warn', snippet: '' },
      { id: 'b', severity: 'critical', snippet: '' },
    ]
    expect(highestSeverity(hits)).toBe('critical')
  })

  it('returns warn when warn present and no critical', () => {
    const hits: ScanHit[] = [
      { id: 'a', severity: 'info', snippet: '' },
      { id: 'b', severity: 'warn', snippet: '' },
    ]
    expect(highestSeverity(hits)).toBe('warn')
  })

  it('returns info when only info present', () => {
    const hits: ScanHit[] = [{ id: 'a', severity: 'info', snippet: '' }]
    expect(highestSeverity(hits)).toBe('info')
  })
})
