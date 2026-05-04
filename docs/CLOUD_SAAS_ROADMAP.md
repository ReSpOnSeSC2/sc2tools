# SC2 Tools — Cloud SaaS Roadmap (Vercel + Render + MongoDB)

> Companion to `MASTER_ROADMAP.md` Stage 14. The Stage 14 in the master
> doc designs an **anonymous community pool** (no accounts, k-anonymity,
> read-only public data). This document designs the **per-user SaaS
> pivot**: signed-in users, their personal data hosted in the cloud,
> the SPA served as a website, the OBS overlay served as a per-user
> URL. Both can ship side-by-side; the community pool becomes a free
> feature inside the SaaS.

---

## Why this exists

Today the app runs entirely on the user's PC. To install it, a friend
needs Node, Python, npm, pip, the right Replays folder structure, and
about 200 MB of correctly-arranged JSON. That's brutal.

Going SaaS gives:

- **Zero-friction onboarding** — sign in with Google, see the app.
- **Cross-device access** — laptop, second monitor, phone, all in sync.
- **Hosted OBS overlay** — streamers paste a URL into Browser Source.
- **Community features** — shared opponent dossiers, leaderboards, the
  cloud-synced custom-builds DB you've already designed for.
- **Auto-updates** — every visit pulls the latest UI.
- **Better debugging** — server logs you control instead of "it
  doesn't work on my friend's machine."

You **cannot** escape the local component entirely. SC2 writes replays
to the user's disk in real time, and the app's value depends on
parsing those replays the moment they land. So the architecture is
**hybrid**: tiny local agent + cloud API + cloud UI.

---

## Outcome

After this roadmap ships, a brand-new user can:

1. Visit `sc2tools.app`, click **Sign in with Google**.
2. Download the **SC2 Tools Agent** — a 5-15 MB single-exe.
3. Run it once. It auto-detects their Replays folder and asks for a
   pairing code shown on the website.
4. Click **Pair** in the browser. The agent uploads existing replays
   in the background.
5. Open the analyzer at `sc2tools.app/app` — opponents, builds, macro
   scores, all populated from their cloud account.
6. Optional: Stream? Paste `sc2tools.app/overlay/<their-token>` into
   OBS Browser Source — pre-game opponent dossier appears live.

No npm. No pip. No path resolution. No "where do I put this folder."

---

## What you already have (don't rebuild)

- **Render + MongoDB + Node/Express** wired and deployed for
  `cloud/community-builds/` (see `docs/DEPLOYMENT_GUIDE.md`).
  Same pattern, same `render.yaml` shape, same MongoDB driver scales
  up to the full SaaS.
- **A working React SPA** at
  `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/`.
  The components are real React 18 — they port to Next.js with
  surprisingly little rework.
- **A complete Express API** at
  `reveal-sc2-opponent-main/stream-overlay-backend/{index.js,analyzer.js}`
  with all the route handlers you need. The hard work is migrating
  its data layer from JSON files to MongoDB queries; the route shapes
  stay the same.
- **All the Python parsers** — sc2reader, the macro engine with the
  chrono fix, the build classifier, the SC2Pulse poller. These keep
  working unchanged inside the local agent.
- **The community-builds Mongo schema** as a working reference for
  per-user collections.

What this means: **don't rewrite, refactor**. Every stage below moves
existing code, never green-fields it.

---

## Architecture at a glance

```
+------------------------------+         +-----------------------------+
|  USER PC                     |         |  CLOUD                      |
|                              |         |                             |
|  +------------------------+  |  HTTPS  |  +-----------------------+  |
|  | sc2tools-agent.exe     | -+-------> |  | Render web service    |  |
|  | - watches Replays/     |  |         |  | (Node/Express API)    |  |
|  | - parses sc2reader     |  |         |  |  - REST routes        |  |
|  | - SC2Pulse poller      | <+--------+|  |  - Socket.io          |  |
|  | - tray icon            |  |         |  |  - Clerk JWT verify   |  |
|  +------------------------+  |         |  +-----------+-----------+  |
|                              |         |              |              |
|  Browser:                    |         |              v              |
|  - sc2tools.app/app  -------------->   |  +-----------------------+  |
|  - sc2tools.app/overlay/... -------->  |  | MongoDB Atlas         |  |
|                              |         |  |  - users, opponents,  |  |
|  OBS Browser Source: -------------->   |  |    games, builds,     |  |
|  - sc2tools.app/overlay/...  |         |  |    overlay-tokens     |  |
|                              |         |  +-----------------------+  |
+------------------------------+         |                             |
                                         |  +-----------------------+  |
                                         |  | Vercel (Next.js)      |  |
                                         |  | - sc2tools.app/*      |  |
                                         |  | - server components   |  |
                                         |  |   talk to Render API  |  |
                                         |  +-----------------------+  |
                                         |                             |
                                         |  +-----------------------+  |
                                         |  | Render background     |  |
                                         |  | worker (cron)         |  |
                                         |  |  - Pulse scrapes      |  |
                                         |  |  - aggregations       |  |
                                         |  +-----------------------+  |
                                         +-----------------------------+
```

