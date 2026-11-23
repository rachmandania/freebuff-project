import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { appOrigin, currentUser, isLocalPreview, type Env } from './auth'
import {
  computeStreak,
  localDate,
  normalizeTimeZone,
  starDays,
  timeZoneLabel,
  utcOffsetMinutes,
  DEFAULT_TIME_ZONE,
} from './attendance'
import { ensureSchema, mapRecord, type AttendanceRow } from './db'
import type { AttendanceDashboard } from '../shared/types'

type AppContext = {
  Bindings: Env
  Variables: { user: FreebuffUser; db: D1Database }
}
type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>
type Clock = () => number

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const HISTORY_LIMIT = 800

async function loadDashboard(
  db: D1Database,
  userId: string,
  month: string,
  timeZone: string,
  nowMs: number,
): Promise<AttendanceDashboard> {
  const rows = await db
    .prepare(
      'SELECT local_date, checked_in_at, timezone, utc_offset_minutes FROM attendance_days WHERE user_id = ? ORDER BY local_date DESC LIMIT ?',
    )
    .bind(userId, HISTORY_LIMIT)
    .all<AttendanceRow>()
  const dates = rows.results.map((row) => row.local_date)
  const instant = new Date(nowMs)
  const today = localDate(instant, timeZone)
  const streak = computeStreak(dates, today)
  const stars = starDays(dates)
  return {
    month,
    today,
    timeZone,
    timeZoneLabel: timeZoneLabel(instant, timeZone),
    streak,
    hasStar: streak >= 7,
    daysToStar: streak > 0 && streak % 7 === 0 ? 7 : 7 - (streak % 7),
    checkedInToday: dates.includes(today),
    totalDays: dates.length,
    records: rows.results
      .filter((row) => row.local_date.startsWith(`${month}-`))
      .map((row) => mapRecord(row, stars.has(row.local_date))),
  }
}

/** Tests inject identities and a clock; production uses the Freebuff SDK. */
export function createApp(
  authenticate: Authenticate = currentUser,
  clock: Clock = Date.now,
) {
  const app = new Hono<AppContext>()
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 8 * 1024,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  )
  app.get('/api/session', async (c) =>
    c.json({
      user: await authenticate(c.req.raw, c.env),
      mode: isLocalPreview(c.req.raw, c.env)
        ? 'local'
        : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN
          ? 'freebuff'
          : 'setup',
      database: Boolean(c.env.DB),
    }),
  )

  app.use('/api/attendance/*', async (c, next) => {
    const user = await authenticate(c.req.raw, c.env)
    if (!user) return c.json({ error: 'Sign in required.' }, 401)
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env)
      if (!origin || !isSameOriginRequest(c.req.raw, origin))
        return c.json({ error: 'Cross-origin request refused.' }, 403)
    }
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    c.set('user', user)
    c.set('db', c.env.DB)
    await next()
  })

  app.get('/api/attendance', async (c) => {
    const timeZone = c.req.query('timeZone')
      ? normalizeTimeZone(c.req.query('timeZone'))
      : DEFAULT_TIME_ZONE
    const nowMs = clock()
    const requested = c.req.query('month')
    if (requested && !MONTH.test(requested))
      return c.json({ error: 'Month must be formatted as YYYY-MM.' }, 400)
    const month = requested || localDate(new Date(nowMs), timeZone).slice(0, 7)
    return c.json(
      await loadDashboard(c.get('db'), c.get('user').sub, month, timeZone, nowMs),
    )
  })

  app.post('/api/attendance/check-in', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'timeZone') ||
      ('timeZone' in body &&
        (typeof body.timeZone !== 'string' || body.timeZone.length > 64))
    )
      return c.json({ error: 'Invalid check-in request.' }, 400)

    const user = c.get('user')
    const timeZone = normalizeTimeZone(
      'timeZone' in body ? body.timeZone : undefined,
    )
    const nowMs = clock()
    const instant = new Date(nowMs)
    const day = localDate(instant, timeZone)
    const db = c.get('db')

    await db
      .prepare(
        `INSERT INTO employees (user_id, email, name, timezone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           timezone = excluded.timezone,
           updated_at = excluded.updated_at`,
      )
      .bind(
        user.sub,
        user.email ?? null,
        user.name ?? null,
        timeZone,
        nowMs,
        nowMs,
      )
      .run()

    const inserted = await db
      .prepare(
        `INSERT INTO attendance_days (user_id, local_date, checked_in_at, timezone, utc_offset_minutes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, local_date) DO NOTHING
         RETURNING local_date, checked_in_at, timezone, utc_offset_minutes`,
      )
      .bind(user.sub, day, nowMs, timeZone, utcOffsetMinutes(instant, timeZone))
      .first<AttendanceRow>()

    const month = day.slice(0, 7)
    const dashboard = await loadDashboard(
      db,
      user.sub,
      month,
      timeZone,
      nowMs,
    )

    if (!inserted)
      return c.json({ error: 'You have already checked in today.', dashboard }, 409)

    return c.json(
      {
        record: dashboard.records.find((record) => record.localDate === day),
        dashboard,
      },
      201,
    )
  })

  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/')
      ? c.json({ error: 'Endpoint not found.' }, 404)
      : c.env.ASSETS.fetch(c.req.raw),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}
