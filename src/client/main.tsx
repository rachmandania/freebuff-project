import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AttendanceDashboard, AttendanceRecord, Session } from '../shared/types'
import './style.css'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => {
    throw new Error('Tidak bisa menghubungi server. Coba lagi.')
  })) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'Permintaan gagal. Coba lagi.')
  return body
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
  } catch {
    return 'Asia/Jakarta'
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number)
  const shifted = new Date(Date.UTC(year!, index! - 1 + delta, 1))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`
}

function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number)
  return new Date(Date.UTC(year!, index! - 1, 1)).toLocaleDateString('id-ID', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function dayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** Monday-first grid of local dates for one month. */
function calendarCells(month: string): (string | null)[] {
  const [year, index] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year!, index! - 1, 1))
  const days = new Date(Date.UTC(year!, index!, 0)).getUTCDate()
  const cells: (string | null)[] = Array((first.getUTCDay() + 6) % 7).fill(null)
  for (let day = 1; day <= days; day += 1)
    cells.push(`${month}-${pad(day)}`)
  while (cells.length % 7) cells.push(null)
  return cells
}

const WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min']

function App() {
  const timeZone = useMemo(browserTimeZone, [])
  const [session, setSession] = useState<Session | null>(null)
  const [dashboard, setDashboard] = useState<AttendanceDashboard | null>(null)
  const [month, setMonth] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(
    async (target?: string) => {
      const params = new URLSearchParams({ timeZone })
      if (target) params.set('month', target)
      const result = await request<AttendanceDashboard>(
        `/api/attendance?${params.toString()}`,
      )
      setDashboard(result)
      setMonth(result.month)
      return result
    },
    [timeZone],
  )

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const current = await request<Session>('/api/session')
        if (!live) return
        setSession(current)
        if (current.user && current.database) await load()
      } catch (e) {
        if (live)
          setError(e instanceof Error ? e.message : 'Gagal memuat data absensi.')
      } finally {
        if (live) setLoaded(true)
      }
    })()
    return () => {
      live = false
    }
  }, [load])

  const signedIn = Boolean(session?.user && session.database)
  const records = dashboard?.records ?? []
  const recordOf = useMemo(
    () => new Map<string, AttendanceRecord>(records.map((row) => [row.localDate, row])),
    [records],
  )

  async function checkIn() {
    if (!signedIn) {
      window.location.href = '/auth/freebuff/signin?returnTo=%2F'
      return
    }
    if (busy || dashboard?.checkedInToday) return
    setBusy(true)
    setError('')
    try {
      const result = await request<{
        record: AttendanceRecord
        dashboard: AttendanceDashboard
      }>('/api/attendance/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZone }),
      })
      setDashboard(result.dashboard)
      setMonth(result.dashboard.month)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Absen gagal. Coba lagi.')
    } finally {
      setBusy(false)
    }
  }

  async function changeMonth(delta: number) {
    if (!month || busy) return
    setBusy(true)
    setError('')
    try {
      await load(shiftMonth(month, delta))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat bulan itu.')
    } finally {
      setBusy(false)
    }
  }

  const streak = dashboard?.streak ?? 0
  const hasStar = dashboard?.hasStar ?? false
  const filled = streak === 0 ? 0 : streak % 7 === 0 ? 7 : streak % 7
  const name = session?.user?.name || session?.user?.email || ''
  const initial = (name || 'F').trim().charAt(0).toUpperCase()

  return (
    <main>
      <header className="topbar">
        <span className="wordmark">
          Kehadiran <span className="wordmark-dot">·</span> Freebuff
        </span>
        <div className="account">
          {session?.mode === 'local' && <span className="badge">Local preview</span>}
          {session?.user ? (
            <>
              <span className="avatar" aria-hidden="true">
                {initial}
              </span>
              <span className="account-name">{name || 'Signed in'}</span>
              <form method="post" action="/auth/freebuff/signout">
                <button className="quiet" type="submit">
                  Keluar
                </button>
              </form>
            </>
          ) : session?.mode === 'freebuff' ? (
            <a className="button small" href="/auth/freebuff/signin?returnTo=%2F">
              Masuk dengan Freebuff
            </a>
          ) : null}
        </div>
      </header>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {session && !signedIn && session.mode === 'setup' && (
        <p className="notice">Aplikasi ini masih disiapkan. Coba lagi nanti.</p>
      )}

      <div className="board">
        <section className="card checkin" aria-labelledby="checkin-title">
          <p className="eyebrow">
            {dashboard ? dayLabel(dashboard.today) : 'Hari ini'}
          </p>
          <h1 id="checkin-title">
            {signedIn && name ? `Halo, ${name.split(' ')[0]}.` : 'Absen harian.'}
          </h1>
          <p className="lede">
            {dashboard?.checkedInToday
              ? 'Kehadiranmu hari ini sudah tercatat. Sampai jumpa besok.'
              : signedIn
                ? 'Satu ketukan untuk mencatat kehadiran hari ini.'
                : 'Masuk dengan akun Freebuff untuk mulai mencatat kehadiran.'}
          </p>

          <button
            type="button"
            className={`punch${dashboard?.checkedInToday ? ' done' : ''}`}
            disabled={busy || Boolean(dashboard?.checkedInToday)}
            onClick={() => void checkIn()}
          >
            <span className="punch-icon" aria-hidden="true">
              {dashboard?.checkedInToday ? (hasStar ? '★' : '✓') : '✓'}
            </span>
            <span>
              {busy
                ? 'Menyimpan…'
                : dashboard?.checkedInToday
                  ? 'Sudah absen hari ini'
                  : 'Absen sekarang'}
            </span>
          </button>

          <p className="streak" aria-live="polite">
            {!signedIn ? (
              <>Belum punya akun? Akun dibuat saat kamu masuk pertama kali.</>
            ) : streak === 0 ? (
              <>Belum ada streak · absen hari ini untuk mulai.</>
            ) : (
              <>
                Streak <strong>{streak} hari</strong>
                {hasStar && (
                  <span className="star" aria-label="sudah 7 hari berturut-turut">
                    {' '}
                    ★
                  </span>
                )}
                <span className="streak-next">
                  {' '}
                  · {dashboard?.daysToStar} hari lagi menuju ★
                </span>
              </>
            )}
          </p>

          {signedIn && (
            <div className="ticks" aria-hidden="true">
              {Array.from({ length: 7 }, (_, index) => (
                <span
                  key={index}
                  className={`tick${index < filled ? ' on' : ''}${
                    index < filled && filled === 7 && hasStar ? ' gold' : ''
                  }`}
                />
              ))}
            </div>
          )}

          {signedIn && dashboard && (
            <p className="meta">
              Zona waktu: {dashboard.timeZoneLabel} · {dashboard.timeZone}
            </p>
          )}
        </section>

        <section className="card month" aria-labelledby="month-title">
          <div className="month-head">
            <button
              type="button"
              className="quiet round"
              onClick={() => void changeMonth(-1)}
              disabled={!month || busy}
              aria-label="Bulan sebelumnya"
            >
              ‹
            </button>
            <h2 id="month-title">{month ? monthLabel(month) : 'Kalender'}</h2>
            <button
              type="button"
              className="quiet round"
              onClick={() => void changeMonth(1)}
              disabled={!month || busy}
              aria-label="Bulan berikutnya"
            >
              ›
            </button>
          </div>
          <div className="weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="days">
            {calendarCells(month || '2026-01').map((date, index) => {
              if (!date) return <span key={`pad-${index}`} className="day pad" />
              const record = recordOf.get(date)
              const isToday = date === dashboard?.today
              return (
                <span
                  key={date}
                  className={`day${record ? ' present' : ''}${isToday ? ' today' : ''}`}
                  title={date}
                >
                  <span className="day-number">{Number(date.slice(8))}</span>
                  {record && (
                    <span className={`mark${record.starred ? ' gold' : ''}`} aria-hidden="true">
                      {record.starred ? '★' : '✓'}
                    </span>
                  )}
                  <span className="sr-only">
                    {record
                      ? `hadir ${record.localTime}`
                      : isToday
                        ? 'hari ini'
                        : 'tidak hadir'}
                  </span>
                </span>
              )
            })}
          </div>
          <div className="legend">
            <span>
              <b className="mark">✓</b> hadir
            </span>
            <span>
              <b className="mark gold">★</b> 7 hari berturut-turut
            </span>
          </div>
        </section>
      </div>

      <section className="card recap" aria-labelledby="recap-title">
        <div className="recap-head">
          <h2 id="recap-title">Rekap absensi</h2>
          <span className="count">
            {dashboard ? `${dashboard.totalDays} hari tercatat` : '—'}
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th scope="col">Tanggal</th>
              <th scope="col">Jam</th>
              <th scope="col">Zona waktu</th>
            </tr>
          </thead>
          <tbody>
            {!loaded ? (
              <tr>
                <td colSpan={3} className="empty">
                  Memuat rekap…
                </td>
              </tr>
            ) : records.length === 0 ? (
              <tr>
                <td colSpan={3} className="empty">
                  {signedIn
                    ? 'Belum ada catatan bulan ini.'
                    : 'Masuk untuk melihat rekap absensimu.'}
                </td>
              </tr>
            ) : (
              records.map((record) => (
                <tr key={record.localDate}>
                  <td>
                    {dayLabel(record.localDate).replace(/,.*/, '')}
                    <span className="sub">{record.localDate.slice(0, 4)}</span>
                  </td>
                  <td className="mono">{record.localTime}</td>
                  <td>
                    <span className="tz">{record.timeZoneLabel}</span>
                    <span className="sub">{record.timeZone}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <footer className="foot">
        Prototipe absensi harian untuk Freebuff · streak ketat, satu hari bolong
        dihitung ulang dari awal.
      </footer>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
