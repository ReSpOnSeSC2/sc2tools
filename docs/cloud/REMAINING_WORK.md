# SC2 Tools cloud — what's left

Companion to [`CLOUD_SAAS_ROADMAP.md`](../../CLOUD_SAAS_ROADMAP.md).
This file lists ONLY the work still to do after commit `28daa7b`
(the cloud foundation drop). Everything not in this file is done.

The original roadmap estimated 17–20 weeks part-time. Roughly **40%
of the engineering surface area** has shipped. The work below is the
remaining ~60% — feature-parity port, polish, and launch-readiness.

---

## Status at a glance

| Stage | Title                          | Status        |
| ----- | ------------------------------ | ------------- |
| A     | Foundation                     | done — code; account-side steps are user-only (see below) |
| B     | Schema + data migration        | done — code |
| C     | Backend route migration        | done — code; SPA-side consumers still pending (Stage E) |
| D     | Local agent                    | done — code; signed installer requires user-supplied EV cert |
| E     | Frontend on Vercel             | **~25% — landing/auth/devices/overlay done; analyzer port incomplete** |
| F     | Realtime push                  | done — code |
| G     | Hosted OBS overlay             | **~20% — token + page wired; widgets not ported** |
| H     | Community features             | not started |
| I     | Billing (optional)             | not started |
| J     | Migrate existing local users   | not started |
| K     | Hardening for launch           | not started |

"done — code" means the code is committed and tested. The user-facing
account/domain steps in `docs/cloud/SETUP_CLOUD.md` are still required
to bring the live system online.

---

## A — Foundation: account setup tasks

The code side is done. You still need to do these manually:

- [ ] Buy the domain (`sc2tools.app` recommended)
- [ ] Create the Clerk application + Google OAuth
- [ ] Provision the Render web service from `apps/api/render.yaml`
- [ ] Create the `sc2tools_saas` MongoDB Atlas database
- [ ] Vercel project pointing at `apps/web/`
- [ ] Wire env vars in Render + Vercel per `.env.example`
- [ ] Confirm `/v1/health` returns 200 and `/sign-in` loads

Walkthrough: [`docs/cloud/SETUP_CLOUD.md`](SETUP_CLOUD.md).

---

## B — Schema + data migration

- [ ] **`docs/CLOUD_SCHEMA.md`** — write a doc describing each
  collection's document shape, the indexes, and the hot queries each
  index serves. Auto-generate from `apps/api/src/db/connect.js`.
- [ ] **`tools/migrate-to-cloud/`** — Node CLI that reads
  `data/MyOpponentHistory.json` + `data/meta_database.json` and
  upserts every record into the user's cloud account. Requirements:
  - Dry-run mode (`--dry-run`) that prints a summary without writing
  - Comparison report (local count vs cloud count after)
  - Resume-friendly: keys on `gameId` + `pulseId`, never duplicates
  - Reads a Clerk-issued personal token from a CLI prompt (the user
    pastes one from `clerk.com/dashboard → API keys → personal`)
- [ ] **Schema versioning hook** — extend the existing
  `lib/schema_versioning.js` pattern from the local app to the cloud
  collections so a future format change can roll forward safely.
- [ ] **Atlas backups + connection alerting** (5-min job in Atlas UI)

Estimated: 1 week part-time.

---

## C — Backend route migration (the big one)

`reveal-sc2-opponent-main/stream-overlay-backend/analyzer.js` is 3,500
lines of business logic. Roughly 1/4 has been ported to `apps/api/`.
The rest is a methodical port — same response shapes, MongoDB-backed
instead of in-memory.

### Routes already ported (under `/v1/`)

- `/me`, `/opponents`, `/opponents/:pulseId`
- `/games`, `/games/:gameId`, POST `/games`
- `/custom-builds` (CRUD)
- `/device-pairings/*`, `/devices`
- `/overlay-tokens`

### Routes NOT yet ported

Each of these needed a service + route + tests in `apps/api/`. Done:

