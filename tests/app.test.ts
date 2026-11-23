import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import { ensureSchema } from '../src/worker/db'
import { currentUser, type Env } from '../src/worker/auth'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-db',
        compatibilityDate: '2026-11-11',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents:
                'export default { fetch() { return new Response("test") } }',
            },
          },
        },
        env: { DB: { type: 'd1', name: 'attendance-test' } },
      },
    },
  ],
  port: 0,
})
let env: Env
beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  env = {
    DB: db as unknown as D1Database,
    APP_ORIGIN: 'https://app.example.test',
    ASSETS: {
      fetch: async () => new Response('public page'),
    } as unknown as Fetcher,
  }
  await ensureSchema(env.DB!)
}, 20_000)
afterAll(() => runtime.dispose())

// This identity/clock seam exists only in the app factory. The Worker
// entrypoint always uses the real auth SDK and the real clock.
const authenticate = async (request: Request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
}
const at = (iso: string) => createApp(authenticate, () => Date.parse(iso))

const call = (
  app: ReturnType<typeof createApp>,
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin = env.APP_ORIGIN!,
) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        Origin: origin,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

async function seed(owner: string, dates: string[], timezone = 'Asia/Jakarta') {
  for (const date of dates)
    await env
      .DB!.prepare(
        `INSERT OR IGNORE INTO attendance_days (user_id, local_date, checked_in_at, timezone, utc_offset_minutes)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(owner, date, Date.parse('2026-11-01T00:00:00Z'), timezone, 420)
      .run()
}

test('signed-out requests, foreign origins and malformed input are refused', async () => {
  const app = at('2026-11-23T09:00:00Z')
  for (const [path, method] of [
    ['/api/attendance', 'GET'],
    ['/api/attendance?month=2026-11', 'GET'],
    ['/api/attendance/check-in', 'POST'],
  ]) {
    const response = await call(app, path!, undefined, method)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  expect(
    (
      await call(
        app,
        '/api/attendance/check-in',
        'alice',
        'POST',
        { timeZone: 'Asia/Jakarta' },
        'https://foreign.example',
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.request(
        'https://app.example.test/api/attendance/check-in',
        { method: 'POST', headers: { 'test-user': 'alice' } },
        env,
      )
    ).status,
  ).toBe(403)
  expect((await call(app, '/api/attendance?month=2026-13', 'alice')).status).toBe(
    400,
  )
  for (const body of [
    { timeZone: 5 },
    { timeZone: 'x'.repeat(100) },
    { timeZone: 'Asia/Jakarta', extra: true },
    'not-json',
    [],
    null,
  ])
    expect(
      (await call(app, '/api/attendance/check-in', 'alice', 'POST', body)).status,
    ).toBe(400)
  expect(
    (
      await call(
        app,
        '/api/attendance/check-in',
        'alice',
        'POST',
        { timeZone: 'x'.repeat(10_000) },
      )
    ).status,
  ).toBe(413)
  expect(await (await call(app, '/')).text()).toBe('public page')
  expect((await call(app, '/api/health')).status).toBe(200)
})

test('one check-in per local day, scoped to the signed-in account', async () => {
  const app = at('2026-11-23T02:00:00Z') // 09:00 in Jakarta
  const first = await call(app, '/api/attendance/check-in', 'carol', 'POST', {
    timeZone: 'Asia/Jakarta',
  })
  expect(first.status).toBe(201)
  const created = (await first.json()) as {
    record: { localDate: string; localTime: string; timeZone: string }
    dashboard: { streak: number; checkedInToday: boolean; totalDays: number }
  }
  expect(created.record.localDate).toBe('2026-11-23')
  expect(created.record.localTime).toBe('09:00')
  expect(created.record.timeZone).toBe('Asia/Jakarta')
  expect(created.dashboard).toMatchObject({
    streak: 1,
    checkedInToday: true,
    totalDays: 1,
  })

  const duplicate = await call(
    app,
    '/api/attendance/check-in',
    'carol',
    'POST',
    { timeZone: 'Asia/Jakarta' },
  )
  expect(duplicate.status).toBe(409)
  expect(((await duplicate.json()) as { dashboard: { totalDays: number } }).dashboard.totalDays).toBe(1)

  const other = (await (
    await call(app, '/api/attendance?timeZone=Asia/Jakarta', 'dave')
  ).json()) as { records: unknown[]; streak: number; checkedInToday: boolean }
  expect(other.records).toHaveLength(0)
  expect(other.streak).toBe(0)
  expect(other.checkedInToday).toBe(false)
})

test('local day and wall-clock time follow the check-in timezone', async () => {
  const app = at('2026-11-23T18:30:00Z') // 01:30 on the 24th in Jakarta, 13:30 on the 23rd in Toronto
  const jakarta = await call(app, '/api/attendance/check-in', 'erin', 'POST', {
    timeZone: 'Asia/Jakarta',
  })
  const toronto = await call(app, '/api/attendance/check-in', 'frank', 'POST', {
    timeZone: 'America/Toronto',
  })
  const jakartaBody = (await jakarta.json()) as {
    record: { localDate: string; localTime: string; timeZoneLabel: string; utcOffsetMinutes: number }
  }
  const torontoBody = (await toronto.json()) as {
    record: { localDate: string; localTime: string; timeZoneLabel: string; utcOffsetMinutes: number }
  }
  expect(jakartaBody.record).toMatchObject({
    localDate: '2026-11-24',
    localTime: '01:30',
    utcOffsetMinutes: 420,
  })
  expect(torontoBody.record).toMatchObject({
    localDate: '2026-11-23',
    localTime: '13:30',
    utcOffsetMinutes: -300,
  })

  const unknown = await call(app, '/api/attendance/check-in', 'gina', 'POST', {
    timeZone: 'Not/AZone',
  })
  expect(unknown.status).toBe(201)
  expect(
    ((await unknown.json()) as { record: { timeZone: string } }).record.timeZone,
  ).toBe('Asia/Jakarta')
})

test('a missed day resets the streak and every seventh day is starred', async () => {
  await seed('henry', [
    '2026-11-17',
    '2026-11-18',
    '2026-11-19',
    '2026-11-20',
    '2026-11-21',
    '2026-11-22',
  ])
  const broken = at('2026-11-24T02:00:00Z') // 09:00 on the 24th in Jakarta
  const before = (await (
    await call(broken, '/api/attendance?month=2026-11&timeZone=Asia/Jakarta', 'henry')
  ).json()) as { streak: number; checkedInToday: boolean }
  expect(before).toMatchObject({ streak: 0, checkedInToday: false })
  const restarted = await call(
    broken,
    '/api/attendance/check-in',
    'henry',
    'POST',
    { timeZone: 'Asia/Jakarta' },
  )
  expect(
    ((await restarted.json()) as { dashboard: { streak: number; hasStar: boolean } })
      .dashboard,
  ).toMatchObject({ streak: 1, hasStar: false })

  await seed('ivy', [
    '2026-11-18',
    '2026-11-19',
    '2026-11-20',
    '2026-11-21',
    '2026-11-22',
    '2026-11-23',
  ])
  const seventh = await call(
    broken,
    '/api/attendance/check-in',
    'ivy',
    'POST',
    { timeZone: 'Asia/Jakarta' },
  )
  const seventhBody = (await seventh.json()) as {
    record: { localDate: string; starred: boolean }
    dashboard: {
      streak: number
      hasStar: boolean
      daysToStar: number
      records: { localDate: string; starred: boolean }[]
    }
  }
  expect(seventhBody.record).toMatchObject({ localDate: '2026-11-24', starred: true })
  expect(seventhBody.dashboard).toMatchObject({
    streak: 7,
    hasStar: true,
    daysToStar: 7,
  })
  expect(
    seventhBody.dashboard.records.find((row) => row.localDate === '2026-11-21')
      ?.starred,
  ).toBe(false)

  const recap = (await (
    await call(broken, '/api/attendance?month=2026-11&timeZone=Asia/Jakarta', 'ivy')
  ).json()) as { month: string; records: { localDate: string; localTime: string }[] }
  expect(recap.month).toBe('2026-11')
  expect(recap.records).toHaveLength(7)
  expect(recap.records[0]).toMatchObject({ localDate: '2026-11-24', localTime: '09:00' })
})

test('missing database reports setup and local preview identity never activates on hosted origins', async () => {
  const app = at('2026-11-23T09:00:00Z')
  const noDb = await app.request(
    'https://app.example.test/api/attendance?timeZone=Asia/Jakarta',
    { headers: { 'test-user': 'alice' } },
    { ...env, DB: undefined },
  )
  expect(noDb.status).toBe(503)
  expect(
    await currentUser(new Request('https://app.example.test/'), {} as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {
      APP_ORIGIN: 'https://app.example.test',
    } as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {} as Env),
  ).toMatchObject({ sub: 'local-preview' })
})