**Service boundaries:**

| Concern | Where | Why |
|---|---|---|
| Replay parsing | Local agent | Replays live on user's disk |
| sc2reader, macro engine, classifier | Local agent | Python; existing code works as-is |
| SC2Pulse poller | Local agent (per user) OR Render worker (centralized) | See "Decisions" below |
| API + auth + DB writes | Render web | Existing Express, extended |
| Realtime push | Render web (Socket.io) | Already wired |
| User auth | Clerk | OAuth UI is a solved problem |
| SPA + marketing site | Vercel (Next.js) | Edge-cached, free tier |
| OBS overlay | Vercel (Next.js, public route w/ token) | Same as SPA |
| File storage (replay binaries, optional) | MongoDB GridFS or R2 | Defer until needed |

---

## Decisions to lock before writing code

Lock these in writing before Stage A. Changing any of them mid-roadmap
costs ~1 week.

1. **Auth provider.** Recommend **Clerk** (free up to 10k MAU,
   Google/Discord/Twitch sign-in, drop-in React components,
   server-SDK for verifying JWTs in Express). Alternatives: NextAuth
   (more wiring), Auth0 (pricier), roll-your-own (don't).

2. **Frontend framework.** Recommend **Next.js 15 App Router** on
   Vercel. The current single-file babel-standalone SPA can be lifted
   into Next.js page-by-page; `'use client'` for the interactive
   components, server components for the static shell. Alternative:
   Vite + React (simpler, but you lose Vercel's edge caching for
   server-rendered pages).

3. **Backend stack.** Recommend **keep Express** (Node 22). The
   existing `analyzer.js` has 3,500 lines of battle-tested business
   logic; rewriting in FastAPI per the original Stage 14 plan would
   double the timeline. Alternative: Hono / Fastify — same shape,
   marginal wins, not worth the migration.

4. **DB provider.** **MongoDB Atlas** (already deployed for
   community-builds). M0 free tier (512MB) covers the first ~10 users;
   M10 ($57/mo) is your "we have real users" tier.

5. **Pulse polling — per-user or centralized?**
   - Per-user (agent polls): zero cloud cost, scales linearly with
     users, but the user's PC must be online to track their own opps.
   - Centralized (Render worker): cloud knows user's pulseId, polls
     SC2Pulse directly, stores results. Tracks even when user is
     offline. Costs Render worker hours.
   - **Recommend centralized** in cloud, with the local agent as a
     redundant secondary so live in-game overlays work without the
     5-15s SC2Pulse poll lag.

6. **Free vs paid tier.** Recommend:
   - Free: 1 device, 500 games stored, no overlay, community builds
     read-only.
   - Pro ($5/mo): unlimited games, 3 devices, hosted overlay, can
     publish custom builds, priority sync.
   - Decide BEFORE Stage I (Billing). If you hate billing, just stay
     free + accept donations.

7. **Privacy stance.** The current local app stores opponent
   battle-tags in plaintext. In the cloud, **always salt-hash
   battle-tags before write** (already documented in Stage 14 of the
   master roadmap as `HMAC(server_pepper, battle_tag)`). Display name
   is plaintext for the OBSERVING user only.

8. **Domain.** Pick + buy now. Recommend `.app` (HTTPS-required by
   default, $14/yr).

---

## The roadmap

Time estimates assume **~10 hours/week** (one engineer, evenings).
Halve them for full-time.

### Stage A — Foundation (1-2 weeks)

**Goal:** Lock decisions above into code. Have a deployed empty shell
on each platform.

- [ ] Buy domain (`sc2tools.app` or similar). Configure DNS at
      registrar with `CNAME` for `app.` and `api.` subdomains.
- [ ] Create Clerk app. Configure Google + Discord OAuth providers.
      Add localhost + `*.vercel.app` + your domain to allowed origins.
- [ ] Vercel project pointing at a new `apps/web/` directory in your
      monorepo (Next.js 15 starter). Wire the Clerk frontend.
- [ ] Render web service pointing at a new `apps/api/` directory
      (Node 22, Dockerfile copied from `cloud/community-builds/`).
      Add Clerk JWT verification middleware. Add MongoDB connection
      using the same pattern as `cloud/community-builds/src/db.js`.
- [ ] MongoDB Atlas: create a `sc2tools_saas` database, separate from
      the community-builds one (so you can scale them independently).
- [ ] One end-to-end smoke route: visit `app.yourdomain.app`, sign
      in, hit `api.yourdomain.app/v1/me`, see your Clerk user id back.

**Definition of Done:** signed-in user can hit your API and the API
sees their identity.

### Stage B — Schema + data migration (2 weeks)

**Goal:** Decide the MongoDB document shapes and migrate one
representative user's data (yours) into the cluster.

- [ ] Write `docs/CLOUD_SCHEMA.md` defining collections:
      `users`, `profiles`, `opponents`, `games`, `custom_builds`,
      `device_pairings`, `overlay_tokens`. Pick indexes for the hot
      queries (`opponents` by `userId+pulseId`, `games` by
      `userId+date`).
- [ ] Write a Node migration script under `tools/migrate-to-cloud/`
      that reads `data/MyOpponentHistory.json` + `data/meta_database.json`
      and upserts them into Mongo, keyed under your Clerk userId.
- [ ] Run the migration against your own data. Confirm round-trips by
      reading back via a temporary `/v1/debug/me/games` endpoint.
- [ ] Define indexes via a one-shot `npm run db:ensure-indexes` that
      runs at deploy.

**Definition of Done:** your 137 MB meta_database + 27 MB
opponent-history is queryable from the API in < 200 ms p95.

### Stage C — Backend route migration (2-3 weeks)

**Goal:** Reimplement the existing Express routes against MongoDB,
scoped per-user.

- [ ] Stand up the API skeleton at `apps/api/` with the same router
      structure as `reveal-sc2-opponent-main/stream-overlay-backend/`
      (`routes/builds.js`, `routes/opponents.js`, etc.).
- [ ] Port `analyzer.js`'s aggregation logic in chunks. Hot route
      first: `/v1/opponents` (browse), then `/v1/builds`, then
      `/v1/games/:id`, then macro/APM endpoints. Replace
      `dbCache.opp.data[pulseId]` with
      `db.opponents.findOne({ userId, pulseId })`.
- [ ] **Keep the response shapes byte-identical** to the local
      Express. That's how you avoid rewriting the SPA.
- [ ] Add request-level rate limiting (express-rate-limit, 100
      req/min/user) to protect against runaway clients.
- [ ] Re-run the existing jest test suite from
      `stream-overlay-backend/__tests__/` against the new routes —
      most tests should pass with a Mongo-backed test container.

**Definition of Done:** the analyzer SPA, pointed at your Render API
URL via `VITE_API_URL` (or env-driven Next.js fetch base), renders
your opponents and builds tab correctly using cloud data.

### Stage D — Local agent (3-4 weeks)

**Goal:** Strip the desktop install down to a single .exe whose only
job is "watch replays, parse, upload."

- [ ] Create `apps/agent/` (Python). Lift these unchanged:
      - `core/event_extractor.py` (chrono fix)
      - `core/sc2_replay_parser.py`
      - `analytics/macro_score.py`
      - `analytics/timing_catalog.py`
      - `watchers/replay_watcher.py`
      - `scripts/poller_launch.py` (only if Decision 5 = per-user)
- [ ] Add `apps/agent/uploader.py`: posts parsed game records to
      `api.yourdomain.app/v1/games` with the device's auth token.
- [ ] **Pairing flow:**
      1. Agent generates a 6-digit code, displays in tray menu.
      2. User signs in at `sc2tools.app/devices`, types the code.
      3. Web POSTs `/v1/device-pairings` with code + Clerk JWT.
      4. Agent polls `/v1/device-pairings/<code>` until it returns a
         long-lived device token.
      5. Agent stores token in `%LOCALAPPDATA%\sc2tools\agent.json`.
- [ ] Tray icon (`pystray` library): "Status: connected • 437
      replays synced • Pause • Quit • Open dashboard."
- [ ] Package with PyInstaller `--onefile --windowed`. Sign with a
      code-signing cert (~$70/yr, optional but kills SmartScreen).
- [ ] Auto-update: check `api.yourdomain.app/v1/agent/version` on
      startup, download installer if newer.

**Definition of Done:** install on a fresh Windows VM with no
dependencies, complete pairing in <60s, see games appear in your
cloud account within 30s of finishing a real SC2 game.

### Stage E — Frontend on Vercel (2-3 weeks)

**Goal:** Lift the analyzer SPA from Express-served single-file babel
into Next.js on Vercel.

- [ ] Bootstrap `apps/web/` with `create-next-app@latest`, App Router,
      TypeScript, Tailwind. Copy your existing `design-tokens.css`
      and Tailwind config from
      `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/`.
- [ ] Move each component file from `public/analyzer/components/*.jsx`
      into `apps/web/components/`. Drop the `(function () { ... })()`
      IIFE wrapper and the `Object.assign(window, { ... })` exports —
      use real ES module exports. Add `'use client'` directives at
      the top.
- [ ] Build the marketing landing page (`/`), pricing (`/pricing`),
      docs (`/docs/setup-agent`), download (`/download`).
- [ ] Wire data fetching: replace the existing `useApi('opponents', ...)`
      with `fetch(API_BASE + '/v1/opponents', { headers: clerk-jwt })`.
      Centralize in `lib/api.ts`.
- [ ] Settings → Devices subpage: list paired devices, revoke device
      tokens, show last-sync time.
- [ ] Server-side render the `/u/<username>` public profile pages
      (opt-in) for SEO and easy sharing.

**Definition of Done:** sign in at `sc2tools.app`, navigate to
`/app`, see your full analyzer rendering against the cloud API. The
old localhost:3000 still works as before — both deploy targets share
the components.

### Stage F — Realtime push (1-2 weeks)

**Goal:** New game finishes → opponents tab updates without refresh.

- [ ] Add Socket.io server to `apps/api/` (it's already used in the
      local Express). Authenticate sockets via Clerk JWT.
- [ ] When the API receives a new game record from the agent, emit
      `analyzer_db_changed` to the user's room.
- [ ] In `apps/web/`, subscribe via socket.io-client. Reuse the
      existing `setDbRev((r) => r + 1)` pattern from the SPA.
- [ ] Sticky-session config in Render so socket connections don't
      bounce between instances when you scale.

**Definition of Done:** finish a SC2 game, the analyzer SPA in
another tab updates within 5s.

### Stage G — Hosted OBS overlay (1-2 weeks)

**Goal:** Streamers can drop one URL into OBS Browser Source.

- [ ] Add `/v1/overlay-tokens` endpoint: user creates a per-overlay
      revocable token bound to their userId. Show the URL on the web
      Settings → Streaming page.
- [ ] Public Next.js route `/overlay/[token]/page.tsx` (no Clerk
      auth — token IS the auth). Renders the existing widgets from
      `reveal-sc2-opponent-main/SC2-Overlay/widgets/` adapted to
      pull from the cloud API.
- [ ] Token-scoped Socket.io room so the overlay updates live during
      a stream.
- [ ] Rate-limit overlay endpoints aggressively (a leaked token
      should not let an attacker DOS the API).

**Definition of Done:** paste the URL into OBS, queue a ladder game,
opponent dossier popup fires before the loading screen ends.

### Stage H — Community features (1-2 weeks)

**Goal:** Pay back the value the existing community-builds Stage 7
designed for, plus public opponent dossiers.

- [ ] Merge `cloud/community-builds/` into `apps/api/` as a
      `routes/community.js` namespace (or keep separate and proxy
      from `apps/api/`). Reuse the existing collections.
- [ ] When a user creates a custom build via the cloud UI, push to
      both their personal `custom_builds` and the shared
      `community_builds` (already implemented in
      `services/community_sync.js` — just needs the cloud to be the
      canonical store).
- [ ] Public build pages: `sc2tools.app/builds/<slug>` — server-
      rendered, indexable, shareable.
- [ ] Aggregated opponent profiles (the old Stage 14 idea, k-anonymity
      protected): `sc2tools.app/opponents/<pulseId>` shows "seen by N
      users, common openings, win rate vs each race."

**Definition of Done:** publish a build from your account, your
friend can read it without an account, on Google within a week.

### Stage I — Billing (1-2 weeks; SKIP if you don't want to monetize)

**Goal:** Pro tier gating. Stripe handles money; you handle entitlements.

- [ ] Stripe account + product + monthly price.
- [ ] Stripe Checkout integration via the Stripe MCP / SDK.
      `/v1/billing/checkout` returns a redirect URL.
- [ ] Webhook `POST /v1/billing/webhook` updates `users.tier` field
      on `customer.subscription.updated` events. Verify with Stripe's
      webhook signature.
- [ ] Server-side enforcement: middleware on
      `requireTier('pro')` for overlay-token creation, >500 games,
      >1 device. Free users get a clear "upgrade to unlock" CTA.
- [ ] Stripe Customer Portal link on the web `Account` page so users
      can self-serve cancellations.

**Definition of Done:** a $5/mo subscription completes end-to-end
in test mode, the webhook flips your tier, the gated routes start
returning data.

### Stage J — Migrate existing local users (1 week)

**Goal:** Anyone running the local app today can move to the cloud
without losing their 137MB of history.

- [ ] In the existing local Express, add a one-time `/migrate-to-cloud`
      page: signs you in via Clerk, then POSTs the entire
      `meta_database.json` + `MyOpponentHistory.json` to a bulk-import
      endpoint at the cloud API.
- [ ] After migration, the local Express stays runnable as a
      fallback — but the user's primary entry is now the website.
- [ ] **Deprecation notice in the local SPA's update banner:**
      "SC2 Tools is moving to the cloud. Migrate now to keep your
      data + get the new web UI."
- [ ] Sunset plan: keep local Express in security-fix-only mode for
      6 months, then archive.

**Definition of Done:** your own prod data on `C:\SC2TOOLS\` is fully
mirrored in the cloud, with no record left behind.

### Stage K — Hardening for launch (ongoing, 2 weeks before public)

- [ ] Sentry on both Vercel + Render. Source maps uploaded.
- [ ] Render autoscaling + healthcheck pointing at `/healthz` that
      pings Mongo.
- [ ] MongoDB Atlas: enable backups, set up alerts on connections >
      80% of plan limit.
- [ ] Cloudflare or Vercel WAF in front of the API for DDoS / bot
      protection.
- [ ] Privacy policy + ToS pages (`sc2tools.app/legal/privacy`,
      `/legal/terms`). Cookie consent banner.
- [ ] Status page at `status.sc2tools.app` (UptimeRobot or Better
      Uptime, both have free tiers).
- [ ] One-click data export at `Account → Export my data` (GDPR).
- [ ] Account deletion at `Account → Delete account` that wipes from
      every collection (GDPR).

---

## Cost estimate

Per month, USD, by user-count tier. Assumes you're on the cheapest
viable plan that doesn't compromise UX.

| Service | Empty | 50 users | 500 users | 5000 users |
|---|---|---|---|---|
| Vercel (Hobby → Pro) | $0 | $0 | $20 | $20 |
| Render web ($7 Starter → $25 Standard → $85 Pro) | $7 | $7 | $25 | $85 |
| Render worker (Pulse poller) | $7 | $7 | $25 | $85 |
| MongoDB Atlas (M0 → M2 → M10 → M30) | $0 | $0 | $9 | $57 |
| Clerk (free → Pro at 10k MAU) | $0 | $0 | $0 | $25 |
| Cloudflare R2 / GridFS for replay binaries | $0 | $0 | $5 | $30 |
| Domain | $1.20 | $1.20 | $1.20 | $1.20 |
| Sentry (Developer free → Team) | $0 | $0 | $0 | $26 |
| Code-signing cert | $6 | $6 | $6 | $6 |
| **Total** | **$21** | **$21** | **$91** | **$335** |

**Break-even at $5/mo Pro tier with 30% conversion:**
- 50 users × 30% × $5 = $75/mo revenue vs $21/mo cost. Profitable from
  user 15 or so.
- 500 users × 30% × $5 = $750/mo revenue vs $91/mo cost. Healthy margin.

These numbers don't include your time. They do include enough headroom
to handle a Reddit hug-of-death.

---

## Risks and what could go wrong

1. **Pulse rate limits.** SC2Pulse has informal rate limits. With 500
   users polling individually you'll get banned. Centralizing the
   poller (Decision 5) and caching aggressively are the only real
   answers. Have a contact at SC2Pulse before you scale past ~100.

2. **Replay parsing CPU.** Each replay parse is ~150-500ms. If 100
   users finish games in the same minute, the agent absorbs it
   locally — but if you ever want server-side reparse, budget for a
   Render worker pool.

3. **Mongo document size.** MongoDB's 16MB doc limit. Don't store
   per-user `games[]` arrays as embedded docs — use one document per
   game, indexed on `userId`. The community-builds schema already
   does this right; copy that pattern.

4. **Auth token leaks.** Device tokens are long-lived. Revoke on
   suspicious-activity and offer a one-click "rotate all device
   tokens" in account settings.

5. **Vercel function timeouts.** Hobby tier = 10s, Pro = 60s.
   Anything that aggregates a user's full history can blow this. Push
   heavy aggregations to the Render API (no timeout) and let Vercel
   serve only edge-cached responses.

6. **Cold starts on Render free tier.** The $7 Starter sleeps after
   15min of inactivity. First request after sleep takes 30-60s. If
   you ever go to free tier to save $7, expect angry users.

7. **Single-region.** Atlas + Render in `us-west-2` is fine for the
   first 1000 users. EU users will see 150ms+ latency. Defer
   multi-region until you have an EU userbase asking for it.

8. **Migration loss.** When users migrate from local to cloud, ANY
   bug in the import path silently loses replay history. Write the
   migration as **upsert + dry-run mode + comparison report** before
   you let it touch prod data.

---

## What NOT to do

- **Don't rewrite the parsers.** sc2reader + the chrono fix + the
  macro engine are years of work. They run inside the local agent
  unchanged.
- **Don't drop the local-only mode.** Some users will refuse cloud.
  Keep local Express working. The maintenance cost is low if you
  share the React components between web and local.
- **Don't move replay binaries to the cloud by default.** Each replay
  is 30-300KB. With 1000 users at 100 replays each, that's ~10GB
  storage and meaningful egress costs. Parse locally, upload only
  the JSON record.
- **Don't ship without billing entitlements before going public.**
  Even if launch is free, having the gating logic in place means you
  can flip on Pro tier without an emergency refactor.
- **Don't put the API and UI on the same Vercel project.** Vercel
  edge functions have hard timeouts and aren't great for long-lived
  Mongo connections. Render's a better home for the API.
- **Don't use NextAuth + your own DB sessions.** Clerk's UI is worth
  the dependency. You're not building an auth product.

---

## Suggested ship rhythm

Assuming 10 hr/week, evenings:

| Week | Stages | Visible to friends? |
|---|---|---|
| 1 | A foundations | "Sign-in works" |
| 2-3 | B schema, C routes (start) | "Cloud has my data" |
| 4-5 | C routes (finish) | "Web SPA works against cloud" |
| 6-9 | D agent | "Friend installs in 60s, no Node/Python" |
| 10-12 | E web frontend | "Friend visits sc2tools.app, sees app" |
| 13-14 | F realtime + G overlay | "Live in OBS" |
| 15-16 | H community | "Public build pages, viral loop" |
| 17 | I billing (optional) | "First paid user" |
| 18 | J migration | "Local users moved over" |
| 19-20 | K hardening | "Public launch readiness" |

**5 months part-time.** Halve to 2.5 months full-time.

You can compress further by cutting Stage I (skip billing, take
donations) and Stage G (defer overlay until you have streamers
asking for it). Minimum viable cloud is **A + B + C + D + E** — that
gets a friend signed in and using the app from a browser, with their
games auto-syncing. About 12 weeks part-time.

---

## Cross-references

- `docs/MASTER_ROADMAP.md` Stage 14 — the anonymous community pool
  design. Most of its k-anonymity ideas should fold into Stage H of
  this doc.
- `docs/DEPLOYMENT_GUIDE.md` — the existing Render + Mongo + Vercel
  wire-up for community-builds. Stages A and B both lean on the
  patterns documented here.
- `cloud/community-builds/` — working reference implementation for
  Express-on-Render with Mongo. Stages B + C copy this structure
  wholesale.
- `reveal-sc2-opponent-main/stream-overlay-backend/analyzer.js` —
  the route logic to migrate. Stage C is mostly "this file, but
  Mongo-backed and userId-scoped."
- `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/`
  — the SPA components to lift to Next.js. Stage E is mostly "these
  files, but as ES modules."
- `SC2Replay-Analyzer/scripts/` and `reveal-sc2-opponent-main/scripts/`
  — Python parsers, lifted unchanged into the agent. Stage D.