- [x] `GET /v1/summary` — `AggregationsService.summary` (`$facet`)
- [x] `GET /v1/builds` — `BuildsService.list`
- [x] `GET /v1/builds/:name` — `BuildsService.detail`
- [x] `GET /v1/opp-strategies` — `BuildsService.oppStrategies`
- [x] `GET /v1/build-vs-strategy` — `AggregationsService.buildVsStrategy`
- [x] `GET /v1/maps` — `AggregationsService.maps`
- [x] `GET /v1/matchups` — `AggregationsService.matchups`
- [x] `GET /v1/random-summary` — `AggregationsService.randomSummary`
- [x] `GET /v1/timeseries` — `AggregationsService.timeseries`
- [x] `GET /v1/games/:gameId/build-order` — pure JS parse of the
  stored `buildLog` (no Python needed)
- [x] `POST /v1/games/:gameId/opp-build-order` — agent writeback or
  recompute request
- [x] `POST /v1/games/:gameId/macro-breakdown` — agent writeback or
  Socket.io recompute request
- [x] `GET /v1/games/:gameId/apm-curve` — read stored series
- [x] `POST /v1/macro/backfill/start` + `GET /v1/macro/backfill/status`
  — `MacroBackfillService` (per-user job in `macro_jobs`)
- [x] `GET /v1/spatial/{maps,buildings,proxy,battle,death-zone,opponent-proxies}`
  — `SpatialService` (Mongo aggregations + scipy KDE via
  `scripts/spatial_cli.py`, with a JS bin-counter fallback)
- [x] `GET /v1/catalog`, `GET /v1/export.csv` — `CatalogService` (CSV
  is a streaming generator capped at `LIMITS.CSV_EXPORT_MAX_ROWS`)
- [x] `POST /v1/import/{scan,start,cancel,extract-identities,pick-folder}`,
  `GET /v1/import/{status,cores,jobs}` — `ImportService` relays to the
  agent over Socket.io and tracks lifecycle in `import_jobs`
- [x] `GET /v1/definitions` — bundled JSON
- [x] ML routes: `/v1/ml/{status,train,predict,pregame,options}` —
  `MLService` shells out to `scripts/ml_cli.py`, persists model blobs
  in `ml_models`
