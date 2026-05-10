# Debug & fix: "Games today" / opponent "X ago" use UTC instead of user's local timezone

## Symptom (reproduced on prod, sc2tools.com/app)

A user in roughly UTC‑5 (US Central‑ish) opens the Analyzer at 21:43 local
on 2026‑05‑09. They've played several games during the day. The UI shows:

- **Games today: 0** with hint "No games yet today" — even though replays
  were synced 5 hours ago (the page header says `11713 games synced · last
  5 hr ago`).
- The **Opponents** table's "Last" column shows `1d ago` and `2d ago` for
  matchups they actually played earlier today local time.
- The Date Range picker correctly displays `… → 5/9/2026` (so *some*
  date logic is local‑aware, which makes the bug feel inconsistent).

UTC has already rolled over to 2026‑05‑10, so any "today" bucket computed
in UTC is empty until ~19:00 local.

## Why it happens (root cause already located — verify before changing)

The dashboard frontend *does* pull a timezone:

- `apps/web/components/analyzer/DashboardKpiStrip.tsx:87`
  `const tz = useMemo(() => clientTimezone(), []);`
- `apps/web/components/analyzer/DashboardKpiStrip.tsx:107-108, 333-340`
  `computeGamesToday(apiToPeriods(globalSeries.data, tz), tz)` looks up
  `todayKeyIn(tz)` against series buckets re‑keyed via
  `localDateKey(p.bucket, tz)` (`apps/web/lib/timeseries.ts:58, 75`).

But the **API aggregates the global series by UTC day**, so each API
bucket's `bucket` field is a UTC midnight ISO. `localDateKey` then shifts
that UTC midnight into local — which means a single local day's games are
split across two API buckets and neither lines up with `todayKeyIn(tz)`.
A game played at 17:00 local (22:00 UTC same day) and one at 21:00 local
(02:00 UTC next day) end up in different UTC buckets even though they're
the same local day, and the local‑day key for "today" misses both.

The Activity Calendar already solves this correctly — use it as the
reference pattern:

- `apps/api/src/services/trendsAggregations.js:236-276` (esp. line 245)
  `$dateTrunc: { date: "$date", unit: "day", timezone }` where
  `timezone` is an IANA zone (e.g. `America/Chicago`) sent by the client.
- Frontend caller: `apps/web/components/analyzer/charts/ActivityCalendarChart.tsx:47-60`
  passes `tz=<IANA>` as a query param.

The Opponents list has the **same class of bug** in a different spot:

- `apps/api/src/services/opponents.js:172`
  `lastPlayed: { $max: "$date" }` — raw UTC max, no tz awareness. The
  value is then formatted by `fmtAgo` (`apps/web/lib/format.ts:14-24`)
  which is fine on its own — the problem is upstream.
- `apps/api/src/routes/opponents.js` already accepts a `tz` query param
  (~line 164) but does **not** forward it into `_listFiltered`. The
  unfiltered path reads the stored `lastSeen` (also UTC) on the opponents
  collection.

## What to fix

Make every "today / day bucket / X ago" path use the user's IANA
timezone end‑to‑end. Concretely:

1. **Dashboard "Games today" / global timeseries**
   - Find the API route that powers `globalSeries` in
     `DashboardKpiStrip.tsx` (search for what `useGlobalSeries` /
     similar hits — likely under `apps/api/src/routes/` and
     `apps/api/src/services/`).
   - Add a `tz` query param (IANA, validated; fall back to `UTC` if
     missing/invalid).
   - Replace whatever groups by date with a `$dateTrunc` (or equivalent)
     that takes `timezone: tz`. Mirror the pattern at
     `trendsAggregations.js:236-276`.
   - Have the frontend pass `clientTimezone()` to that fetch.
   - Confirm `computeGamesToday` in `DashboardKpiStrip.tsx:333-340` no
     longer needs `localDateKey` re‑keying — buckets should already be
     local‑day ISO strings from the API.

