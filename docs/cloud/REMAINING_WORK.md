# SC2 Tools cloud — what's left

Companion to [`CLOUD_SAAS_ROADMAP.md`](../../CLOUD_SAAS_ROADMAP.md).
This file lists ONLY the work still to do after commit `28daa7b`
(the cloud foundation drop). Everything not in this file is done.

The original roadmap estimated 17–20 weeks part-time. With stages
B–G now complete in code, roughly **85% of the engineering surface
area** has shipped. The remaining work is account-side setup (A),
the migration tool for existing local users (J), launch hardening
(K), and the optional Community / Billing buckets (H, I).

---

## Status at a glance

| Stage | Title                          | Status        |
| ----- | ------------------------------ | ------------- |
| A     | Foundation                     | done — code; account-side steps are user-only (see below) |
| B     | Schema + data migration        | done — code |
| C     | Backend route migration        | **~25% — base routes done, aggregations not ported** |
| D     | Local agent                    | **~70% — runs from source; no signed binary, no auto-update** |
| E     | Frontend on Vercel             | done — code |
| F     | Realtime push                  | done — code |
| G     | Hosted OBS overlay             | done — code |
| H     | Community features             | not started |
| I     | Billing (optional)             | not started |
| J     | Migrate existing local users   | not started |
| K     | Hardening for launch           | not started |

"done — code" means the code is committed and tested. The user-facing
account/domain steps in `docs/cloud/SETUP_CLOUD.md` are still required
to bring the live system online.

---

## A — Foundation: account setup tasks

**Code side: done.** The supporting blueprint files
(`apps/api/render.yaml`, `apps/api/.env.example`, `apps/web/.env.example`,
`apps/agent/.env.example`) and the [`SETUP_CLOUD.md`](SETUP_CLOUD.md)
walkthrough have been audited and are ready for the account-side work
below.

**Account side: only the human user can do these** (third-party signups,
domain purchases, payment cards). They cannot be automated by an
agent. Walk through [`SETUP_CLOUD.md`](SETUP_CLOUD.md) to complete:

- [ ] Buy the domain (`sc2tools.app` recommended)
- [ ] Create the Clerk application + Google OAuth
- [ ] Provision the Render web service from `apps/api/render.yaml`
- [ ] Create the `sc2tools_saas` MongoDB Atlas database
- [ ] Vercel project pointing at `apps/web/`
- [ ] Wire env vars in Render + Vercel per `.env.example`
- [ ] Confirm `/v1/health` returns 200 and `/sign-in` loads

---

## B — Schema + data migration ✅ done

- [x] **[`docs/CLOUD_SCHEMA.md`](../CLOUD_SCHEMA.md)** — collection
  shapes, indexes, and the hot queries each index serves. Derived
  from [`apps/api/src/db/connect.js`](../../apps/api/src/db/connect.js)
  and the service modules.
- [x] **[`tools/migrate-to-cloud/`](../../tools/migrate-to-cloud/)** —
  Node 20+ CLI (zero third-party deps) that reads
  `data/MyOpponentHistory.json`, `data/meta_database.json`,
  `data/custom_builds.json`, and `data/profile.json` and upserts every
  record into the user's cloud account. Implements:
  - Dry-run mode (`--dry-run`)
  - Reconcile pass (`--reconcile-only`) comparing local vs cloud
    counts
  - Resume-friendly: deterministic `gameId` (sha256-truncated from
    `pulseId|date|map` for opp-history entries; existing meta `id`
    for meta entries), so re-runs upsert rather than duplicate
  - Clerk personal/session token via `--token` or interactive stdin
  - 7 unit tests against representative fixtures (`node --test`)
- [x] **Schema versioning hook** —
  [`apps/api/src/db/schemaVersioning.js`](../../apps/api/src/db/schemaVersioning.js)
  mirrors the local app's `lib/schema_versioning.js` pattern. Every
  service write path stamps `_schemaVersion` on insert/upsert; future
  format changes register a `(fromVersion, toVersion, forward,
  backward)` migration and `migrateDoc` rolls older docs forward.
  14 Jest tests cover stamping, forward/backward chaining, and the
  too-new safety check.