- [x] `GET /v1/map-image`, `GET /v1/playback` (501 stub for the latter
  since playback requires the user's local SC2 install)

### Service-layer scaffolding for those routes — done

Each bucket is now an explicit service in `apps/api/src/services/`:

1. **Aggregations bucket** — `AggregationsService` issues `$facet`
   pipelines for summary / matchups / maps / build-vs-strategy /
   random-summary / timeseries / games-list.
2. **Per-game compute bucket** — `PerGameComputeService` parses the
   stored `buildLog` arrays in pure JS (no Python required) and reads
   stored macro / apm payloads. Recompute requests are emitted to the
   agent's Socket.io room — the agent owns the .SC2Replay file.
3. **Import bucket** — `ImportService` is a coordinator: it relays
   `import:scan_request` / `import:start_request` / etc. to the user's
   agent and tracks job lifecycle in `import_jobs`. The agent runs
   `scripts/bulk_import_cli.py` locally.
4. **ML bucket** — `MLService` shells out to `scripts/ml_cli.py` (which
   is bundled in the Render image at `/opt/sc2-analyzer`), persists
   the resulting model blob in `ml_models`, and serves predict /
   pregame from it.
5. **Spatial + map bucket** — `SpatialService` runs Mongo aggregations
   plus an optional `scripts/spatial_cli.py` KDE pass. Falls back to
   a pure-JS bin counter when scipy is unavailable.

Each bucket has a router under `apps/api/src/routes/` and a unit-test
file under `apps/api/__tests__/`. The integration suite at
`__tests__/routes.integration.test.js` exercises the full HTTP wiring
end-to-end against an in-process MongoDB Memory Server.

### Dockerfile: Python toolchain — done

`apps/api/Dockerfile` is now a two-stage build:

* **stage 1** (`python:3.12-slim-bookworm`) installs the analyzer's
  Python deps into a venv at `/opt/sc2-py`.
* **stage 2** (`node:22-bookworm-slim`) copies that venv plus the
  `SC2Replay-Analyzer/` source to `/opt/sc2-analyzer` and runs the
  Express API.

`render.yaml` was updated to build with `dockerContext: .` (the repo
root) so the COPY of `SC2Replay-Analyzer/` resolves. Two new env vars
— `SC2_PY_PYTHON` and `SC2_PY_ANALYZER_DIR` — point the runner at the
prebuilt venv and analyzer source.

---

## D — Local agent (finishing touches) — done

The agent went from "runs from source" to "shippable .exe with tray
polish + auto-update + crash reporting" in this drop. Stage status:

- [x] **Signed Windows installer.** `apps/agent/packaging/installer.nsi`
  is a per-user (no-admin) NSIS installer that drops the EXE under
  `%LOCALAPPDATA%\sc2tools`, registers a Startup-folder shortcut, and
  writes an Add/Remove Programs entry.
  `apps/agent/packaging/build-installer.ps1` runs the full pipeline
  (PyInstaller → NSIS → optional `signtool`).
  *(Account-side: the EV code-signing certificate purchase is the only
  step that still needs the user — pass `-SigningCert path\to\cert.pfx`
  to the build script and the SHA-256 / timestamp dance is handled.)*
- [x] **Auto-update flow.**
  - `GET /v1/agent/version` returns the latest release for the agent's
    channel + platform with `update_available`, `latest`, `releaseNotes`,
    SHA-256, and download URL (see Stage C: AgentVersionService).
  - `apps/agent/sc2tools_agent/updater.py` polls on startup + every
    12h, downloads to `%TEMP%`, verifies the SHA-256, and either
    launches the installer (frozen .exe) or records the latest version
    seen in `state.json` (source-run).
- [x] **Tray UX polish.** Multi-line tooltip (status / last upload /
  watching path) plus menu items: Open dashboard, Pause/Resume syncing
  (persisted in `state.paused`), Open log folder, Re-sync from scratch,
  Choose replay folder…, Check for updates.
- [x] **Crash reporter.** `crash_reporter.py` wires Sentry SDK with a
  redaction filter that scrubs battle-tag / display-name / token keys
  from event dicts and replaces `C:\Users\<user>\…` with `<user-home>`
  in any string. Disabled when `SC2TOOLS_SENTRY_DSN` is unset.
- [x] **Replay-folder reconfig UI.** Tray's "Choose replay folder…"
  opens the native tk folder picker on a daemon thread; the picked
  path is stored in `state.replay_folder_override` and the watcher
  re-discovers roots on its next sweep.
- [ ] **Windows service mode.** Skipped per the original recommendation
  — Startup-folder shortcut is fine and the tray icon survives.
- [ ] **macOS / Linux builds.** Deferred until someone asks. The
  updater + crash reporter + watcher already work cross-platform; only
  the NSIS installer and the .pfx code-signing path are Windows-only.

---

## E — Frontend on Vercel (analyzer port)

The marketing pages, auth, devices, streaming, builds, and overlay
shells are all done. The analyzer SPA itself
(`reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/`)
is 38 React components, single-file babel-standalone, ~6,000 lines of
JSX. Each one needs to be lifted to `apps/web/components/` as a
proper ES module.

### Components NOT yet ported

(File names from `public/analyzer/components/`.)

- [ ] `tabs-opponents.jsx` (currently a simplified version exists in
  `OpponentsList.tsx`; needs the full filters, search, sort, drilldown)
- [ ] `tabs-strategies.jsx`
- [ ] `tabs-trends.jsx`
- [ ] `tabs-maps-matchups.jsx`
- [ ] `tabs-ml-core.jsx`, `tabs-ml-predict.jsx`
- [ ] `builds-tab.jsx` (separate from the simpler `BuildsPanel.tsx`
  this commit added — that's just the user's personal library; this
  is the full builds analytics tab)
- [ ] `build-editor-modal.jsx` + helpers
- [ ] `build-order-timeline.jsx`
- [ ] `chart-army-resource.jsx`, `chart-chrono-spending.jsx`,
  `chart-game-detail.jsx`, `chart-macro-breakdown.jsx`,
  `chart-resources.jsx` (all use Recharts)
- [ ] `activity-charts.jsx`
- [ ] `opponent-dna-grid.jsx` + `opponent-dna-timings-drilldown.jsx`
- [ ] `map-intel-tab.jsx` + `map-intel-viewer.jsx`
- [ ] `doctor-banner.jsx` + `empty-states.jsx`
- [ ] **Settings shell + 7 sub-pages**:
  `settings-{shell,foundation,backups,builds,folders,misc,overlay,profile,voice,import-panel}.jsx`
- [ ] **Wizard flow**: `wizard-{shell,foundation,steps-early,integrations,streamlabs,apply-import}.jsx`

### Port pattern (one component at a time)

For each `.jsx`:

1. Drop the `(function () { ... })()` IIFE wrapper and
   `Object.assign(window, {...})` exports
2. Add `'use client'` at the top
3. Convert default React.createElement / JSX-via-babel to real JSX
4. Replace `useApi('opponents', ...)` calls with the new
   `apps/web/lib/clientApi.ts#useApi` SWR hook — it auto-injects the
   Clerk JWT
5. Pin Recharts to a known good version in `apps/web/package.json`
6. Manual smoke test against your data; commit one component at a time

Estimated: 0.5–1 day per component × ~38 components = 4–6 weeks part-time.
This is the largest remaining bucket.

---

## F — Realtime push

The code is in. The remaining work is operational:

- [ ] **Sticky-session config in Render.** Set `Session Affinity = on`
  in service settings so socket connections don't bounce between
  instances when you scale beyond one dyno.
- [ ] **Socket.io reconnect UX.** Currently the SyncStatus dot just
  goes grey on disconnect; should show "reconnecting…" with a
  retry-count after 3 failures.
- [ ] **Heartbeat ping** on the agent's socket (if we ever give the
  agent a long-lived connection) so the cloud knows the agent is up.
  Currently the agent only POSTs; no socket.

