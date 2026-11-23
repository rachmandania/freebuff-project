export const DEFAULT_TIME_ZONE = 'Asia/Jakarta'

const pad = (value: number) => String(value).padStart(2, '0')

/** Falls back to the default zone when the client sends something unusable. */
export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TIME_ZONE
  const candidate = value.trim()
  if (!candidate || candidate.length > 64) return DEFAULT_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date())
    return candidate
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

function dateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  }
}

/** The calendar day in `timeZone` for a UTC instant, as YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string {
  const { year, month, day } = dateParts(instant, timeZone)
  return `${year}-${pad(month)}-${pad(day)}`
}

/** The wall-clock time in `timeZone` for a UTC instant, as HH:mm. */
export function localTime(instant: Date, timeZone: string): string {
  const { hour, minute } = dateParts(instant, timeZone)
  return `${pad(hour)}:${pad(minute)}`
}

/** Offset from UTC at that instant, so DST changes stay truthful. */
export function utcOffsetMinutes(instant: Date, timeZone: string): number {
  const { year, month, day, hour, minute } = dateParts(instant, timeZone)
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  const floored = Math.floor(instant.getTime() / 60_000) * 60_000
  return Math.round((asUtc - floored) / 60_000)
}

export function timeZoneLabel(instant: Date, timeZone: string): string {
  const label = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value
  return label || timeZone
}

/** Shifts a YYYY-MM-DD calendar day by a number of days. */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year!, month! - 1, day!) + days * 86_400_000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * Strict consecutive streak: the run of days ending today, or ending yesterday
 * while today is still open. One missed day resets the count to zero.
 */
export function computeStreak(dates: Iterable<string>, today: string): number {
  const days = new Set(dates)
  let cursor = days.has(today) ? today : shiftDate(today, -1)
  let streak = 0
  while (days.has(cursor)) {
    streak += 1
    cursor = shiftDate(cursor, -1)
  }
  return streak
}

/** Days that completed a 7, 14, 21… day run; history is never erased. */
export function starDays(dates: Iterable<string>): Set<string> {
  const sorted = [...dates].sort()
  const stars = new Set<string>()
  let run = 0
  let previous: string | null = null
  for (const date of sorted) {
    run = previous && shiftDate(previous, 1) === date ? run + 1 : 1
    if (run % 7 === 0) stars.add(date)
    previous = date
  }
  return stars
}
