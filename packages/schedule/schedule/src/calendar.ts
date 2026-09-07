/**
 * Pure calendar-rule parsing and UTC occurrence arithmetic.
 *
 * This module is deliberately self-contained and dependency-free: the public
 * Schedule parser accepts a five-field Cron expression or a simple calendar
 * phrase and normalizes it to a {@link CronRule}, then derives deterministic
 * next and previous occurrences without consulting a process time zone.
 * @module @deepseek-ai/dsh-schedule
 */

import type { CronRule } from './types.ts'

/** Error from a calendar rule that cannot become a Schedule record. */
export class CalendarRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalendarRuleError'
  }
}

/** Earliest representable four-digit-year instant. */
const MIN_FOUR_DIGIT_YEAR_MS = Date.parse('0001-01-01T00:00:00.000Z')
/** Latest representable four-digit-year instant. */
const MAX_FOUR_DIGIT_YEAR_MS = Date.parse('9999-12-31T23:59:59.999Z')

interface FieldRange {
  readonly min: number
  readonly max: number
}

const MINUTE_RANGE: FieldRange = { min: 0, max: 59 }
const HOUR_RANGE: FieldRange = { min: 0, max: 23 }
const DOM_RANGE: FieldRange = { min: 1, max: 31 }
const MONTH_RANGE: FieldRange = { min: 1, max: 12 }
const DOW_RANGE: FieldRange = { min: 0, max: 7 }

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const DOW_NAMES: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

const DAY_TO_DOW: Readonly<Record<string, readonly number[]>> = {
  day: [],
  weekday: [1, 2, 3, 4, 5],
  weekend: [0, 6],
  sunday: [0],
  monday: [1],
  tuesday: [2],
  wednesday: [3],
  thursday: [4],
  friday: [5],
  saturday: [6],
}

/** Parse one numeric or named field token into its canonical integer value. */
function parseValue(token: string, range: FieldRange, aliases?: Readonly<Record<string, number>>): number {
  if (aliases !== undefined && /^[a-z]+$/i.test(token)) {
    const value = aliases[token.toLowerCase()]
    if (value === undefined) throw new CalendarRuleError(`Unknown cron name "${token}".`)
    return value
  }
  if (!/^\d+$/.test(token)) throw new CalendarRuleError(`Invalid cron value "${token}".`)
  const value = Number(token)
  if (value < range.min || value > range.max) {
    throw new CalendarRuleError(`Cron value ${value} is outside ${range.min}-${range.max}.`)
  }
  return value
}

/** Normalize a parsed day-of-week value so that 7 (Sunday) becomes 0. */
function normalizeValue(value: number, range: FieldRange): number {
  return range === DOW_RANGE && value === 7 ? 0 : value
}

/** Parse one five-field Cron token into a sorted, deduplicated allowed set (empty means every). */
function parseField(raw: string, range: FieldRange, aliases?: Readonly<Record<string, number>>): number[] {
  const field = raw.trim()
  if (field === '') throw new CalendarRuleError('Cron fields must not be empty.')
  if (field === '*') return []
  const values = new Set<number>()
  for (const item of field.split(',')) {
    const token = item.trim()
    if (token === '') throw new CalendarRuleError('Cron list items must not be empty.')
    if (token === '*') throw new CalendarRuleError('Cron "*" must be the whole field, not a list item.')
    const stepMatch = /^(?<base>\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\/(?<step>\d+)$/.exec(token)
    if (stepMatch !== null) {
      const step = Number(stepMatch.groups?.['step'])
      if (step < 1) throw new CalendarRuleError('Cron step must be a positive integer.')
      const base = stepMatch.groups?.['base']
      let start: number
      let end: number
      if (base === '*') {
        start = range.min
        end = range.max
      } else {
        const rangeMatch = /^(?<a>[A-Za-z0-9]+)-(?<b>[A-Za-z0-9]+)$/.exec(base ?? '')
        if (rangeMatch === null) throw new CalendarRuleError('Cron step base must be "*" or a range.')
        start = parseValue(rangeMatch.groups?.['a'] ?? '', range, aliases)
        end = parseValue(rangeMatch.groups?.['b'] ?? '', range, aliases)
      }
      if (start > end) throw new CalendarRuleError('Cron range start must not exceed its end.')
      for (let value = start; value <= end; value += step) values.add(normalizeValue(value, range))
      continue
    }
    const rangeMatch = /^(?<a>[A-Za-z0-9]+)-(?<b>[A-Za-z0-9]+)$/.exec(token)
    if (rangeMatch !== null) {
      const start = parseValue(rangeMatch.groups?.['a'] ?? '', range, aliases)
      const end = parseValue(rangeMatch.groups?.['b'] ?? '', range, aliases)
      if (start > end) throw new CalendarRuleError('Cron range start must not exceed its end.')
      for (let value = start; value <= end; value += 1) values.add(normalizeValue(value, range))
      continue
    }
    values.add(normalizeValue(parseValue(token, range, aliases), range))
  }
  return [...values].sort((left, right) => left - right)
}

/**
 * Parse a strict five-field Cron expression into a normalized rule.
 * @param expression - `minute hour day-of-month month day-of-week`.
 * @returns A frozen normalized rule.
 */
export function parseCron5Field(expression: string): CronRule {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CalendarRuleError('cron must contain exactly five fields: minute hour day-of-month month day-of-week.')
  }
  const minute = parts[0]
  const hour = parts[1]
  const dayOfMonth = parts[2]
  const month = parts[3]
  const dayOfWeek = parts[4]
  return Object.freeze({
    minutes: parseField(minute ?? '', MINUTE_RANGE),
    hours: parseField(hour ?? '', HOUR_RANGE),
    daysOfMonth: parseField(dayOfMonth ?? '', DOM_RANGE),
    months: parseField(month ?? '', MONTH_RANGE, MONTH_NAMES),
    daysOfWeek: parseField(dayOfWeek ?? '', DOW_RANGE, DOW_NAMES),
  })
}