Estimated: 2–3 days part-time.

---

## G — Hosted OBS overlay (widget port)

The token-issuance flow + the `/overlay/[token]` page shell are in.
Each individual widget needs to be ported from
`reveal-sc2-opponent-main/SC2-Overlay/widgets/*.html` to a React
component under `apps/web/app/overlay/[token]/widgets/`.

### Widgets to port

- [ ] `opponent.html` (pre-game dossier — highest priority)
- [ ] `match-result.html` (post-game W/L card)
- [ ] `post-game.html` (post-game build summary)
- [ ] `mmr-delta.html`
- [ ] `streak.html`
- [ ] `cheese.html`
- [ ] `rematch.html`
- [ ] `rival.html`
- [ ] `rank.html`
- [ ] `meta.html`
- [ ] `topbuilds.html`
- [ ] `fav-opening.html`
- [ ] `best-answer.html`
- [ ] `scouting.html`
- [ ] `session.html`

### Backend wiring

- [ ] `POST /v1/overlay-events/live` — agent forwards the live-parse
  payload (the same shape `apps/agent/sc2tools_agent/replay_pipeline.py`
  builds) to the cloud. Cloud broadcasts to the overlay's
  socket room (`overlay:<token>`).
- [ ] **Per-overlay rate limit** so a leaked token can't DoS.
- [ ] **Configurable widget toggle** in `/streaming` UI — let the user
  hide/show individual widgets per overlay token.

Estimated: 1.5–2 weeks part-time (most widgets are small; the
infrastructure for one applies to all).

---

## H — Community features (Stage 14 of MASTER_ROADMAP)

Not started. Pulls from the existing `cloud/community-builds/`
service.

- [ ] Public `/builds/<slug>` pages (server-rendered for SEO) for
  user-published custom builds
- [ ] "Publish to community" toggle in the personal builds editor
- [ ] Aggregated opponent profiles `/opponents/<pulseId>` —
  k-anonymity protected (drop names, show race/openings/win rate
  across all users who faced this pulseId)
