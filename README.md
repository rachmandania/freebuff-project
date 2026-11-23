# Freebuff Attendance — daily check-in with streaks

An external, self-contained proposal and working reference implementation for a
daily attendance check-in feature for Freebuff, built so the Freebuff team can
review, fork and adopt it into `freebuff.com`.

- **Preview (live now):** https://freebuff-kehadiran-iymkz2-preview.freebuff.site
- **Production address:** https://freebuffcheckinfunction.freebuff.site (reserved in
  Sites, not deployed yet)
- **Author:** Rachmandani Ardiyanto ([@rachmandania](https://github.com/rachmandania))
- **Status:** prototype, sign-in and storage working on the preview environment

## Why

Today attendance is implicit: a day counts only if a prompt is actually
submitted and delivered. That ties a reward streak to the reliability of an
unrelated request.

- When Freebuff is unhealthy, or a prompt fails on the user's side before it is
  sent, nothing reaches the system. The day is lost even though the user showed
  up and tried.
- Losing a day destroys the whole streak, not just that day. One real report: a
  streak of roughly 40 days disappeared because a single prompt never arrived.
- The reward is real. Seven consecutive days unlock extra time in Freebuff, so a
  silently lost day costs the user something they already earned.

So attendance should be its own small, explicit, server-timestamped action,
completely decoupled from prompt delivery:

1. One check-in per local day, recorded whether or not any prompt was sent.
2. Idempotent by design. Retrying after a client-side failure is safe, and a
   duplicate attempt on the same local day is answered, not punished.
3. The streak is derived only from those records, and breaks only when no
   check-in exists for a local day.

One day matters: a streak is what turns daily presence into extra usage time.

The attendance screen is also the natural landing place for a first visit: if a
visitor has no account yet, the check-in button leads straight into account
creation.

## What this repository is

A standalone app demonstrating the complete behaviour end to end:

- Sign in with Freebuff (identity only)
- One check-in per local day, timestamped on the server
- Per-user timezone, so "today" means the user's today
- Strict consecutive streak, with a star at every 7 days
- Month calendar plus a plain date / time / timezone recap table

It is deliberately **not** a patch to the public `CodebuffAI/freebuff`
repository: `CONTRIBUTING.md` there asks contributors not to add backend,
database, billing or deployment code, and this feature is exactly that kind of
change. The intent is for the team to fork this repository and move the small
pieces — schema, rules, endpoints, UI — into the private web app.

## Behaviour

### Check-in

- One button. Check-in only: no check-out, no duration tracking.
- At most one record per user per **local calendar day**.
- The timestamp comes from the server. The browser cannot backdate or replay.
- A second check-in on the same local day is rejected with a friendly message.

### Streak (strict)

- A streak is the number of consecutive local days with a check-in, counted
  backwards from today.
- **Missing a single day resets it.** No grace day, no leave, no weekend
  exception. The next check-in is day 1 again.
- Today does not break a streak before it ends: until midnight in the user's
  timezone, yesterday's streak is still shown as active.
- Every 7th consecutive day (7, 14, 21, …) is rewarded with a star.

### Calendar markers

- `✓` — checked in that day
- `★` — that day completed a 7-day block; this is history and is never erased,
  even if the streak later breaks
- Today is outlined; days without a check-in stay plain

### Recap table

| Date | Time | Time zone |
| --- | --- | --- |
| 24 Nov 2026 | 01:30 | GMT+7 · Asia/Jakarta |
| 23 Nov 2026 | 13:30 | EST · America/Toronto |

The timezone shown is the one in effect **at that check-in**, with the IANA name
next to the label, so the record stays truthful after a user travels or after a
DST change.

### Timezones

- The browser reports `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- The server validates it against the IANA list and derives the local date from
  the UTC instant, so a user in Canada checking in at 23:30 is still on the same
  local day.
- Month boundaries, "today" and streaks are all computed in the user's zone.
- Fallback when missing or invalid: `Asia/Jakarta`.
- Known trade-off: travelling east past midnight can skip a local day and break
  the streak; travelling west can repeat one, which is rejected as a duplicate.
  This is intentional — it is the rule that is hardest to game.

## Screens

One route, `/`:

- **Signed out** — the attendance screen is still visible (empty account card,
  calendar, recap table). A compact **Check in** button sits directly under the
  Freebuff wordmark in the header: signed in it opens the dashboard, signed out
  it goes to Sign in with Freebuff, where an account can be created.
- **Signed in** — account name in the header, the check-in button, the streak
  line directly under it, the month calendar with `✓` / `★`, and the recap
  table. Previous / next month navigation.

The streak line reads, for example: `Streak 3 days · 4 days to ★`,
`Streak 9 days ★`, or `No streak yet · check in today to start`.

No admin panel, no leave requests, no notifications. The layout leaves room for
more cards later.

## Data model (Cloudflare D1)

```sql
CREATE TABLE employees (
  user_id    TEXT PRIMARY KEY,   -- Freebuff user.sub
  email      TEXT,
  name       TEXT,
  timezone   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE attendance_days (
  user_id            TEXT NOT NULL,
  local_date         TEXT NOT NULL,  -- YYYY-MM-DD in the check-in timezone
  checked_in_at      INTEGER NOT NULL, -- server epoch milliseconds (UTC)
  timezone           TEXT NOT NULL,  -- IANA, e.g. Asia/Jakarta
  utc_offset_minutes INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_date)
);

CREATE INDEX attendance_user_date ON attendance_days (user_id, local_date DESC);
```

`PRIMARY KEY (user_id, local_date)` is what enforces one check-in per local day,
including under concurrent requests.

## API contract

Every endpoint requires a signed-in Freebuff session, scopes its queries to
`user.sub`, refuses cross-origin mutations and returns `private, no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/session` | Signed-in user, auth mode, database availability |
| `GET` | `/api/attendance?month=YYYY-MM&timeZone=…` | Month records plus streak state: `today`, `streak`, `hasStar`, `daysToStar`, `checkedInToday`, `totalDays` |
| `POST` | `/api/attendance/check-in` | Body `{ "timeZone": "Asia/Jakarta" }` → `201` with the record and dashboard, or `409` when today is already recorded |

A record carries `localDate`, `localTime`, `timeZone`, `timeZoneLabel`,
`utcOffsetMinutes`, `checkedInAt` and `starred`.

Streak, star markers and local dates are computed on the server. The client
never supplies a date, a time or a streak value.

## How to adopt this in freebuff.com

1. Copy the two tables into the existing database.
2. Move the streak helper (`src/worker/attendance.ts`: consecutive local days,
   strict reset, star at every 7th day) into the server code.
3. Expose the endpoints above, or call the helpers directly from server actions.
4. On first visit, land on the attendance screen; keep a `returnTo` parameter so
   the user goes back where they were after signing in.
5. Where the extra hour is granted today, read the streak and award the hour when
   it reaches a multiple of 7. The award belongs in the billing/quota code —
   this repository only reports the streak.
6. Keep attendance out of the prompt pipeline. Do not infer a check-in from a
   delivered prompt, and never let a failed prompt write or clear attendance:
   prompt delivery and presence are different events with different failure
   modes.

## Scope and honest limits

- This app **cannot add real Freebuff usage**. The streak and the star are
  recorded here; granting the extra hour is only possible inside `freebuff.com`.
- No email, no push notifications, no timezone database of its own.
- Authentication is identity only (Sign in with Freebuff); no passwords stored.
- Attendance is stored per signed-in account and is never shared or public.

## Roadmap ideas (not built)

- Weekly summary and a small "hours earned" history
- Optional exceptions (holidays, approved leave) once the base rule is adopted
- A documented repair path for days lost to a Freebuff-side outage, so a platform
  incident cannot erase a long streak
- Streak recovery or freeze, if the strict rule proves too punishing
- Admin/export view for a team deployment

## Run it locally

```sh
bun install
bun run dev        # http://localhost:3000
bun test           # real D1 through Miniflare
bun run typecheck
bun run build
```

`src/worker/attendance.ts` holds the date, timezone and streak helpers;
`src/worker/app.ts` the API; `src/worker/db.ts` the schema; `src/client/main.tsx`
and `src/client/style.css` the screen.

## Feedback

Open an issue in this repository, or reply on the proposal thread in
`CodebuffAI/freebuff`. Forks are welcome; if the team adopts it, this repository
can be archived in favour of the upstream implementation.