const PHRASE = new RegExp(
  String.raw`^every\s+(?<day>day|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\s+`
  + String.raw`(?:at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>am|pm)?$`,
  'i',
)

/**
 * Parse a simple calendar phrase into a normalized rule.
 * @param phrase - `every <day|weekday|weekend|weekday-name> at <time>`.
 * @returns A frozen normalized rule interpreted in UTC.
 */
export function parseCalendarPhrase(phrase: string): CronRule {
  const match = PHRASE.exec(phrase.trim())
  if (match === null) {
    throw new CalendarRuleError(
      'cron phrase must match "every <day|weekday|weekend|<weekday-name>> at <time>".',
    )
  }
  const day = match.groups?.['day']?.toLowerCase()
  const hourText = match.groups?.['hour']
  const minuteText = match.groups?.['minute']
  const ampm = match.groups?.['ampm']?.toLowerCase()
  const daysOfWeek = day === undefined ? undefined : DAY_TO_DOW[day]
  /* v8 ignore next -- the regex alternation only admits names present in DAY_TO_DOW. */
  if (daysOfWeek === undefined) throw new CalendarRuleError(`Unknown calendar day "${day}".`)
  let hour = Number(hourText)
  const minute = minuteText === undefined ? 0 : Number(minuteText)
  if (ampm !== undefined) {
    if (hour < 1 || hour > 12) throw new CalendarRuleError('12-hour time must be between 1 and 12.')
    hour = ampm === 'pm' ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour)
  } else if (hour > 23) {
    throw new CalendarRuleError('Hour must be between 0 and 23 without am/pm.')
  }
  if (minute > 59) throw new CalendarRuleError('Minute must be between 0 and 59.')
  return Object.freeze({
    minutes: [minute],
    hours: [hour],
    daysOfMonth: [],
    months: [],
    daysOfWeek: [...daysOfWeek],
  })
}

/**
 * Parse a calendar selector as either a Cron expression or a calendar phrase.
 * @param input - A `cron` selector string.
 * @returns A frozen normalized rule.
 */
export function parseCronRule(input: string): CronRule {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new CalendarRuleError('cron must be a non-empty Cron expression or calendar phrase.')
  }
  if (/^every\b/i.test(input.trim())) return parseCalendarPhrase(input)
  return parseCron5Field(input)
}

/** Whether one allowed field set admits a concrete value. */
function matches(values: readonly number[], value: number): boolean {
  return values.length === 0 || values.includes(value)
}

/** Whether a concrete day satisfies the Cron day-of-month / day-of-week OR rule. */
function dayMatches(rule: CronRule, day: number, dayOfWeek: number): boolean {
  const domEmpty = rule.daysOfMonth.length === 0
  const dowEmpty = rule.daysOfWeek.length === 0
  if (domEmpty && dowEmpty) return true
  if (domEmpty) return rule.daysOfWeek.includes(dayOfWeek)
  if (dowEmpty) return rule.daysOfMonth.includes(day)
  return rule.daysOfMonth.includes(day) || rule.daysOfWeek.includes(dayOfWeek)
}