2. **Opponents `lastPlayed` / "X ago"**
   - In `apps/api/src/routes/opponents.js`, forward `tz` from the query
     into `deps.opponents.list(...)`.
   - In `apps/api/src/services/opponents.js`:
     - `_listFiltered` (~lines 146-213): when computing
       `lastPlayed: { $max: "$date" }` is fine for "most recent
       timestamp," but the *bucket* used for sorting / grouping by day
       must be timezone aware. The `$max` itself returns a UTC
       timestamp — that's correct; `fmtAgo` will compute hours/days
       between two real instants regardless of zone, so the "1d ago"
       symptom must come from a different source. Verify by reading
       the actual response payload. Two possibilities to check:
       a. `o.lastPlayed` / `o.lastSeen` is being truncated to a date
          before being returned (look for `toDateString()`,
          `setHours(0,0,0,0)`, `$dateTrunc` without time, or any
          `YYYY-MM-DD` formatting on the way out).
       b. The unfiltered path (`list` ~lines 101-122) returns a
          stored `lastSeen` that was written at game‑ingest time,
          and ingestion truncated it. Check
          `apps/api/src/services/opponents.js:449, 456` and the
          ingest in `apps/api/src/services/games.js:83-86, 769-779`.
   - Whichever of (a) or (b) is true, fix it so the value sent to the
     client is a full ISO instant (not a date‑only string), and so any
     "is this today?" decision uses the user's `tz`.

3. **Audit other "today" callsites**
   - `grep -rn "todayKeyIn\|setHours(0, 0, 0, 0)\|toISOString().*split\|toDateString\|\\$dateTrunc" apps/`
     and confirm every result either uses the user's IANA tz or is
     intentionally UTC (e.g. a server‑side cron). The ones to scrutinize:
     trends aggregations (already correct — use as reference), date
     presets at `apps/web/lib/datePresets.ts`, KPI strip, opponents,
     dashboard streak.
   - Specifically check the **Active Streak** card (same component) and
     anything labeled "today / yesterday".

4. **Server `tz` validation**
   - When accepting `tz` from the client, validate with
     `Intl.DateTimeFormat(undefined, { timeZone: tz })` in a try/catch,
     reject unknown zones, and default to `UTC`. Don't trust raw
     query strings as Mongo `timezone` values.

## How to verify the fix

Add a small reproduction test before changing code so the regression
can't sneak back:

1. **Unit / integration**: in `apps/api/__tests__/`, add a test that
   inserts two games — one at `2026-05-09T22:00:00Z` (17:00 local
   America/Chicago) and one at `2026-05-10T02:00:00Z` (21:00 local
   America/Chicago) — and asserts that the global timeseries with
   `tz=America/Chicago` returns a single bucket for `2026-05-09` with
   `games: 2`. Without the fix this should split across two buckets.
2. **Opponents**: insert a game at `2026-05-10T02:00:00Z`,
   `tz=America/Chicago`, current time mocked to
   `2026-05-10T02:43:00Z` (21:43 local). Assert the API response's
   `lastSeen` round‑trips through `fmtAgo` to "Xh ago", not "1d ago".
3. **Manual smoke (browser)**: in DevTools, run
   `Intl.DateTimeFormat().resolvedOptions().timeZone` to confirm the
   browser tz, then hit the page near local midnight (or override
   with `process.env.TZ` server‑side and `--tz` Chrome flag) and
   verify "Games today" matches the games you just inserted.
4. **Cross‑zone sanity**: load the same account with
   `?tz=Pacific/Auckland` (UTC+12) vs. `?tz=Pacific/Honolulu`
   (UTC‑10) at the same instant and confirm the "today" counts make
   sense for each — they should differ by up to one day.

## Constraints / non‑goals

- Don't change how games are *stored* (UTC instants in Mongo is
  correct). Only change how they're **bucketed for display**.
- Don't introduce a new date library; the codebase already has
  `Intl.DateTimeFormat` helpers in `apps/web/lib/timeseries.ts` and
  Mongo's `$dateTrunc` server‑side. Use those.
- No backwards‑compat shim for missing `tz` — server defaults to
  `UTC` and the client always sends one.
- Keep the diff focused on the two endpoints (global timeseries +
  opponents). Don't refactor unrelated trends code.

## Deliverable

A PR on branch `claude/fix-timezone-game-dates-FhawA` containing:
- API change(s) so global timeseries and opponents list accept and
  honor an IANA `tz`.
- Frontend change(s) so both fetches send `clientTimezone()`.
- The two regression tests above.
- A short note in `CHANGELOG.md` under the next version: *"fix: Games
  today, opponent 'X ago', and dashboard streak now use the viewer's
  local timezone instead of UTC."*