- [ ] **Atlas backups + connection alerting** — see
  [`SETUP_CLOUD.md` §1b](SETUP_CLOUD.md#1b-backups--alerting-do-this-before-you-have-real-users).
  The Atlas UI work itself is account-side and only the user can do
  it; the doc is in place.

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

## E — Frontend on Vercel (analyzer port) ✅ done

The full analyzer SPA has been lifted from
`reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/`
to `apps/web/components/analyzer/` as proper TypeScript ES modules.

- [x] **Recharts pinned** in `apps/web/package.json` (`recharts@^2.15.0`).
- [x] **Shared UI primitives**: [`Card`/`Stat`/`EmptyState`/`Skeleton`/`WrBar`](../../apps/web/components/ui/Card.tsx),
  [`useSort` + `SortableTh`](../../apps/web/components/ui/SortableTh.tsx),
  [`ErrorBoundary`](../../apps/web/components/ui/ErrorBoundary.tsx),
  shared format helpers in [`lib/format.ts`](../../apps/web/lib/format.ts),
  filter/dbRev context in [`lib/filterContext.ts`](../../apps/web/lib/filterContext.ts).
- [x] **Tabs** (each a proper TSX module with `useApi` from
  [`lib/clientApi.ts`](../../apps/web/lib/clientApi.ts)):
  [Opponents](../../apps/web/components/analyzer/OpponentsTab.tsx),
  [Strategies](../../apps/web/components/analyzer/StrategiesTab.tsx),
  [Trends](../../apps/web/components/analyzer/TrendsTab.tsx),
  [Battlefield (maps + matchups)](../../apps/web/components/analyzer/BattlefieldTab.tsx),
  [Builds](../../apps/web/components/analyzer/BuildsTab.tsx),
  [DNA grid + timings drilldown](../../apps/web/components/analyzer/OpponentDnaGrid.tsx),
  [Map intel tab + viewer](../../apps/web/components/analyzer/MapIntelTab.tsx),
  [ML core](../../apps/web/components/analyzer/MlCoreTab.tsx),
  [ML predict](../../apps/web/components/analyzer/MlPredictTab.tsx).
- [x] **Charts** (Recharts): resources, army+resource, macro breakdown,
  chrono spending, game detail, activity, build-order timeline — all
  in [`components/analyzer/charts/`](../../apps/web/components/analyzer/charts/).
- [x] **Build editor modal** with notes save / matchup table / recent
  games (`BuildEditorModal.tsx`).
- [x] **Doctor banner** + specialised empty states
  (`DoctorBanner.tsx`, `EmptyStates.tsx`).
- [x] **Settings shell + 9 sub-pages** under
  [`components/analyzer/settings/`](../../apps/web/components/analyzer/settings/):
  Foundation, Profile, Folders, Import (with progress bar), Builds,
  Overlay (with widget toggles), Voice, Backups (snapshots + GDPR),
  Misc. Mounted at [/settings](../../apps/web/app/settings/page.tsx).
- [x] **First-run wizard** under
  [`components/analyzer/wizard/`](../../apps/web/components/analyzer/wizard/):
  shell + Foundation, Account, Integrations, Streamlabs, Apply-import
  steps. Mounted at [/welcome](../../apps/web/app/welcome/page.tsx).
- [x] **Analyzer shell** ties it all together —
  [`AnalyzerShell.tsx`](../../apps/web/components/analyzer/AnalyzerShell.tsx)
  exposes 10 tabs with a per-tab navigation bar and the opponent
  drilldown view, and is the body of [`/app`](../../apps/web/app/app/page.tsx).
- [x] **Provider wiring** via [`AnalyzerProvider.tsx`](../../apps/web/components/AnalyzerProvider.tsx)
  (filters + dbRev refresh counter, consumed by every tab via SWR
  cache key suffix).
- [x] **Type-clean.** `npm run typecheck` in `apps/web/` passes.

---

## F — Realtime push ✅ done

- [x] **Sticky-session config in Render.** [`apps/api/render.yaml`](../../apps/api/render.yaml)
  sets `sessionAffinity: true`. Doc note added to
  [`SETUP_CLOUD.md`](SETUP_CLOUD.md) so you know to verify the toggle
  if you ever scale to 2+ instances.
- [x] **Socket.io reconnect UX.** [`SyncStatus.tsx`](../../apps/web/components/SyncStatus.tsx)
  now tracks four connection states (connecting / connected /
  reconnecting / offline). The dot goes amber on disconnect and
  surfaces "reconnecting (N)" once the third retry has fired; goes
  red after six attempts to indicate the user should refresh. The
  client also enables `socket.io-client`'s built-in
  exponential-backoff reconnection.
- [x] **Heartbeat ping** from the agent.
  [`apps/agent/sc2tools_agent/heartbeat.py`](../../apps/agent/sc2tools_agent/heartbeat.py)
  starts a daemon thread on agent boot that POSTs
  `/v1/devices/heartbeat` every minute (with version + OS metadata).
  Server side, the route is gated to `auth.source === 'device'` and
  bumps `lastSeenAt` + agent metadata on the matching `device_tokens`
  row, so the dashboard can render an online/offline indicator per
  device. Wired into the runner's lifecycle (`runner.py`).

---

## G — Hosted OBS overlay (widget port) ✅ done

### Widgets ported

All 15 widgets are now React components under
[`apps/web/components/overlay/widgets/`](../../apps/web/components/overlay/widgets/).
They share a single chrome ([`WidgetShell`](../../apps/web/components/overlay/WidgetShell.tsx))
with slot-aware positioning, per-widget accent colour, and the
animated entry/exit transition the legacy HTML overlay had. Each one
is hidden when its data field is missing — no widget renders empty.

- [x] `OpponentWidget` (pre-game dossier with race + MMR + H2H)
- [x] `MatchResultWidget` (post-game victory/defeat card)
- [x] `PostGameWidget` (build summary)
- [x] `MmrDeltaWidget`
- [x] `StreakWidget` (only fires on 3+ same-result run)
- [x] `CheeseWidget` (gated on `cheeseProbability >= 0.4`)
- [x] `RematchWidget`
- [x] `RivalWidget`
- [x] `RankWidget`
- [x] `MetaWidget`
- [x] `TopBuildsWidget`
- [x] `FavOpeningWidget`
- [x] `BestAnswerWidget`
- [x] `ScoutingWidget`
- [x] `SessionWidget`

[`OverlayClient.tsx`](../../apps/web/components/OverlayClient.tsx)
composes them all, supports both single-widget (`?w=opponent`, the
trick the legacy overlay used so streamers can position each Browser
Source independently) and combined views, and live-applies the user's
enabled-widgets list when it arrives over the socket.

### Backend wiring

- [x] **`POST /v1/overlay-events/live`** —
  [`apps/api/src/routes/overlayTokens.js`](../../apps/api/src/routes/overlayTokens.js)
  exposes the route. The agent (any device-token-authed caller)
  posts `{ token, payload }`; the route verifies the overlay token
  belongs to the same user, then `io.to(\`overlay:<token>\`).emit('overlay:live', payload)`.
  Agent helper added at
  [`api_client.py#push_overlay_live`](../../apps/agent/sc2tools_agent/api_client.py).
- [x] **Per-overlay rate limit.** `express-rate-limit` with a
  per-token key — 100 events / 10 sec window (10/sec average), so a
  leaked token can't DoS the overlay socket.
- [x] **Configurable widget toggle.** `enabledWidgets` array on each
  overlay-tokens row, toggled via
  `PATCH /v1/overlay-tokens/:token/widgets`. Toggling pushes a
  `overlay:config` event to the live overlay so OBS visibility
  updates without a page reload. UI lives in
  [`SettingsOverlay.tsx`](../../apps/web/components/analyzer/settings/SettingsOverlay.tsx)
  under /settings → Overlay.
- [x] **Socket auth extended for overlay tokens.**
  [`socket/auth.js`](../../apps/api/src/socket/auth.js) now accepts
  `auth.overlayToken` in the handshake; the Clerk-JWT path is
  unchanged. On overlay-side connect, the socket joins
  `overlay:<token>` and is immediately handed the latest
  enabled-widgets list so it can hide widgets the streamer disabled.

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

With C, D, E, F, and G now complete in code, the shortest path to
"friend uses cloud SaaS without complaining" is:

1. **Setup** (A account-side) — half a day
2. **Migrate existing local users** (J) — 1 week
3. **Hardening** (K) — 1 week before public launch

That's ~2 weeks part-time to "feature parity + launch ready."

Add ML port (already in C) plus community features (H) afterward as
standalone PR series. Add billing (I) only when you're ready to
charge.

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
