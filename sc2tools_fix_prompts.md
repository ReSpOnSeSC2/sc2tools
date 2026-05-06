# sc2tools.com — Fix Prompts

QA pass on **2026-05-05** by Claude. The walkthrough exercised every page reachable from the top nav and footer (`/`, `/app` and all 8 sub-tabs, `/builds`, `/builds/<slug>`, `/community`, `/settings` and all 9 sub-tabs, `/admin`, `/download`, `/donate`, `/devices`, `/welcome`, `/legal/privacy`, `/legal/terms`, `/sign-in`, `/sign-up`, `/definitions`), plus the user-menu popover and the theme toggle.

Use each section below as a self-contained prompt — copy the whole block into a coding agent (Claude Code, Cursor, etc.) to fix that one issue without context from the others. Issues are ordered roughly by severity.

---

## 1. Clerk auth is in Development mode on production sc2tools.com

> **Where:** any signed-in page → click the avatar (top-right). The popover footer reads "Secured by Clerk" with an orange **"Development mode"** badge directly underneath.
>
> **What's wrong:** Clerk is using its development instance keys on the production domain. Dev keys have low rate limits, expose test-only behavior, can be hit from anywhere, and are not safe for real users.
>
> **Fix:** swap to the Clerk production-instance keys.
> 1. In the Clerk dashboard, switch the application to its **Production** instance (or create one if it doesn't exist) and copy the production `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
> 2. Update the production environment on Render (frontend + API service) and any Vercel preview that should mirror prod with those values.
> 3. Re-deploy. Confirm by signing in and opening the user popover — the orange "Development mode" badge should be gone.
> 4. Audit any other Clerk-dependent envs (`CLERK_WEBHOOK_SECRET`, allowed origins, OAuth callback URLs) and update them to the production instance equivalents.

---

## 2. PvP build is collecting non-PvP games (classifier matchup gate broken)

> **Where:** `/builds/pvp-custom` (single-matchup PvP build).
>
> **What's wrong:** The build is labeled PvP only, but Recent games include Terran opponents (DuncanTheFat, Marmalade), Top matchups shows "PvT 2-0 100.0%" alongside "PvP 1-0 100.0%", and Vs opponent strategy lists Terran openers (Widow Mine Drop, Cyclone Rush). A single-matchup build should never attach cross-matchup replays.
>
> **Fix:**
> 1. In the classifier service, when assigning a replay to a build, gate the assignment on `replay.matchup === build.matchup` if `build.matchup` is single-matchup (e.g. `PvP`, `PvT`). If `build.matchup` is `Any`, allow all matchups; otherwise, drop the replay from that build's pool.
> 2. Re-run the classifier (or reprocess existing per-build assignments via a one-off migration) so already-misattributed games disappear.
> 3. Audit the aggregation queries that power `/builds/<slug>` (Performance, Vs opponent strategy, Vs map, Top matchups, Recent games) and `/app → Builds` row counts so totals stay consistent post-gate.
> 4. Add a regression test: create a PvP-only build, ingest a PvT replay that uses the same opener moves, assert the replay is **not** counted on that build.

---

## 3. Build modal on `/app → Builds` should match the Opponent dossier (incl. macro breakdown)

> **Where:** `/app → Builds` tab → click any row.
>
> **What's wrong:** Today's modal only shows Performance tiles (Games / Wins / Losses / Win Rate), a Notes textarea, and a Publish-to-community form. Worse, the Performance tiles render blank ("—") even though the source row clearly shows e.g. 17W / 10L / 27 games / 63.0%. Compare to the Opponent dossier (click an opponent row) which is rich: by-map, by-strategy, build tendencies, likely strategies next, median key timings, last-N games.
>
> **Fix:**
> 1. Hoist the surface used by `/builds/<slug>` (Performance, Vs opponent strategy, Vs map, Top matchups, Recent games) into a reusable `<BuildDossier buildId={...} />` component.
> 2. Wire that component into the modal opened from `/app → Builds`. Also use it on the `/builds` (Custom builds) cards so a click opens the same modal — keep the existing `/builds/<slug>` standalone route working, but it can render the same dossier component.
> 3. Bring the dossier to parity with the opponent dossier: add **Macro breakdown** (workers / economy / army / tech timing summary), **Build tendencies / opener fingerprint**, **Likely strategies next**, **Median key timings** (per-matchup tabs), **Last-N games**.
> 4. Keep Personal notes (with Save) and Publish-to-community on the same surface.
> 5. Fix the Performance tiles bug while you're in there — they should pull the same aggregate the parent row uses; they're presumably reading the wrong field or a stale cache key.

---

## 4. Opponent search on `/app → Opponents` does not filter the table

> **Where:** `/app` → Opponents sub-tab → "search opponent name or ID…" input.
>
> **What's wrong:** Typing a name (e.g. "Mediocrelisk") does not filter the opponent table. Two symptoms:
> - When typing fast in a real keyboard session, only the first character ("M") is retained — strongly suggests the input is re-mounting on every keystroke (so React resets state) instead of being a stable controlled input.
> - Setting the input's value programmatically also does not filter the table — confirms the table-level filter is decoupled from the input state.
>
> Compare to `/app → Strategies`, where a similar search filter works correctly.
>
> **Fix:**
> 1. Audit the Opponents tab's component tree. The input should be a controlled component whose state lives in a parent that also renders the table — and that parent should not re-key the input on each render.
> 2. Make sure the table's `useMemo`/filter selector reads the same query state. The Strategies tab is a working reference implementation — copy its pattern.
> 3. Add a small unit/RTL test: type "med", assert table renders only opponents matching the substring on `name` or `pulseId`.

---

## 5. Map identification looks broken — every game lands on "10000 Feet LE"

> **Where:** `/app → Maps` panel "Win rate by map", and `/app → Map intel` listing.
>
> **What's wrong:** Across 128 ladder replays the user has only one distinct map ("10000 Feet LE", 86W-42L-128G-67.2%). That's almost certainly wrong; the user plays current ladder, which has multiple maps in rotation. The Maps tab even has a "Map diagnostic" expander that hints they expect this can go wrong.
>
> **Fix:**
> 1. Open `/app → Maps` → expand "Map diagnostic" — look at the raw distinct map values the agent has uploaded. If everything is collapsing to one label, the agent's `s2protocol` map-name extraction is wrong (e.g. reading the map's first cached entry instead of the per-replay map).
> 2. If the agent is correct and the issue is on the server, check the aggregation pipeline that powers Maps and Map intel — make sure it `groupBy`s on the actual `map.name` field, not a fallback like `defaultMap`.
> 3. After the fix, re-run a parse pass on the existing 128 replays so the historical data updates.
> 4. Add a guardrail metric in `/admin`: if any user has > 50 replays all attributed to one map, flag it for review.

