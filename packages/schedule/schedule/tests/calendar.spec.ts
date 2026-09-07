import { describe, expect, it } from 'vitest'
import {
  CalendarRuleError,
  nextCronOccurrence,
  parseCalendarPhrase,
  parseCron5Field,
  parseCronRule,
  previousCronOccurrence,
} from '../src/calendar.ts'

function rule(minutes: number[], hours: number[], daysOfMonth: number[], months: number[], daysOfWeek: number[]) {
  return { minutes, hours, daysOfMonth, months, daysOfWeek }
}

describe('five-field Cron parsing', () => {
  it.each([
    ['30 9 * * 1', rule([30], [9], [], [], [1])],
    ['0 9 * * *', rule([0], [9], [], [], [])],
    ['*/15 * * * *', rule([0, 15, 30, 45], [], [], [], [])],
    ['0 9 * * 1-5', rule([0], [9], [], [], [1, 2, 3, 4, 5])],
    ['0 9 1,15 * *', rule([0], [9], [1, 15], [], [])],
    ['0 0 1 1 *', rule([0], [0], [1], [1], [])],
    ['0 9 * * MON-FRI', rule([0], [9], [], [], [1, 2, 3, 4, 5])],
    ['0 9 * * 7', rule([0], [9], [], [], [0])],
    ['0 9 * * 0', rule([0], [9], [], [], [0])],
    ['0 0 * JAN *', rule([0], [0], [], [1], [])],
    ['0-30/10 * * * *', rule([0, 10, 20, 30], [], [], [], [])],
    [' 30   9   *   *   1 ', rule([30], [9], [], [], [1])],
  ])('normalizes %s', (expression, expected) => {
    expect(parseCron5Field(expression)).toEqual(expected)
  })

  it.each([
    '',
    '30 9 * *',
    '30 9 * * 1 2',
    '60 9 * * *',
    '30 24 * * *',
    '30 9 32 * *',
    '30 9 * 13 *',
    '30 9 * * 8',
    '30 9 5-1 * *',
    '30 9 * * 1/2',
    'a b c d e',
    '30 9 * * -1',
    '30, 9 * * *',
  ])('rejects invalid Cron %s', (expression) => {
    expect(() => parseCron5Field(expression)).toThrow(CalendarRuleError)
  })
})

describe('calendar phrase parsing', () => {
  it.each([
    ['every day at 09:30', rule([30], [9], [], [], [])],
    ['every weekday at 9', rule([0], [9], [], [], [1, 2, 3, 4, 5])],
    ['every monday at 9am', rule([0], [9], [], [], [1])],
    ['every monday 9am', rule([0], [9], [], [], [1])],
    ['every monday at 9:30am', rule([30], [9], [], [], [1])],
    ['every friday at 5pm', rule([0], [17], [], [], [5])],
    ['every weekend at 10:00', rule([0], [10], [], [], [0, 6])],
    ['every day at 0', rule([0], [0], [], [], [])],
    ['every tuesday at 12pm', rule([0], [12], [], [], [2])],
    ['every wednesday at 12am', rule([0], [0], [], [], [3])],
    ['Every Monday At 9AM', rule([0], [9], [], [], [1])],
    ['every mondays at 9', rule([0], [9], [], [], [1])],
  ])('normalizes %s', (phrase, expected) => {
    expect(parseCalendarPhrase(phrase)).toEqual(expected)
  })

  it.each([
    'every monday',
    'every monday at',
    'every someday at 9',
    'every monday at 25',
    'every monday at 9:60',
    'every monday at 13pm',
    'monday at 9',
    'every at 9',
  ])('rejects invalid phrase %s', (phrase) => {
    expect(() => parseCalendarPhrase(phrase)).toThrow(CalendarRuleError)
  })
})

describe('cron selector auto-detection', () => {
  it('routes Cron expressions and phrases to their parsers', () => {
    expect(parseCronRule('30 9 * * 1')).toEqual(rule([30], [9], [], [], [1]))
    expect(parseCronRule('every monday at 9')).toEqual(rule([0], [9], [], [], [1]))
  })

  it('rejects empty and non-string selectors', () => {
    expect(() => parseCronRule('')).toThrow(CalendarRuleError)
    expect(() => parseCronRule('   ')).toThrow(CalendarRuleError)
  })
})

describe('cron occurrence arithmetic', () => {
  const monday9 = parseCron5Field('0 9 * * 1')
  const quarterHour = parseCron5Field('*/15 * * * *')
  const daily = parseCron5Field('0 0 * * *')
  const feb29 = parseCron5Field('0 0 29 2 *')
  const jan1 = parseCron5Field('0 0 1 1 *')

  it('finds the next whole-minute occurrence strictly after the bound', () => {
    expect(new Date(nextCronOccurrence(monday9, Date.parse('2026-09-06T10:00:00.000Z')) ?? 0).toISOString())
      .toBe('2026-09-07T09:00:00.000Z')
    expect(new Date(nextCronOccurrence(monday9, Date.parse('2026-09-07T09:00:00.000Z')) ?? 0).toISOString())
      .toBe('2026-09-14T09:00:00.000Z')
    expect(new Date(nextCronOccurrence(quarterHour, Date.parse('2026-09-06T12:07:00.000Z')) ?? 0).toISOString())
      .toBe('2026-09-06T12:15:00.000Z')
    expect(new Date(nextCronOccurrence(daily, Date.parse('2026-09-06T12:34:00.000Z')) ?? 0).toISOString())
      .toBe('2026-09-07T00:00:00.000Z')
    expect(new Date(nextCronOccurrence(feb29, Date.parse('2026-03-01T00:00:00.000Z')) ?? 0).toISOString())
      .toBe('2028-02-29T00:00:00.000Z')
    expect(new Date(nextCronOccurrence(jan1, Date.parse('2026-09-06T00:00:00.000Z')) ?? 0).toISOString())
      .toBe('2027-01-01T00:00:00.000Z')
  })

  it('returns undefined beyond the representable four-digit range', () => {
    expect(nextCronOccurrence(daily, Date.parse('9999-12-31T23:59:59.000Z'))).toBeUndefined()
  })

  it('finds the previous whole-minute occurrence strictly before the bound', () => {
    expect(new Date(previousCronOccurrence(monday9, Date.parse('2026-09-07T10:00:00.000Z')) ?? 0).toISOString())
      .toBe('2026-09-07T09:00:00.000Z')
    expect(new Date(previousCronOccurrence(monday9, Date.parse('2026-09-07T09:00:00.000Z')) ?? 0).toISOString())
      .toBe('2026-08-31T09:00:00.000Z')
    expect(new Date(previousCronOccurrence(quarterHour, Date.parse('2026-09-06T12:07:00.000Z')) ?? 0).toISOString())
      .toBe('2026-09-06T12:00:00.000Z')
  })

  it('returns undefined before the representable four-digit range', () => {
    expect(previousCronOccurrence(daily, Date.parse('0001-01-01T00:00:00.000Z'))).toBeUndefined()
  })
})
