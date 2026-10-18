import { describe, expect, it } from 'vitest'
import { matcherDiagnostic, matchesMatcher, selectHookGroups, type MatcherGroup } from '@deepseek-ai/dsh-hook-protocol'

describe('matchesMatcher — match-all sentinels (both dialects)', () => {
  for (const mode of ['legacy-hooks', 'externalCli'] as const) {
    it(`${mode}: absent / empty / '*' match everything`, () => {
      expect(matchesMatcher(undefined, 'Bash', mode)).toBe(true)
      expect(matchesMatcher('', 'anything', mode)).toBe(true)
      expect(matchesMatcher('*', 'whatever', mode)).toBe(true)
    })
  }
})

describe('matchesMatcher — legacy dialect (literal-or-regex)', () => {
  it('a pure word-char pattern is a LITERAL exact match (not substring)', () => {
    expect(matchesMatcher('Bash', 'Bash', 'legacy-hooks')).toBe(true)
    // literal exact: "Bash" must NOT match "BashOutput" (a regex would, substring)
    expect(matchesMatcher('Bash', 'BashOutput', 'legacy-hooks')).toBe(false)
  })

  it('a pipe pattern is literal ALTERNATION (exact match any alternative)', () => {
    expect(matchesMatcher('Edit|Write', 'Edit', 'legacy-hooks')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Write', 'legacy-hooks')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Read', 'legacy-hooks')).toBe(false)
    // still exact per-alternative, not substring
    expect(matchesMatcher('Edit|Write', 'EditFile', 'legacy-hooks')).toBe(false)
  })

  it('a non-word pattern falls through to regex (unanchored)', () => {
    expect(matchesMatcher('^Bash$', 'Bash', 'legacy-hooks')).toBe(true)
    expect(matchesMatcher('Bash.*', 'BashOutput', 'legacy-hooks')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.ts', 'legacy-hooks')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.js', 'legacy-hooks')).toBe(false)
  })
})

describe('matchesMatcher — externalCli dialect (always regex)', () => {
  it('a word pattern is an unanchored regex (substring matches, unlike legacy literal)', () => {
    expect(matchesMatcher('Bash', 'Bash', 'externalCli')).toBe(true)
    // externalCli has NO literal fast path: "Bash" is /Bash/, so it DOES match a substring
    expect(matchesMatcher('Bash', 'BashOutput', 'externalCli')).toBe(true)
  })

  it('regex alternation and anchors work', () => {
    expect(matchesMatcher('Edit|Write', 'Edit', 'externalCli')).toBe(true)
    expect(matchesMatcher('^Bash$', 'Bash', 'externalCli')).toBe(true)
    expect(matchesMatcher('^Bash$', 'BashOutput', 'externalCli')).toBe(false)
  })
})

describe('matchesMatcher — invalid regex is a non-match (never throws)', () => {
  it('an unbalanced pattern matches nothing rather than throwing', () => {
    // '(' is not the legacy-literal charset, so it goes to the regex path and is invalid.
    expect(() => matchesMatcher('(', 'x', 'legacy-hooks')).not.toThrow()
    expect(matchesMatcher('(', 'x', 'legacy-hooks')).toBe(false)
    expect(matchesMatcher('[', 'x', 'externalCli')).toBe(false)
  })
})

describe('matcherDiagnostic — parse-time diagnostics', () => {
  it('accepts match-all sentinels, Legacy literals, and valid regexes', () => {
    expect(matcherDiagnostic(undefined, 'legacy-hooks')).toBeUndefined()
    expect(matcherDiagnostic('', 'externalCli')).toBeUndefined()
    expect(matcherDiagnostic('*', 'externalCli')).toBeUndefined()
    expect(matcherDiagnostic('Edit|Write', 'legacy-hooks')).toBeUndefined()
    expect(matcherDiagnostic('^Bash$', 'legacy-hooks')).toBeUndefined()
    expect(matcherDiagnostic('Edit|Write', 'externalCli')).toBeUndefined()
  })

  it('returns a stable diagnostic for invalid regexes in either dialect', () => {
    expect(matcherDiagnostic('(', 'legacy-hooks')).toBe('invalid legacy-hooks regex matcher "("')
    expect(matcherDiagnostic('[', 'externalCli')).toBe('invalid externalCli regex matcher "["')
  })
})

describe('selectHookGroups', () => {
  it.each(['legacy-hooks', 'externalCli'] as const)('%s: absent and empty hook points select no commands', (mode) => {
    expect(selectHookGroups(undefined, 'Bash', mode)).toEqual([])
    expect(selectHookGroups([], 'Bash', mode)).toEqual([])
  })

  it.each(['legacy-hooks', 'externalCli'] as const)('%s: selects nonempty matching groups in config order', (mode) => {
    const first: MatcherGroup = { matcher: '*', hooks: [{ command: 'first' }] }
    const second: MatcherGroup = { matcher: '^Bash$', hooks: [{ command: 'second' }, { command: 'third' }] }
    const groups: MatcherGroup[] = [
      { matcher: '*', hooks: [] },
      first,
      { matcher: 'Read', hooks: [{ command: 'unmatched' }] },
      second,
    ]
    const selected = selectHookGroups(groups, 'Bash', mode)
    expect(selected).toEqual([first, second])
    expect(selected[0]).toBe(first)
    expect(selected[1]).toBe(second)
    expect(groups).toHaveLength(4)
  })

  it('keeps Legacy literal matching distinct from ExternalCli regex matching', () => {
    const group: MatcherGroup = { matcher: 'Bash', hooks: [{ command: 'matched' }] }
    expect(selectHookGroups([group], 'BashOutput', 'legacy-hooks')).toEqual([])
    expect(selectHookGroups([group], 'BashOutput', 'externalCli')).toEqual([group])
  })
})