- [ ] Community moderation: report/flag flow on shared builds, admin
  dashboard at `/admin` (gated by Clerk role)
- [ ] Optional: Discord bot that posts new community builds to a
  channel

Estimated: 1.5–2 weeks part-time.

---

## I — Billing (entirely optional)

The roadmap noted you're going donation-only via Streamlabs to start.
Skip unless / until you're ready to charge.

- [ ] Stripe Checkout for Pro tier
- [ ] `/v1/entitlements` endpoint that returns the user's plan
- [ ] Feature-gate routes that should be Pro-only (e.g. ML predict)

Estimated: 1 week part-time when triggered.

---

## J — Migrate existing local users

- [ ] **In-app banner** in the existing local SPA: "Cloud is live —
  migrate your data to keep using SC2 Tools." Links to a hosted
  migration page.
- [ ] **`/migrate` page in apps/web/** that:
  1. Asks the user to launch their local app
  2. POSTs to a one-shot `/migrate` route the local Express exposes
     for 5 minutes after the page loads
  3. Streams the local `meta_database.json` + `MyOpponentHistory.json`
     to the cloud's `tools/migrate-to-cloud/` endpoint
  4. Shows a progress bar + final reconcile report
- [ ] **Deprecation timer** in the local app — after 6 months of
  cloud-having-launched, the local Express prints a deprecation
  warning and disables write paths. Reads still work for the next
  6 months. Then archive.

Estimated: 1 week part-time.

---

## K — Hardening for launch

- [ ] **Sentry** on both Vercel + Render with source maps uploaded
- [ ] **Render autoscaling** + healthcheck pointing at `/v1/health`
- [ ] **MongoDB Atlas alerts** on connections > 80% of plan, on
  replication lag, on backups failing
- [ ] **Cloudflare WAF** in front of `api.sc2tools.app` for DDoS / bot
  protection
- [ ] **Privacy policy + ToS** at `/legal/{privacy,terms}` — get a
  template from a service like Termly
- [ ] **Cookie consent banner** (use the same Termly template)
- [ ] **Status page** at `status.sc2tools.app` (Better Uptime free tier)
- [ ] **GDPR data export** at `/account → Export my data` — bundles
  the user's games + opponents + builds as JSON in a zip
- [ ] **GDPR account deletion** at `/account → Delete account` that
  wipes from every collection
- [ ] **Load test**: simulate 50 concurrent agents uploading replays;
  confirm Render + Mongo handle it without > 1s p95
- [ ] **Penetration smoke test**: run OWASP ZAP against the staging
  deploy; address any high-severity findings

Estimated: 2 weeks part-time.

---

## Suggested order

The shortest path to "friend uses cloud SaaS without complaining"
goes through these in order:

1. **Setup** (A account-side) — half a day
2. **Backend aggregations bucket** (C bucket 1) — 1 week
3. **Frontend opponents/builds tabs full port** (E top 6 components)
   — 1 week
4. **Migration script** (B + J together) — 1 week
5. **Backend per-game compute bucket** (C bucket 2) — 1 week
6. **Frontend chart components** (E remaining) — 2 weeks
7. **Overlay widgets** (G all 15) — 1.5 weeks
8. **Hardening** (K) — 1 week before public launch

That's ~8.5 weeks part-time to "feature parity + launch ready."

Add ML port + community features afterward as standalone PR series.
Add billing only when you're ready to charge.

---

## Cross-references

- [`CLOUD_SAAS_ROADMAP.md`](../../CLOUD_SAAS_ROADMAP.md) — original
  multi-stage plan
- [`docs/cloud/SETUP_CLOUD.md`](SETUP_CLOUD.md) — account / domain
  setup walkthrough
- [`apps/api/README.md`](../../apps/api/README.md) — current route
  reference
- [`apps/web/README.md`](../../apps/web/README.md) — frontend dev
  notes
- [`apps/agent/README.md`](../../apps/agent/README.md) — agent
  architecture
