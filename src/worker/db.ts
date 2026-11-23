import type { AttendanceRecord } from '../shared/types'
import { localTime, timeZoneLabel, utcOffsetMinutes } from './attendance'

const schema = [
  `CREATE TABLE IF NOT EXISTS employees (
    user_id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT,
    timezone TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS attendance_days (
    user_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    checked_in_at INTEGER NOT NULL,
    timezone TEXT NOT NULL,
    utc_offset_minutes INTEGER NOT NULL,
    PRIMARY KEY (user_id, local_date)
  )`,
  `CREATE INDEX IF NOT EXISTS attendance_user_date ON attendance_days(user_id, local_date DESC)`,
]

const ready = new WeakMap<D1Database, Promise<void>>()
export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = db
      .batch(schema.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((error) => {
        ready.delete(db)
        throw error
      })
    ready.set(db, pending)
  }
  return pending
}

export type AttendanceRow = {
  local_date: string
  checked_in_at: number
  timezone: string
  utc_offset_minutes: number
}

export function mapRecord(row: AttendanceRow, starred: boolean): AttendanceRecord {
  const instant = new Date(row.checked_in_at)
  return {
    localDate: row.local_date,
    localTime: localTime(instant, row.timezone),
    timeZone: row.timezone,
    timeZoneLabel: timeZoneLabel(instant, row.timezone),
    utcOffsetMinutes: utcOffsetMinutes(instant, row.timezone),
    checkedInAt: instant.toISOString(),
    starred,
  }
}
