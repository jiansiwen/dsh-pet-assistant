import type { ReminderSchedule } from './companion-contract.ts'

const formatters = new Map<string, Intl.DateTimeFormat>()

function localParts(at: number, timezone: string): number[] {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    formatters.set(timezone, formatter)
  }
  const parts = formatter.formatToParts(at)
  return ['year', 'month', 'day', 'hour', 'minute'].map(key => Number(parts.find(part => part.type === key)!.value))
}

export function nextDailyAt(after: number, timezone: string, localTime: string): number {
  const [year, month, day] = localParts(after, timezone)
  const [hour, minute] = localTime.split(':').map(Number)
  const targetMinute = hour * 60 + minute
  for (let delta = 0; delta < 4; delta++) {
    const date = new Date(Date.UTC(year, month - 1, day + delta))
    const nominal = date.getTime()
    const targetDate = date.toISOString().slice(0, 10)
    let first: number | undefined
    for (let at = nominal - 18 * 3_600_000; at <= nominal + 42 * 3_600_000; at += 60_000) {
      const [y, m, d, h, min] = localParts(at, timezone)
      const localDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      if (localDate === targetDate && h * 60 + min >= targetMinute) {
        first = at
        break
      }
    }
    if (first !== undefined && first > after) return first
  }
  throw new Error('无法计算此时区的下一次每日提醒')
}

export function firstScheduleAt(spec: ReminderSchedule, now: number): number {
  return spec.kind === 'daily' ? nextDailyAt(now, spec.timezone, spec.localTime) : Date.parse(spec.runAt)
}

export function nextScheduleAt(spec: ReminderSchedule, after: number): number | null {
  if (spec.kind === 'once') return null
  if (spec.kind === 'daily') return nextDailyAt(after, spec.timezone, spec.localTime)
  const start = Date.parse(spec.runAt)
  const interval = spec.everySeconds * 1000
  return start > after ? start : start + (Math.floor((after - start) / interval) + 1) * interval
}
