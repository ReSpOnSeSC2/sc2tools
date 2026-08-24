# Coaching Locker × sc2tools.com × Agent — integration plan

Goal: the Locker is reachable through the site without being advertised, and the
SC2 Tools agent feeds it. Three phases; each is useful on its own.

## Phase 0 — today (no site changes)

- The Locker lives at its artifact URL; students get it by share-link.
- Agent data flows in by file: `agent_sync.py` (this folder) turns replays or the
  engine's `parsed.jsonl` into a `locker-sync-<student>.json`; **Inbox → Import
  agent sync** fills the admission lanes, marks the agent connected, stamps the sync.
- Replay shelf items and build references **link into sc2tools.com replay pages**
  instead of carrying files — the DB is the source of truth; uploads are the
  fallback for students without the agent.

## Phase 1 — quiet site access (a day of work)

- Add a Clerk-gated route `apps/web/app/coaching/page.tsx` that renders nothing
  unless the signed-in user has `coaching: true` (you) or `coachingStudent: true`
  in Clerk `publicMetadata`. Authorized users get a full-height iframe (or plain
  redirect) to the Locker URL. Everyone else 404s.
- **Student selection is an admin UI, not dashboard fiddling**: an admin page at
  `/coaching/admin` (renders only for `coaching: true`) lists your site's users —
  Clerk's `users.getUserList()` with a search box — each row with a "Student"
  toggle. Toggling calls a small API route that sets/clears `coachingStudent: true`
  on that user via `clerkClient.users.updateUserMetadata()`. Pick a user, they're
  a student; untoggle, access is gone. Capacity guard: the toggle disables at 6.
- Discoverability stays low: one "Coaching" item in the account dropdown, rendered
  only for flagged users. No nav link, no landing page, no pricing page.

## Phase 2 — native + agent-live (the real product feature)

- Move Locker state into Mongo (`coaching_students` collection mirrors the JSON
  the Locker already keeps; the import/export backup file is the migration).
- API endpoints (Express, coach-scoped):
  - `GET  /api/coaching/students/:id/season-summary` → lanes + latest game + MMR
    (computed from replays the student's agent already uploads — this replaces
    `agent_sync.py`).
  - `GET  /api/coaching/students/:id/replays?window=since-last-session` → list with
    build classification, for one-click "link replay" pickers instead of pasted URLs.
- Student linking: student signs into sc2tools.com, coach enters their account
  e-mail; their agent uploads then attribute to the coaching record automatically.

## Agent-powered features this unlocks (roadmap candidates)

(Per the product decision: no automated grading or scoring of student games,
ever — the agent supplies *facts* (which games, which build, when); every
judgment is the coach's.)

1. **Session-prep digest** — from the sync: games played since last session,
   which builds they were, which replays are new — your watch-list assembles
   itself; the opinions stay yours.
2. **In-game assignment overlay** — the OBS overlay product gains a coaching
   widget: current assigned build + its next benchmark, on stream/second monitor
   while the student plays.
3. **Tilt guard** — the agent sees queue cadence; flag 3+ rapid re-queues after
   losses against the practice protocol ("stop rule") in the weekly note.
4. **Opponent prep** — for a student's tournament match, the opponent-intel
   dossier (builds, timings, per-map records) drops onto their shelf as a card.
5. **Map/veto plans** — per-student per-map win rates from their own synced games
   → a generated veto recommendation the coach approves before it publishes.
6. **Cohort patch report** — after each balance patch, one summary across all
   students' games: which assigned builds moved, what the library refresh changed.
7. **Auto lane upkeep** — season rollover reclassifies every student's basis
    (active→bridge) with zero coach effort; receipts update everywhere.

Keep Phase 2 behind the same quiet flags — coaching stays a boutique feature of
the product, not a marketing surface, until you decide otherwise.