/** First minute of the next month whose month field matches. */
function nextMonthStart(year: number, month: number, rule: CronRule): number {
  let y = year
  let m = month
  for (let index = 0; index < 12; index += 1) {
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
    if (matches(rule.months, m)) return Date.UTC(y, m - 1, 1, 0, 0, 0, 0)
  }
  /* v8 ignore next -- a non-empty month set always matches within twelve steps. */
  return Date.UTC(y, m - 1, 1, 0, 0, 0, 0)
}

/** Last minute (23:59) of the previous month whose month field matches. */
function previousMonthEnd(year: number, month: number, rule: CronRule): number {
  let y = year
  let m = month
  for (let index = 0; index < 12; index += 1) {
    m -= 1
    if (m < 1) {
      m = 12
      y -= 1
    }
    if (matches(rule.months, m)) return Date.UTC(y, m, 0, 23, 59, 0, 0)
  }
  /* v8 ignore next -- a non-empty month set always matches within twelve steps. */
  return Date.UTC(y, m, 0, 23, 59, 0, 0)
}

/**
 * Compute the first whole-minute occurrence strictly after a UTC epoch.
 * @param rule - Normalized calendar rule.
 * @param afterEpoch - Exclusive lower bound in epoch milliseconds.
 * @returns The next occurrence, or `undefined` when none fits the four-digit range.
 */
export function nextCronOccurrence(rule: CronRule, afterEpoch: number): number | undefined {
  if (!Number.isSafeInteger(afterEpoch)) {
    throw new CalendarRuleError('Cron occurrence requires a safe-integer epoch.')
  }
  if (afterEpoch < MIN_FOUR_DIGIT_YEAR_MS || afterEpoch > MAX_FOUR_DIGIT_YEAR_MS) return undefined
  let candidate = Math.floor(afterEpoch / 60_000) * 60_000 + 60_000
  for (let guard = 0; guard < 12_000_000; guard += 1) {
    if (candidate > MAX_FOUR_DIGIT_YEAR_MS) return undefined
    const date = new Date(candidate)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    const hour = date.getUTCHours()
    const minute = date.getUTCMinutes()
    const dayOfWeek = date.getUTCDay()

    if (!matches(rule.months, month)) {
      candidate = nextMonthStart(year, month, rule)
      continue
    }
    if (!dayMatches(rule, day, dayOfWeek)) {
      candidate = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0)
      continue
    }
    if (!matches(rule.hours, hour)) {
      candidate = Date.UTC(year, month - 1, day, hour + 1, 0, 0, 0)
      continue
    }
    if (!matches(rule.minutes, minute)) {
      candidate = Date.UTC(year, month - 1, day, hour, minute + 1, 0, 0)
      continue
    }
    return candidate
  }
  /* v8 ignore next -- the guard bounds a strictly-advancing scan over the four-digit range. */
  return undefined
}

/**
 * Compute the last whole-minute occurrence strictly before a UTC epoch.
 * @param rule - Normalized calendar rule.
 * @param beforeEpoch - Exclusive upper bound in epoch milliseconds.
 * @returns The previous occurrence, or `undefined` when none fits the four-digit range.
 */
export function previousCronOccurrence(rule: CronRule, beforeEpoch: number): number | undefined {
  if (!Number.isSafeInteger(beforeEpoch)) {
    throw new CalendarRuleError('Cron occurrence requires a safe-integer epoch.')
  }
  if (beforeEpoch <= MIN_FOUR_DIGIT_YEAR_MS) return undefined
  let candidate = Math.min(
    MAX_FOUR_DIGIT_YEAR_MS,
    Math.floor((beforeEpoch - 1) / 60_000) * 60_000,
  )
  for (let guard = 0; guard < 12_000_000; guard += 1) {
    if (candidate < MIN_FOUR_DIGIT_YEAR_MS) return undefined
    const date = new Date(candidate)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    const hour = date.getUTCHours()
    const minute = date.getUTCMinutes()
    const dayOfWeek = date.getUTCDay()

    if (!matches(rule.months, month)) {
      candidate = previousMonthEnd(year, month, rule)
      continue
    }
    if (!dayMatches(rule, day, dayOfWeek)) {
      candidate = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - 60_000
      continue
    }
    if (!matches(rule.hours, hour)) {
      candidate = Date.UTC(year, month - 1, day, hour, 0, 0, 0) - 60_000
      continue
    }
    if (!matches(rule.minutes, minute)) {
      candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - 60_000
      continue
    }
    return candidate
  }
  /* v8 ignore next -- the guard bounds a strictly-retreating scan over the four-digit range. */
  return undefined
}
