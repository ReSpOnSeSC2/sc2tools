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
| C     | Backend route migration        | **~25% — base routes done, aggregations not ported** |
| D     | Local agent                    | **~70% — runs from source; no signed binary, no auto-update** |
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

Each of these needs a service + route + tests in `apps/api/`:

- [ ] `GET /v1/summary` — race / matchup totals + win rate aggregates
- [ ] `GET /v1/builds` — list, with per-build stats
- [ ] `GET /v1/builds/:name` — drilldown
- [ ] `GET /v1/opp-strategies` — list of detected opponent strategies
- [ ] `GET /v1/build-vs-strategy` — cross-tab matrix
- [ ] `GET /v1/maps` — per-map win rates
- [ ] `GET /v1/matchups` — race × race × map
- [ ] `GET /v1/random-summary` — random-race tracker
- [ ] `GET /v1/timeseries` — daily/weekly W-L timeseries for charts
- [ ] `GET /v1/games/:gameId/build-order` — recomputed build-order
  view (used by the timeline component)
- [ ] `POST /v1/games/:gameId/opp-build-order` — opponent build
  order rebuild
- [ ] `POST /v1/games/:gameId/macro-breakdown` — invokes the macro
  CLI on a single game; result cached
- [ ] `GET /v1/games/:gameId/apm-curve` — per-minute APM series
- [ ] `POST /v1/macro/backfill/start` + `GET /v1/macro/backfill/status`
- [ ] `GET /v1/spatial/{maps,buildings,proxy,battle,death-zone,opponent-proxies}`
- [ ] `GET /v1/catalog`, `GET /v1/export.csv`
- [ ] `POST /v1/import/{scan,start,cancel,extract-identities,pick-folder}`,
  `GET /v1/import/{status,cores}`
- [ ] `GET /v1/definitions`
- [ ] ML routes: `/v1/ml/{status,train,predict,pregame,options}`
- [ ] `GET /v1/map-image`, `GET /v1/playback`

### Service-layer scaffolding for those routes

The hot work in each port is replacing
`dbCache.opp.data[pulseId]` and friends with the right MongoDB
aggregation pipeline. The shapes go from "scan everything in memory"
to "tell Mongo what you want." Group these logical buckets and ship
one PR per bucket so review stays sane:

1. **Aggregations bucket** — summary, matchups, maps, build-vs-strategy,
   random-summary, timeseries. All live behind one `AggregationsService`
   that issues `$facet` pipelines.
2. **Per-game compute bucket** — build-order, apm-curve,
   macro-breakdown. These spawn the Python CLIs (`macro_cli.py`,
   `buildorder_cli.py`) inside the Render container — same pattern as
   today, but the input game JSON comes from Mongo.
3. **Import bucket** — the existing `bulk_import_cli.py` flow lifts
   onto the API node-for-node; the route endpoints proxy stdout
   ndjson over Socket.io.
4. **ML bucket** — wraps `ml_cli.py` the same way.
5. **Spatial + map bucket** — the spatial endpoints all return small
   JSON; just queries.

Estimated: 2–3 weeks part-time per bucket. Total ~3–4 weeks for the
high-value buckets (1, 2, 3); ML and spatial can ship later.

### Dockerfile add: Python toolchain

The Render service will need Python and the analyzer's Python
dependencies for buckets 2 and 3. Update `apps/api/Dockerfile`:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache python3 py3-pip
COPY ../../SC2Replay-Analyzer/requirements.txt /tmp/py-req.txt
RUN pip install --no-cache-dir -r /tmp/py-req.txt
# ...
```

(Or split into a separate Render worker service that just hosts the
Python parsers and listens on an internal queue — cleaner long term,
adds 1 week to schedule.)

---

## D — Local agent (finishing touches)

The agent works end-to-end. What's left is packaging + polish:

- [ ] **Signed Windows installer.** PyInstaller `--onefile --windowed`
  + an EV code-signing cert (~$70/yr from a CA like SSL.com or
  DigiCert) so SmartScreen doesn't scare users.
- [ ] **Auto-update flow.**
  - Add `GET /v1/agent/version` to the API returning the latest
    semver + signed installer URL.
  - Agent checks on startup; if newer is available, downloads to a
    temp dir, verifies the signature, and runs the installer.
- [ ] **Tray UX polish.**
  - Multi-line tooltip with last-uploaded filename + timestamp
  - "Pause syncing" action that flips a flag in `state.json`
  - "Open log folder" action
  - "Re-sync from scratch" action that wipes `state.uploaded` and
    re-uploads everything
- [ ] **Crash reporter.** Sentry SDK with a redaction filter so
  battle-tags / paths don't leak into the trace.
- [ ] **Windows service mode.** Optional: register as a service so it
  restarts on logon failure. Trade-off: harder to surface a tray
  icon. Probably skip and stick with Startup-folder shortcut.
- [ ] **macOS / Linux builds.** Defer until someone asks. PyInstaller
  supports both; the watchdog + pystray code is already cross-platform.
- [ ] **Replay-folder reconfig UI.** Right now the agent picks
  `find_replays_root()` automatically. If a user has multiple SC2
  installs (Battle.net + PTR), they need to override via
  `SC2TOOLS_REPLAY_FOLDER` env var. Add a tray menu item that opens a
  folder picker.

Estimated: 1.5–2 weeks part-time.

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