---

## 6. Dashboard Activity tab — empty charts and a description that doesn't match the content

> **Where:** `/app → Activity`.
>
> **What's wrong:** Two issues on the same surface.
> - Subtitle reads *"Per-game charts of resources, army, chrono."* but the panel actually renders "Activity by hour" and "Activity by day of week".
> - Both charts render as empty axes with no plotted bars, despite 128 synced replays carrying timestamps.
>
> **Fix:** pick one of two paths.
> - **Option A (ship what's promised):** build the per-game resources / army / chrono charts. Source data is already in the parsed replay JSON.
> - **Option B (match what's there):** keep the activity-by-hour / activity-by-day-of-week widgets, fix them to populate from `replay.startedAt`, and update the subtitle to match.
>
> Either way, add a smoke test that the chart renders ≥ 1 bar when there are ≥ 1 replays in the dataset.

---

## 7. Settings → Foundation: Email and Agent version display "—"

> **Where:** `/settings → Foundation → Account` card.
>
> **What's wrong:** Email row shows "—" and Agent version shows "—". The session is otherwise authenticated (Cloud user ID populated, Games synced = 128, Latest sync = 2d ago). Email should never be blank for a signed-in user.
>
> **Fix:**
> 1. On the server, read the email straight from the active Clerk session (or from the SC2 Tools `users` collection if you persist it) and feed it into `/api/account/foundation`.
> 2. If you persist it: subscribe to Clerk's `user.created` and `user.updated` webhooks and upsert `email` on the user record.
> 3. For Agent version: if no agent has paired, replace the `—` with the explicit string "Not paired" so it reads as intentional rather than missing data.

---

## 8. Settings → Misc: "Dark (always)" theme preference is ignored on page load

> **Where:** `/settings → Misc → App preferences → Theme handling`.
>
> **What's wrong:** dropdown shows "Dark (always)" but the site renders in light. The top-nav moon/sun toggle works correctly per click — but the persisted preference is not being applied at boot time.
>
> **Fix:**
> 1. The theme provider should hydrate from the persisted preference (DB-backed via `/api/settings`, or `localStorage` if you prefer that for unauth pages) **before** first paint, otherwise you'll get a light-flash followed by dark.
> 2. Make sure changes from the top-nav toggle update both the persisted preference and the in-memory theme state, so this dropdown stays in sync.
> 3. Add a Cypress/Playwright test: set `theme = dark`, reload, assert the `<html>` element has the `data-theme="dark"` attribute on initial render.

---

## 9. Settings: "Edits stay in draft until you save" but no Save button exists on edit-capable tabs

> **Where:** `/settings → Profile` (and any other tab with editable inputs). The page header reads *"Edits stay in draft until you save."*
>
> **What's wrong:** Profile has five editable inputs (Display name, BattleTag, Pulse ID, Region, Preferred race) and zero Save / Discard affordance.
>
> **Fix:** pick one model and apply it consistently.
> - **Option A — explicit save:** add a sticky-footer Save / Discard pair that activates when the form is dirty. Keep the "Edits stay in draft until you save" copy.
> - **Option B — auto-save:** auto-save on field blur with a small "Saved" toast, and remove the "until you save" wording from the page header.

---

## 10. Build detail `/builds/<slug>`: Recent games' MACRO column is always empty

> **Where:** `/builds/pvp-custom` (and any other build detail page) → Recent games table.
>
> **What's wrong:** Every row's MACRO cell shows "—" even though we have classified strategies, opponent, length, and Win/Loss for each replay.
>
> **Fix:** either (a) populate MACRO with the per-replay macro summary the agent already extracts (workers / economy / army / tech timing), or (b) hide the column conditionally until the agent emits that field, so it doesn't read as broken.

---

## 11. /devices: connected devices have no labels and no way to unpair

> **Where:** `/devices` → Connected devices list.
>
> **What's wrong:** Each row shows only "Paired <date>, <time> · last seen <date>, <time>". No hostname, OS, agent version, or nickname; no Unpair / Revoke action. With four devices listed, you can't tell which is which, and a stolen pairing can't be ejected.
>
> **Fix:**
> 1. Have the agent send a registration payload at pair time: hostname (or a fingerprint hash if privacy-sensitive), OS string, agent version. Persist on the device record.
> 2. Render a label per row: `<hostname> · <os> · v<agentVersion>` — fall back to `<os> · v<agentVersion>` if hostname is missing.
> 3. Add a per-row "Unpair" button. On confirm, call `DELETE /api/devices/:id`, invalidate that device's pairing token, and remove the row.
> 4. Optional: let the user rename a device to a friendlier nickname.

---

## 12. Email/identity mismatch between Clerk and SC2 Tools profile

> **Where:** Avatar popover identifies the user as "Jonathan Layman / responsesc2"; `/settings → Foundation → Email` is empty; the Cowork session reports the user's email as `jay1988stud@gmail.com`.
>
> **What's wrong:** The SC2 Tools user record is not mirroring the Clerk identity. This is upstream of issue #7 — fixing this fixes the empty Email field too.
>
> **Fix:** add (or repair) the Clerk → SC2 Tools sync. Subscribe to `user.created` / `user.updated` / `email.created` Clerk webhooks. On each event, upsert the SC2 Tools `users` document by Clerk `userId`, populating `email`, `displayName`, and `avatarUrl`. Backfill once for existing users by enumerating the Clerk user list.

---

## Notes on what was tested and not flagged

These pages and features were reached and behaved correctly: the home carousel, drop-replay demo, dashboard summary tiles (Games today / Win rate / Active streak / Total games), Strategies search + Heatmap/Table toggle + min-games chips, Trends charts, DNA opponent fingerprint cards + key-timings detail, Map intel detail (empty by design — "agent needs to re-analyse replays"), Builds search filter, Custom builds page (search, sort, race/matchup chips, "Hide empty" toggle, New build modal), Definitions reference page, Community builds page (empty state), Settings → Folders / Import / Builds / Overlay / Voice / Backups, Admin moderation queue (empty), Download page (Win/macOS/Linux tabs + SHA-256 + release notes expander), Donate page, Welcome onboarding step 1→2, Privacy Policy, Terms of Service, signed-in redirect from `/sign-up` and `/sign-in` to `/app`, top-nav theme toggle (live), and the user popover (Manage account / Sign out).
