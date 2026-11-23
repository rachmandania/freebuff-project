export type AttendanceRecord = {
  /** Local calendar day of the check-in, YYYY-MM-DD in the record's timezone. */
  localDate: string
  /** Local wall-clock time of the check-in in that timezone, HH:mm. */
  localTime: string
  /** IANA timezone in effect when the check-in happened. */
  timeZone: string
  /** Short label for that timezone at that instant, e.g. WIB or EST. */
  timeZoneLabel: string
  utcOffsetMinutes: number
  checkedInAt: string
  /** True when this day completes a 7-day consecutive block. */
  starred: boolean
}

export type AttendanceDashboard = {
  /** Month being displayed, YYYY-MM. */
  month: string
  /** Today's date in the viewer's timezone. */
  today: string
  timeZone: string
  timeZoneLabel: string
  /** Consecutive days ending today (or yesterday while today is still open). */
  streak: number
  /** True once the active streak reaches 7 days. */
  hasStar: boolean
  /** Days still needed for the next star. */
  daysToStar: number
  checkedInToday: boolean
  /** Every day this account has ever checked in. */
  totalDays: number
  records: AttendanceRecord[]
}

export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'local' | 'freebuff' | 'setup'
  database: boolean
}
