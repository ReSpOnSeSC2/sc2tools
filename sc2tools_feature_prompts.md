# sc2tools.com — 5 Growth Feature Prompts

Researched on **2026-09-27** against the code at `3b7e70e`: web app, API, desktop agent, replay engine, docs and roadmaps. Each prompt below is **self-contained**. Paste one whole block into a fresh Claude Code session at the repo root. Every prompt tells the agent to plan first, names the real files and conventions to follow, and ships in small PR slices.

They are ordered in the **recommended build order**. Together they cover the whole growth funnel:

| # | Feature | Funnel stage | What it unlocks | Size |
|---|---|---|---|---|
| 1 | **Guides**: public build-order encyclopedia from real ladder results | Get found (search) | ~300 indexable pages built from data only you have | L, 5 PRs |
| 2 | **Instant Analysis**: parse replays in the browser, no download | Try it instantly | Value in about 60 s, zero install, **$0 server cost** | L, 5 PRs |
| 3 | **SC2 Tools Coach**: grounded AI coach (Claude) | Keep coming back / word of mouth | The headline feature; every number verified against your data | L, 5 PRs |
| 4 | **Squads + Discord app** | Bring friends | Invite loop, shared scouting pool, Discord distribution | XL, 7 PRs |
| 5 | **Replay Review Exchange** | Community + content | User-generated SEO pages, reviewer reputation, coaching funnel | L, 5 PRs |

## Why these five (what the research found)

- **Almost no search footprint.** `apps/web/app/sitemap.ts` lists 9 static URLs. Community builds, `/p/` profiles and `/meta` variants are missing, and most public pages share one static OG image. Meanwhile the Meta Radar holds a dataset nobody else publishes: which openers actually *win*, by league, MMR band, map and patch.
- **Every feature starts with "install the agent".** The only no-install path is a one-file landing demo that parses on the API server. `docs/CLOUD_REPLAY_UPLOAD_ROADMAP.md` proposes Redis, BullMQ and a Python worker. None of that exists, and it would multiply a donation-funded bill. The replay pipeline is pure Python plus sc2reader, so it can run *in the visitor's browser* via Pyodide.
- **No LLM anywhere.** Several modules say "No LLM" on purpose. The Coach keeps that promise by letting the model explain while your deterministic engines supply every fact, then verifying every number before it's shown.
- **No social layer at all.** There are no friends, teams, invites, comments, user notifications, email or Discord. The product is single-player, so nobody has a reason to invite anyone.
- **Hard constraints respected everywhere:**
  - The API is **one Render Starter instance** (`numInstances: 1`, in-memory Socket.IO).
  - Build logs and replay details are heavy fields in R2, not on the ~3 kB slim game rows.
  - Ingest admits **one** replay batch at a time.
  - The site is donation-funded.

  So nothing here adds a gateway bot, Redis, a worker fleet, or an uncapped AI bill.

## How to use

1. Open Claude Code at the repo root on a fresh branch.
2. Paste **one** prompt block (use the copy button on the code block).
3. Let it post its plan, check it, then let it work through the PR slices.
4. The Coach prompt calls the Claude API and costs real money. Set `AI_COACH_MONTHLY_BUDGET_USD` before enabling it. The model is an env var (`AI_COACH_MODEL`, default `claude-opus-5`), so you choose the cost/quality tradeoff.

---

## 1. Guides — the public SC2 build-order encyclopedia

> Hundreds of Google-indexable pages like "Stargate into Blink PvZ — 54% win rate at Diamond". Every number comes from real ladder games, and every page converts visitors into users.

````text
You are implementing a new public feature for sc2tools.com in the ReSpOnSeSC2/sc2tools monorepo: **SC2 Tools Guides** — a public, search-indexable StarCraft II build-order encyclopedia whose every number comes from real ladder games synced by SC2 Tools users. Plan first: read the files named below, then post a short plan listing every file you will add or change. Then implement in the PR slices at the end. If anything here conflicts with what the code actually does, the code wins — adapt, and call out the deviation in the PR description.

## Why this exists (use this to make judgment calls)
- sc2tools.com has almost no search footprint:
  - apps/web/app/sitemap.ts lists 9 static URLs.
  - Community builds, author pages, /p/ profiles and /meta variants are not in the sitemap.
  - Community builds and /meta use a static /og.jpg.
- The site owns a dataset nobody else publishes: which openers actually WIN on the ladder, by league/MMR band, matchup, map and patch. The header of apps/api/src/services/ladderMeta.js makes exactly this point against Spawning Tool and SC2Pulse. Today it lives on one /meta page behind controls.
- Players search things like "pvz build order", "stargate into blink", "how to beat 12 pool" and "<map name> pvz". Each of those should land on a page with real win rates, timings and a call to action into the product.
- Goal: ~300 high-quality, data-backed, indexable pages that compound organic traffic and convert visitors into sign-ups.

## Ground truth about this repo (verified — do not re-derive)

### apps/web
- Next.js 15 App Router, React 19.
- Tailwind 3 with CSS-variable tokens (app/globals.css → tailwind.config.ts; classes like bg-bg-surface, text-text-muted, border-border).
- UI kit in components/ui: Card, Section, PageHeader, Stat, Badge, Tabs, EmptyState, …
- SSR data via getJson/getJsonWithStatus in lib/serverApi.ts (public, no auth). recharts for charts.
- GA4 events via gaEvent() in lib/analytics/gtag.ts.
- Precedents to copy:
  - dynamic OG image: app/p/[handle]/opengraph-image.tsx (next/og ImageResponse);
  - JSON-LD: /community/builds/[slug] (BreadcrumbList) and /download (SoftwareApplication).
- Tests: vitest + Testing Library; Playwright public-page responsive smoke in tests/e2e/public-pages.spec.ts.

### apps/api
- Express 4, CommonJS + JSDoc checked by tsc --noEmit (checkJs), MongoDB driver 6, AJV validation.
- Routers are buildXRouter(deps) factories in src/routes, mounted under /v1 from mountRoutes() in src/app.js. PUBLIC routers must be mounted BEFORE any router that calls router.use(auth), or auth will intercept them.
- Services are classes constructed in makeServices() in src/app.js.
- Collections: add names to COLLECTIONS in src/config/constants.js, and handles + indexes in src/db/connect.js. Stamp writes with stampVersion() from src/db/schemaVersioning.js.
- Public per-router rate limits use middleware/boundedRateLimitStore.js (see routes/community.js).
- Background jobs live in src/jobs and are started/stopped in src/server.js. Pattern: setInterval + single-flight guard + SC2TOOLS_*_DISABLED=1 kill switch; long jobs take a Mongo advisory lock in jobLocks. Copy jobs/ladderMetaRecomputeJob.js and jobs/pulseBackfillJob.js.
- Tests: Jest + mongodb-memory-server + supertest in apps/api/__tests__. Conventions: // @ts-nocheck, jest.mock("@clerk/backend"), buildApp({db, logger, config, io: fakeIo}). Reference: __tests__/overlayLive.routes.test.js.

### Data layout
- `games` holds a SLIM ~3 kB row per game. Allowlists: GAME_SLIM_FIELDS / OPPONENT_SLIM_FIELDS in services/games.js. Fields:
  - result, date, myRace, myBuild (classified opener), map, durationSec, macroScore, top3Leaks, myMmr, isLadderGame, playerCount/matchFormat, gameVersion/gameBuild
  - opponent{race, strategy, opening, leagueId, mmr, pulseId…}
- The slim apm/spq fields are only filled for games uploaded by agent 0.17.2 or later; older rows stay null until re-synced. Treat null as missing, never as zero.
- HEAVY fields (buildLog, oppBuildLog, macroBreakdown, apmCurve, mapPlayback) live in game_details, or as gzip objects in Cloudflare R2 when GAME_DETAILS_STORE=r2.
- A nightly job must NEVER read game_details/R2. It is slow, costly and memory-heavy.

### Opener catalog and reusable rules
- Catalog: 164 named builds with human descriptions in apps/replay-engine/core/build_definitions.py, already served to the web by the catalog service (GET /v1/definitions, services/catalog.js).
- Reuse ladderMeta.js's aggregation rules:
  - Exclusions: non-P/T/Z races, team games, empty labels and "<X>v<Y> - Game Too Short".
  - Bands: opponent league (opponent.leagueId) or 500-point opponent-MMR bands (util/mmrBracketing.js).
  - Splits by patch era; stores week-over-week movement.
- K-anonymity precedent: K_ANONYMITY_THRESHOLD = 5 distinct users in services/community.js.

### Hosting
- The API is ONE Render Starter instance (render.yaml numInstances: 1, ~512 MB).
- Push aggregation into Mongo pipelines: $match on indexed fields first, $project slim fields, $group; allowDiskUse; maxTimeMS. Never materialize the corpus in Node.
- The site is donation-funded. Keep Atlas load modest.

### House rules
- docs/engineeringexplanation.md: files ≤ 800 lines, functions ≤ 60 lines, complexity ≤ 10, no magic numbers.
- Hard rule — ALL DATA IS REAL: never fabricate, pad or mock a number that ships. Below a data threshold, render nothing or "Not enough games yet", never a guess.
- Update CHANGELOG.md under [Unreleased] in the existing user-facing voice.

## What to build

### 1. Ingest-time timing samples (the only cheap way to get corpus timings)
While POST /v1/games is ingesting a game, the heavy fields are already in memory. Capture a tiny anonymous sample there.

**Collection `guide_samples`:** { buildKey, matchup, era, leagueBand, mmrBand, result, map, durationSec, userHash, gameHash, milestones: { <Name>: seconds }, army: { "360": {Unit: count}, "480": {...}, "600": {...} }, createdAt }
- userHash/gameHash are HMACs using the existing util/hash.js pepper (SERVER_PEPPER_HEX). Never store userId, gameId, names or toon handles here.
- Indexes:
  - unique {userHash, gameHash}, so re-uploads and resyncs are idempotent (upsert);
  - {matchup, buildKey, era};
  - TTL on createdAt (~400 days).
- Only sample 1v1 ladder games with a real classified opener (same exclusions as ladderMeta).

**milestones:** the first START time of each item in a per-race milestone catalog you define in apps/api/src/config/guideMilestones.js.
- Protoss example: Pylon, Gateway, Assimilator, Nexus #2, Cybernetics Core, WarpGate research, Twilight Council, Stargate, Robotics Facility, Forge, Blink, Charge, Nexus #3.
- Build equivalent Terran and Zerg lists, including second/third base, key tech buildings and key upgrades.
- Parse the buildLog "[m:ss] Name" lines with the parser the API already uses for build orders. Build logs are parsed on read into {time, name, category, is_building…}; find that code. Do not write a second parser.

**army:** from macroBreakdown.unit_timeline at 360/480/600 s.
- Use the nearest sample no more than 15 s away; otherwise omit that checkpoint. Missing ≠ zero.
- Top 8 unit types only.

**Fail-soft:** sampling must never fail or slow an ingest.
- Wrap it and bound it (< 5 ms typical).
- Log at debug with no PII.
- Count failures in a prom-client counter if metrics are enabled.

**GDPR:** services/gdpr.js deletion must delete this user's samples (compute the user's HMAC at deletion time). Add a test.

**Optional backfill** (admin-triggered, off by default): a throttled job that walks recent game_details to seed samples for existing history.
- At most 2 games/s, advisory lock, resumable cursor, kill switch SC2TOOLS_GUIDE_BACKFILL_DISABLED.
- Ship it disabled and document how to run it.

### 2. Nightly guide stats job
Add `jobs/guideStatsRecomputeJob.js` + `services/guideStats.js`, scheduled after ladderMeta's nightly run.

**Output:** a small `guide_stats` collection:
- one doc per era × matchup × build;
- hub docs per matchup and per map;
- a "counter" doc per matchup × opponent strategy.

Every doc stores computedAt and the sample size behind every number.

**From slim `games` rows** (one aggregation per matchup, not per build):
- games, wins, winRate + 95% Wilson interval
- prevalence within the matchup
- by band: both the league AND MMR axes, same bands as ladderMeta
- by map
- vs opponent strategy (the build × opponent.strategy matrix)
- win rate by game-length bucket ("when does this build win"): 0–6, 6–10, 10–15, 15–20, 20+ min
- average macroScore
- most common top3Leaks names
- week-over-week movement (store the previous run inline, like ladderMeta's prevOpeners)

**From `guide_samples`:**
- Per milestone p25/median/p75, only for milestones present in ≥ 60% of samples. Split winners vs losers when both sides clear the floor.
- Army at 6/8/10 min as "median count when present" + "% of games present".

**Publish floors** (constants, documented):
- Any shown number (a cell) needs ≥ 5 distinct users AND ≥ 30 games.
- A whole page needs ≥ 5 distinct users AND ≥ 100 games in the current era. Otherwise the page is unpublished: the API returns it with published:false and the web renders a noindex "not enough data yet" page.
- Rank lists by Wilson lower bound, never by raw win rate.

**No PII in output:** zero userIds, gameIds, opponent names, pulseIds or toon handles. Add a test that seeds known names and ids and asserts none appear anywhere in any guide_stats doc or API payload.

### 3. Stable slugs
Create `apps/api/src/config/guideSlugs.js`: a deterministic slug from each catalog name.
- Builds: "PvZ - Stargate into Blink" → matchup "pvz", build "stargate-into-blink".
- Opponent strategies (for counter pages) use the same rule; maps use the map name.
- A unit test asserts uniqueness across the whole catalog and snapshot-locks the mapping, so a rename can't silently break URLs.
- Keep an alias map and 301-redirect old slugs.

### 4. Public API (mounted before auth routers)
Endpoints:
- GET /v1/guides (index)
- GET /v1/guides/:matchup
- GET /v1/guides/:matchup/:build
- GET /v1/guides/:matchup/counter/:strategy
- GET /v1/guides/maps/:map
- GET /v1/guides/sitemap (slugs + lastModified for published pages only)

Behavior:
- Validate params against the slug map; 404 otherwise.
- Bounded rate limit.
- Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400.
- Optional query ?band=<league|mmr>:<value>&era=<after|before>, clamped to known values.

### 5. Web pages (server components, ISR)

**/guides — hub**
- 3×3 matchup grid.
- "What's winning this week" per matchup: top 3 by Wilson lower bound, with movement arrows.
- Links to map pages.

**/guides/[matchup]**
- Every published opener in the matchup: win rate + CI whisker, prevalence, n, trend arrow.
- Band switcher links with ?band=; the canonical URL stays the default band.

**/guides/[matchup]/[build] — the money page**, sections in this order:
1. Hero:
   - build name, matchup, one-sentence description from the catalog;
   - headline stat, e.g. "Won 54.2% of 1,204 Diamond games this patch";
   - n and the date of the stats run;
   - CTA buttons (see below).
2. Win rate by league/MMR band: bar chart with interval whiskers and n labels.
3. Key timings table (p25 / median / p75), plus a "winners vs losers" delta column when available. This is the benchmark players want.
4. Army at 6/8/10 minutes, with unit icons from lib/sc2-icons.ts.
5. What it beats / loses to: vs-opponent-strategy table; each row links to that counter page.
6. When it wins: game-length buckets chart.
7. Maps: best and worst maps for this build (≥ floor only), linking to map pages.
8. Common macro leaks for players running it (from top3Leaks) — "what goes wrong".
9. Related:
   - same-race openers in this matchup;
   - community builds implementing it: link /community/builds/<slug> only where the community build's matchup + name clearly match; don't guess;
   - public example replays, only from users who enabled public replay sharing (users.replaySharing). Max 3, no opponent names. Their detail pages require sign-in today, which is an acceptable conversion path.
10. Coach's notes (optional, see below).

**/guides/[matchup]/counter/[strategy]** — "How to beat <strategy> as <race>"
- The user-race openers ranked by win rate against that opponent strategy, with n.
- The strategy's catalog description.
- These pages target "how to beat X" searches. They are just a different slice of the same stats.

**/guides/maps/[map]**
- Map image (lib/map-images.ts).
- Matchup win-rate table on this map.
- Best openers per matchup on this map.

**Rendering**
- Charts are small client islands loaded with next/dynamic. Everything else is server-rendered HTML, so crawlers get real content.
- Use `export const revalidate = 21600`.
- Add a signed on-demand revalidation route (app/api/revalidate-guides/route.ts, HMAC with a shared-secret env var). The API job calls it after a successful run.

**Personal comparison** (converts visitors)
- On build pages, a client component that runs only when signed in. It fetches the user's own games for that build (existing /v1/builds/:name or custom-build endpoints) and shows e.g. "You: 49% over 37 games, median Twilight 4:52 (community 4:31)".
- Signed-out users see "Sign in to compare your timings" instead.

**Prose:** `lib/guides/guideCopy.ts`
- Deterministic templates, like lib/grudge.ts: variant chosen by a seed from the slug, pure function, unit-tested.
- Every sentence must be backed by a number from the payload. Thin samples say so plainly. No LLM.

**Coach's notes**
- Admin-authored markdown per build: `guide_notes` collection {buildKey, body ≤ 4000 chars, updatedBy, updatedAt}.
- Edited from a new /admin "Guides" section backed by admin-gated API routes.
- Render a safe markdown subset (no raw HTML).
- This adds expert authority to the pages.

**CTAs on every guide page:**
- "Track your win rate with this build — free" → sign-up, then /welcome.
- "Practice it on stream": arm a Ghost Build target built from the community median milestones via the existing lib/ghostBuild.ts v2 encoder, and link to the overlay settings.
- "See live meta" → /meta.
- Fire gaEvent("guide_cta_click", {cta, matchup, build}).

### 6. SEO plumbing
- **generateMetadata on every guide page:**
  - a unique title with a real number, e.g. "Stargate into Blink PvZ — 54% win rate at Diamond (Patch 5.0.16) | SC2 Tools";
  - a description with n and date;
  - canonical URL, openGraph + twitter.
- **Dynamic OG images** (opengraph-image.tsx) for guide build pages, counter pages and matchup hubs, following app/p/[handle]/opengraph-image.tsx: build name, matchup, win-rate bar, n, sc2tools.com.
- **JSON-LD:** BreadcrumbList on all guide pages; Article with datePublished/dateModified from computedAt on build pages.
- **Dynamic sitemap:** rewrite app/sitemap.ts to include:
  - static routes;
  - published guide pages (from /v1/guides/sitemap, with real lastModified);
  - published community builds;
  - public /p/ profiles.

  Use generateSitemaps if it would exceed 5,000 URLs. Unpublished pages never appear.
- **Internal links:**
  - /meta opener rows → their guide page;
  - /community/builds/[slug] → its canonical guide, when one clearly matches;
  - the signed-in build dossier → "Community guide";
  - landing page → a "Browse build guides" section;
  - footer link.
- **Google Search Console:** support NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION in root metadata.verification.

## Performance, privacy and abuse
- Guide pages: LCP < 2.5 s on mobile, CLS < 0.1, ≤ 150 kB page JS, Lighthouse SEO 100 and accessibility ≥ 95. No client-side data waterfalls for public content.
- Job: finishes in < 2 min on 1M games. Every pipeline starts with an indexed $match; add any indexes you need and justify them in the PR.
- Aggregates only. K-anonymity floors on every published number. Opponent-strategy labels are classifier output, not identities, so they are fine to publish.
- Poisoning resistance: one user must not be able to move a cell much. Cap each user's contribution per cell (e.g. at most 50 games per user per build per era).

## Tests
- **API (Jest + memory server):**
  - sample capture through POST /v1/games: idempotent re-upload, excluded game types, missing checkpoints, fail-soft;
  - GDPR deletion of samples;
  - recompute job with a seeded corpus: floors, Wilson ordering, era split, per-user cap, week-over-week, idempotent rerun, lock respected;
  - routes: 404 on unknown slug, cache headers, published:false below floor;
  - the NO-PII scan test.
- **Web (vitest):**
  - guideCopy templates: every numeric sentence traceable to input; thin-sample wording;
  - slug helpers;
  - page render from fixtures;
  - noindex when unpublished;
  - metadata titles.
- **Playwright:** add /guides, one matchup page and one build page to the public responsive smoke at 375 px and 1440 px (no horizontal scroll, headline stat visible).

## Rollout
- Flags GUIDES_ENABLED (API) and NEXT_PUBLIC_GUIDES_ENABLED (web), default off.
- The sitemap includes guides only when the flag is on.
- Ship sample capture first, so data accumulates while the pages are being built.

## Out of scope
LLM-written content, user comments on guides, paid placement.

## Definition of done
- [ ] Every catalog build with enough data has a published page; everything else is unpublished and noindex.
- [ ] Every number on every page traces to a guide_stats field with n ≥ floor; no PII in any payload (test proves it).
- [ ] Nightly job and on-demand revalidation work; ingest latency unchanged (measure before and after).
- [ ] Dynamic sitemap, OG images, JSON-LD and canonical URLs validated (Rich Results test passes for BreadcrumbList).
- [ ] api: npm run check; web: npm run lint && npm run typecheck && npm test; Playwright smoke green.
- [ ] CHANGELOG.md entry; docs/guides.md explaining floors, bands, eras and how to run the backfill.

## PR slices
1. guide_samples capture + GDPR + backfill job (disabled).
2. guideStats service + nightly job + public API.
3. Web pages + copy + charts.
4. SEO plumbing: metadata, OG images, JSON-LD, sitemap, internal links, revalidation.
5. Admin Coach's notes.
````

---

## 2. Instant Analysis — replays analyzed in the browser, no download

> Run the exact same Python replay pipeline the agent uses inside a Web Worker (Pyodide). A visitor drops replays and sees real insights about their own games in about a minute, then signs up to keep them. Zero server parsing cost.

````text
You are implementing **Instant Analysis** for sc2tools.com (repo ReSpOnSeSC2/sc2tools). Anyone can analyze their StarCraft II replays in the browser in about a minute, with no download. It works by running the SAME Python replay pipeline the desktop agent uses inside a Web Worker via Pyodide (CPython compiled to WebAssembly). Parsing happens on the visitor's own machine, so this costs the server nothing. Plan first: read the files below, then post a short plan listing every file you'll add or change. Then implement in the PR slices at the end. If the code disagrees with this prompt, the code wins — adapt, and explain the deviation in the PR.

## Why this exists
- Today every feature starts with "install the desktop agent" (/welcome: welcome → download → pairing code → import). That is the biggest drop-off for a gaming tool. It loses:
  - people on a work laptop, Chromebook, iPad or Mac;
  - people wary of running an .exe from a site they found 30 seconds ago;
  - people who were just sent one replay on Discord.
- The landing page already proves the "drop a replay" hook works: components/landing/ReplayDemo.tsx → POST /v1/public/preview-replay, which spawns Python on the API server. That is fine for one demo file and far too expensive for real imports on a single Render Starter instance.
- docs/CLOUD_REPLAY_UPLOAD_ROADMAP.md proposes server-side parsing with Redis + BullMQ + an always-on Python worker. None of that infrastructure exists, and it would multiply a donation-funded hosting bill. This prompt replaces that plan with zero-server-compute parsing. Update that doc's status to "superseded by Instant Analysis", with a link to your new doc.
- Goal: value before sign-up. A visitor drops replays, sees real insights about their own games within a minute, and signs up to keep them. Existing users get a no-agent import path on any device.

## Ground truth (verified)

### The parser
- Entry point: parse_replay_for_cloud_ex in apps/agent/sc2tools_agent/replay_pipeline.py (a 3,600-line module). It calls:
  - parse_deep in apps/replay-engine/core/sc2_replay_parser.py (sc2reader 1.8.0, load_level 4);
  - the engine's event extractor;
  - the strategy detectors (core/strategy_detector*.py, catalog core/build_definitions.py, custom rules via data/custom_builds*.json);
  - analytics/macro_score.py.
- The upload payload shape is CloudGame.to_payload: gameId, date, result, races, map, durationSec, buildLog, oppBuildLog, myBuild, macroScore, myMmr, myToonHandle, opponent{…}, macroBreakdown, apmCurve, spatial, mapPlayback, …
- That path is pure Python + sc2reader, and sc2reader's dependency mpyq is also pure Python. numpy/scipy/pandas are NOT needed for it; scipy is only used by the API's spatial KDE CLI.
- Must be disabled in the browser:
  - threads and process pools;
  - filesystem caches (the player_handle cache);
  - network lookups (core/pulse_resolver.py uses urllib);
  - engine capture (s2client / sc2_observation_export.py needs a local SC2 install).

### Server-side enrichment
- jobs/pulseBackfillJob.js and jobs/opponentMmrEnrichmentJob.js already fill Pulse ids and opponent MMR/league after ingest, so skipping Pulse lookups in the browser is acceptable.
- Verify which fields end up missing compared to agent uploads, and list them in the PR.

### Ingest
- POST /v1/games uses the shared auth middleware (apps/api/src/middleware/auth.js). It accepts a Clerk session JWT as well as a device token, so the browser can call it directly with `getToken()`. Clerk tokens are short-lived: fetch a fresh one per batch.
- Bodies: {games:[…]}, ≤ 50 games and ≤ 5 MiB JSON.
- The route sits behind middleware/replayIngestAdmission.js (REPLAY_INGEST_MAX_ACTIVE=1). It returns a retryable 503 before parsing the body, so the client must:
  - respect Retry-After and back off exponentially with jitter (max ~60 s);
  - upload strictly one batch at a time.
- Validation is AJV in src/validation/gameRecord.js. Heavy fields go to game_details/R2 automatically.

### Original replay backup
- Exists for agents: POST /v1/games/:id/replay-upload → signed R2 PUT → /replay-upload/complete (5 MB cap).
- Only available when REPLAY_FILES_STORE=r2.

### Web
- Next.js 15 App Router, React 19, Tailwind tokens, UI kit components/ui, useApi/apiCall in lib/clientApi.ts, GA4 gaEvent in lib/analytics/gtag.ts.
- Pure client libraries you can run on parsed payloads with no server:
  - lib/seasonRecap.ts (computeSeasonRecap over ArcadeGame-shaped rows);
  - lib/lossAutopsy.ts (one lost game's macro causes from MacroBreakdownData + buildLog);
  - lib/dailyPulseContext.ts.
- next.config.mjs sets no Content-Security-Policy today. If one exists by the time you build this, the worker needs 'wasm-unsafe-eval'.

### Fixtures and constraints
- Fixture replay: apps/replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay. Add 2–3 more small ladder replays covering Terran and Zerg perspectives for parity tests; your own games are fine.
- Single Render Starter API instance.
- ALL DATA IS REAL: never show an insight the payload can't support.
- docs/engineeringexplanation.md size and complexity rules.
- CHANGELOG.md entry.

## What to build

### 1. One Python entry point shared by the agent and the browser (no forked logic)
- Add a pure function, e.g. `parse_replay_bytes(data: bytes, *, filename: str, runtime: RuntimeOptions) -> dict`.
  - It produces exactly the payload CloudGame.to_payload produces, by calling the same functions parse_replay_for_cloud_ex calls.
  - RuntimeOptions explicitly turns off threads, file caches, network lookups and engine capture.
  - sc2reader can load from a file-like object. If some code path needs a path, write the bytes to Pyodide's in-memory FS.
- The agent keeps its current behavior. Either keep calling parse_replay_for_cloud_ex or route it through the new function — whichever is lower risk.
- Parity test (pytest, CPython): for every fixture replay, the agent path and the browser-mode path produce identical JSON, except an explicit, documented allowlist of runtime-only fields (e.g. Pulse ids the agent resolved over the network).
- gameId MUST be identical. Confirm gameId derivation doesn't depend on the file path; otherwise an agent re-sync would duplicate browser-imported games. If it does, fix that first.

### 2. Browser engine bundle
- Script apps/web/scripts/build-browser-engine.mjs, run in CI and before `next build`. It:
  1. builds pure-Python wheels for sc2reader==1.8.0 and mpyq in a clean venv (the README documents that mpyq fails to build against Debian's patched setuptools);
  2. zips only the engine/agent modules and data files the entry point needs;
  3. writes public/engine/<engineVersion>/manifest.json with the SHA-256 of every asset and the engine VERSION (apps/replay-engine/VERSION).
- Self-host a pinned Pyodide release under public/pyodide/<version>/, copied from the pinned `pyodide` npm package — not hot-linked from a CDN.
- Versioned paths get Cache-Control: public, max-age=31536000, immutable.
- Extend the existing version-check workflow so the bundle's engine version can't drift from apps/replay-engine/VERSION.

### 3. Worker + typed client
- **apps/web/lib/instant/engineWorker.ts** (module worker):
  - lazily loads Pyodide + wheels + engine zip, only when the feature is used — never on normal page loads;
  - verifies each asset's SHA-256 with SubtleCrypto against the manifest before executing it;
  - parses files sequentially and posts progress events {phase, index, total, fileName, ms, ok|error}.
- **apps/web/lib/instant/engineClient.ts:**
  - promise-based API (parseFiles, cancel);
  - per-file timeout of 60 s → mark the file failed and continue;
  - recycles the worker every ~150 files to bound WASM heap growth;
  - surfaces clean error kinds: unsupported_version, corrupt_file, timeout, out_of_memory, not_1v1, …
- The main thread never blocks for more than 50 ms.

### 4. Getting files in
- Drag-and-drop + multi-select file input: accept .SC2Replay. On iOS, use a permissive accept and check the extension.
- .zip support: unzip inside the worker with Python's zipfile (no new JS dependency).
- **Folder Sync** (Chromium desktop):
  1. window.showDirectoryPicker → the user picks their "StarCraft II/Accounts" folder.
  2. Recursive walk, limited to Replays/Multiplayer.
  3. Persist the directory handle in IndexedDB.
  4. On later visits, call queryPermission({mode:"read"}):
     - if granted, auto-scan when /app gains focus (debounced, at most once per 10 min);
     - if "prompt", show a one-click "Resume sync" button (it needs a user gesture).
  5. Keep a local ledger in IndexedDB of {path, size, lastModified} and skip unchanged files.
- Firefox/Safari fallback: <input webkitdirectory>.
- Show OS-specific path hints: Windows Documents\StarCraft II\Accounts; macOS ~/Library/Application Support/Blizzard/StarCraft II/Accounts.
- Date filter before parsing ("last 90 days" by default, or all), with a file count and time estimate.

### 5. "Which player is me?"
- With Folder Sync, the path contains the toon handle (…/Accounts/<accountId>/<region>-S2-<realm>-<id>/Replays/…). That gives exact identification, using the same rule the agent uses.
- Loose files: pick the player present in ≥ 60% of the batch, then confirm with a one-tap chooser (name + race + game count).
- Signed-in users: prefer toon handles already on their profile (users.pulseIds).
- Save confirmed handles to the profile via the existing PUT /v1/me/profile.

### 6. Anonymous "try it" mode — /try (public route)
- Parse up to 25 replays locally with no account. Nothing leaves the browser; say so on the page.
- Render an instant report from the parsed payloads using the existing pure libs:
  - record by matchup;
  - your openers with W-L;
  - most-faced opponent;
  - average macro score and the most expensive leaks (macroBreakdown.top_3_leaks);
  - a Loss Autopsy card for the most recent loss (lib/lossAutopsy.ts).

  Every card hides itself when its data is missing.
- Store payloads in IndexedDB. They expire after 7 days; provide a "Clear local data" button.
- CTA: "Save these games to your free account" → Clerk sign-up with a redirect back to /try?resume=1 → upload the stored payloads (no re-parse) → land on /app.
- Also add:
  - a landing-page hero CTA, "No download — analyze your replays in your browser", next to the existing download CTA;
  - an option on /welcome step 2: "Skip the download — import in your browser".

### 7. Signed-in import
- Settings → Import: a "Browser import (no agent)" card with the same flow, plus Folder Sync status.
- Today page empty state (no agent, no games): offer both options side by side.
- Upload in byte-budgeted batches: ≤ 50 games, ≤ 4.5 MiB serialized (mirror the agent's upload_json budgeting).
- Tag each game with ingestSource:"browser" and engineVersion. Store them in game_details, or add them to the slim allowlist only if they need to be queryable (respect the ~3 kB slim-row budget).
- New endpoint POST /v1/games/exists {gameIds: string[] ≤ 500} → the ids the caller already has, so re-imports skip uploads. Clerk auth only, rate-limited, index-backed.
- Optional "Also back up original replay files" toggle:
  - default on only when the API reports REPLAY_FILES_STORE=r2 through an existing capabilities or /me endpoint;
  - reuse the signed-URL flow;
  - document the R2 CORS rule needed for a browser PUT from sc2tools.com.
- Per-user browser ingest cap (e.g. 5,000 games/day) on top of existing limits.

### 8. Be honest about what the browser can't do
Show a small comparison table (Browser vs Desktop agent) covering:
- live pre-game scouting and OBS overlay data — the browser can't read the SC2 client API on localhost:6119, so don't try;
- syncing while you play without a tab open;
- accurate engine playback capture (needs SC2 installed);
- OBS scene switching.

Put an "Install the agent for live features" upsell at those touchpoints (overlay settings, live-game panel).

## Budgets
- Pyodide + engine cold start ≤ 6 s on 50 Mbit/s (≤ 1 s warm from HTTP cache).
- Median parse ≤ 3 s for a 15-minute 1v1 on a 2020 laptop.
- Worker memory ≤ 700 MB.
- Zero new server CPU beyond normal ingest.

Measure on real hardware and put the numbers in the PR.

## Security and privacy
- Files never leave the device. Only the same parsed payload the agent sends is uploaded, plus the optional original backup.
- Execute only same-origin, versioned, hash-verified assets.
- The server stays the source of truth: identical AJV validation for browser and agent uploads. The browser is untrusted — so is the agent.
- Never log file names or player names at info level.
- Update /legal/privacy to describe browser parsing and IndexedDB storage.

## Analytics (gaEvent)
- instant_open
- instant_files_selected {count, source: drop|picker|folder|zip}
- instant_parse_done {ok, failed, median_ms}
- instant_report_view
- instant_signup_click
- instant_upload_done {games}
- instant_folder_sync_resume
- instant_error {kind}

## Tests
- The pytest parity test (above), in the python-tests workflow.
- A Pyodide-in-Node test (using the pinned `pyodide` npm package) that parses the fixture replays and compares against the CPython golden JSON. Run it in CI; mark it slow if needed.
- **vitest:**
  - engineClient with a mocked worker: timeouts, cancel, recycle;
  - me-detection;
  - ledger diffing;
  - batch builder (byte budget);
  - upload backoff on 503 + Retry-After;
  - /try report cards (null-safety);
  - IndexedDB expiry.
- **API Jest:**
  - a Clerk-authed browser batch is accepted through POST /v1/games;
  - /v1/games/exists;
  - per-user cap;
  - ingestSource and engineVersion are stored.
- **Playwright:** /try loads, accepts the fixture replay via setInputFiles and shows the report (a slow tag is fine).

## Rollout
- Flag NEXT_PUBLIC_INSTANT_IMPORT, default off → admins → everyone.
- Keep /v1/public/preview-replay for the landing demo until /try fully replaces it, then point the demo at the in-browser engine.

## Definition of done
- [ ] A signed-out visitor goes from landing → /try → report in under ~60 s for 10 replays, with no server parsing.
- [ ] Signed-in import and Folder Sync upload games that render identically in every analyzer tab to agent-uploaded games (parity test + manual check of the same replay imported both ways, with no duplicates).
- [ ] Budgets met and recorded; the worker never freezes the UI.
- [ ] Lint, typecheck and tests green in the web, api and python workflows; CHANGELOG.md; docs/instant-analysis.md (architecture, asset pipeline, how to bump Pyodide or the engine).

## PR slices
1. Python entry point + parity tests (+ gameId determinism fix if needed).
2. Engine bundle build + self-hosted Pyodide + worker/client.
3. /try anonymous flow + landing CTA.
4. Signed-in upload, /v1/games/exists, Folder Sync, Settings and /welcome integration.
5. Optional original-replay backup + docs.
````

---

## 3. SC2 Tools Coach — a grounded AI coach that has watched every game you've played

> Chat, per-game "Coach review" and a Monday "Weekly Game Plan". Claude explains and prioritizes; your existing deterministic engines supply every fact, and every number is verified before it's shown. Hard spend caps keep it affordable on a donation-funded site.

````text
You are implementing **SC2 Tools Coach**, an AI coach for sc2tools.com (repo ReSpOnSeSC2/sc2tools) built on the Claude API. It answers a player's questions from their own replay data, reviews individual games, and writes a weekly game plan — and it never invents a number. Plan first: read the files below, then post a short plan listing every file you'll add or change. Then implement in the PR slices at the end. If the code disagrees with this prompt, the code wins — adapt and explain in the PR.

## Why this exists
- sc2tools already computes a huge amount per player, all of it deterministic and spread across dozens of charts:
  - macro report with leaks priced in minerals;
  - loss autopsy and ghost-build grading;
  - opponent dossiers;
  - build/strategy matrices;
  - MMR trends and league percentiles.

  Players want one thing: "what do I fix next?"
- There is no LLM anywhere in the product today; several modules say "No LLM" on purpose. The Coach must keep that trust: the model explains and prioritizes; the deterministic engines supply every fact.
- It is the headline feature that makes people talk about the site: "the first SC2 coach that has watched every game you've played".

## Ground truth (verified)

### apps/api
- Express 4, CommonJS + JSDoc (tsc --noEmit checkJs), MongoDB 6, AJV.
- Routers are buildXRouter(deps) in src/routes, mounted under /v1 in mountRoutes() (src/app.js). Services are classes built in makeServices() in src/app.js.
- Collections go in COLLECTIONS (src/config/constants.js) + src/db/connect.js. Stamp writes with stampVersion().
- Jobs in src/jobs (setInterval + single-flight + jobLocks advisory lock + SC2TOOLS_*_DISABLED switch), started in src/server.js.
- prom-client metrics in routes/metrics.js; Sentry in util/sentry.js; pino with credential scrubbing.
- Auth: req.auth = {userId, clerkUserId, source}; isAdmin(req) exists.
- GDPR: services/gdpr.js lists every user-data collection for export/delete. New collections MUST be added there.
- Tests: Jest + mongodb-memory-server + supertest in apps/api/__tests__. Conventions: // @ts-nocheck, jest.mock("@clerk/backend"), buildApp({...}) with a fake io. Reference: __tests__/overlayLive.routes.test.js.

### Data services the Coach should wrap
All read-only, and always scoped on the server to req.auth.userId:
- AggregationsService (see routes/aggregations.js): summary, matchups, maps, build-vs-strategy, timeseries including mmr, length-buckets, momentum, streak, macro/summary, macro/report.
- OpponentsService: list; dossier with byMap/byStrategy/predictedStrategies/medianTimings/last5Games; games.
- GamesService: slim rows, games-list.
- Per-game build order + macro breakdown (routes/perGame.js). Heavy data comes via GameDetailsService and may be in R2.
- BuildsService + buildsMmrStats: per-build performance, aging curve.
- LeaguePercentilesService (routes/benchmarks.js).
- LadderMetaService (public meta).
- SkillFingerprintService.

Global filters are parsed by util/parseQuery.js (parseFilters/gamesMatchStage). Reuse them rather than writing new filter code. The slim apm/spq fields are only filled for games uploaded by agent 0.17.2 or later; older rows stay null until re-synced, so treat null as missing, never as zero.

### Web
- Next.js 15 / React 19 / Tailwind tokens / components/ui kit; useApi + apiCall (lib/clientApi.ts).
- An authenticated streaming pattern already exists in lib/useLiveGame.ts: fetch + ReadableStream reader, because EventSource can't send the Clerk Bearer token. Copy that pattern.
- The app shell and context bar live in components/chrome (AppChrome.tsx, appNav.ts).
- Game page: components/analyzer/game/GameDetailPage.tsx. It supports ?t= deep links; MapReplayer is a controlled component with time/onTimeChange.
- Existing pure engines you can surface or reference: lib/lossAutopsy.ts, lib/ghostGrade.ts + lib/ghostBuild.ts (arm a target build), lib/dailyQuests.ts, lib/dailyPulse.ts.
- Share-card helpers: components/analyzer/arcade/ShareCard.tsx + lib/battleCard.ts.

### Hosting, cost and house rules
- One Render Starter API instance (~512 MB, numInstances 1).
- Donation-funded (see /donate and lib/infrastructureCosts.ts). The Coach needs hard spend caps and must degrade gracefully when they're hit.
- docs/engineeringexplanation.md; ALL DATA IS REAL; never log PII; CHANGELOG.md entry.

## Claude API usage (follow exactly; check current Anthropic docs for exact SDK call shapes)

**SDK**
- Use the official `@anthropic-ai/sdk` in apps/api, pinned to an exact version.
- CommonJS: resolve the export defensively, the way app.js does for express-rate-limit (`mod.default || mod`).
- Construct the client once in makeServices() and inject it through deps, so tests can pass a fake.

**Model and effort**
- Model from env AI_COACH_MODEL, default `claude-opus-5`. Do not hard-code model ids anywhere else.
- Adaptive thinking: `thinking: {type: "adaptive"}`.
- Effort per route via `output_config: {effort}`, tunable by env: chat "medium", game review "high", weekly plan "high". Measure before changing.

**Refusals**
- Always check stop_reason before reading content.
- Enable server-side refusal fallbacks on interactive requests: `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta. The Batches API doesn't support it, so omit it there.
- On a final "refusal", show a friendly message and log the category (no user text in logs).

**Prompt caching**
- Order: tools (deterministic order, frozen descriptions) → system prompt (static text only: no dates, names, userIds or anything per-request).
- Put an explicit cache_control breakpoint on the last system block, and use top-level automatic caching for the growing conversation.
- Per-user context (race, league, current MMR, today's date, page context) goes in the first user message, never in the system prompt.
- Opus 5's minimum cacheable prefix is 512 tokens, so tools + system will cache.
- Log usage.cache_read_input_tokens and alert if the hit ratio collapses (a sign of a silent cache invalidator).

**Chat: manual streaming tool loop** (`client.messages.stream(...)` + `finalMessage()`)
- At most 6 iterations.
- Run all tool_use blocks of a turn in parallel (5 s timeout each) and return all tool_result blocks in ONE user message.
- Append the assistant `content` array unchanged; this keeps thinking blocks valid.
- Failed tools return `is_error: true`.
- Set `eager_input_streaming: true` on each tool, and validate every parsed tool input with AJV before executing. Invalid input → is_error "INVALID_INPUT".
- Never execute a tool_use that was cut off by max_tokens.

**Game review and weekly plan: no tools**
- The server assembles a deterministic facts packet and makes one structured-output request (`output_config: {format: {type: "json_schema", …}}`), then validates the JSON with AJV.

**Weekly plans use the Message Batches API**
- 50% cheaper. Most batches finish within an hour; the maximum is 24 h.
- Results come back in any order — key them strictly by custom_id.

**Cost accounting** from every response's usage:
- input tokens;
- cache writes (5-minute-TTL writes cost 1.25× input);
- cache reads (0.1× input);
- output tokens (thinking tokens are billed as output);
- batch requests at 0.5×.

Keep a per-model price table in src/config/constants.js, with a comment to re-check Anthropic's pricing page when changing models. At the time of writing, per million input/output tokens: claude-opus-5 $5 / $25; claude-sonnet-5 $2 / $10; claude-haiku-4-5 $1 / $5.

## What to build

### 1. Budget, quotas and consent (build first)
- **`ai_usage` collection:**
  - per-user per-day docs: {userId, day, messages, gameReviews, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costMicros};
  - per-month global docs;
  - atomic $inc after every API call.
- **Env settings:**

  | Variable | Default | Purpose |
  |---|---|---|
  | AI_COACH_ENABLED | off | master switch |
  | AI_COACH_ALLOWLIST | — | comma-separated userIds for the beta |
  | AI_COACH_DAILY_MESSAGES | 10 | chat messages per user per day |
  | AI_COACH_DAILY_GAME_REVIEWS | 3 | game reviews per user per day |
  | AI_COACH_SUPPORTER_MULTIPLIER | 5 | quota multiplier for supporters |
  | AI_COACH_MONTHLY_BUDGET_USD | 25 | global monthly spend cap |

- **Budget behavior:**
  - At 80% of budget, only supporters keep chat.
  - At 100%, everything pauses until next month, with a clear banner: "Coach is resting until Oct 1 — supporters keep it running" → /donate.
  - Cached game reviews and existing plans stay readable.
- **Supporter flag:** users.supporter {since, note}, toggled by admins in /admin/users/[userId]. /donate gets one line: "Supporters get 5× Coach."
- **Concurrency:** at most 1 active stream per user and ~6 globally (an in-process semaphore; it's one instance) → 429 {code: "coach_busy"}.
- **Consent:**
  - First use shows a modal explaining that aggregated stats, build orders and opponent display names from the user's games are sent to Anthropic to generate answers.
  - Store consent {version, at} on the user.
  - Update /legal/privacy to list Anthropic as a subprocessor.
  - Never send email, Clerk ids, battle tags or toon handles to the model.

### 2. Coach tools (read-only, compact)
Implement services/coachTools.js exposing ≤ 10 tools with frozen names, descriptions and JSON schemas (strict, additionalProperties false). The model never supplies a userId. Suggested set:
- get_overview {period?}
- get_matchup_breakdown {matchup, period?}
- get_macro_report {matchup?, period?}
- list_games {filters, limit ≤ 20}
- get_game_analysis {gameId}
- get_opponent_dossier {pulseId | nameQuery}
- get_build_stats {build}
- get_benchmarks {matchup}
- get_trends {metric: winrate|mmr|macro, period}
- get_meta {matchup, band?}

Result rules:
- Each result is compact JSON: rounded numbers, top-N lists, time series downsampled to ≤ 30 points, ≤ ~6 KB total. Strings are capped (names ≤ 32 chars) with control characters stripped.
- Each result carries `refs`: stable ids the answer can cite, mapped server-side to deep links. Examples:
  - game:<gameId> → /app/game/<gameId>
  - game:<gameId>@312 → ?t=312
  - opp:<pulseId> → /app/opponents/<pulseId>
  - macro:<matchup> → /app/macro with the right filter params (check lib/filterContext.ts for names)
  - build:<name> → the build dossier

Prompt-injection hardening:
- Opponent names, build names and notes come from replays and users. Anyone can name their account "ignore previous instructions".
- Tool results are data, and the system prompt says so explicitly.
- No tool can write, send or reveal anything.

### 3. Grounding: no invented numbers
Build services/coachGrounding.js, a pure, heavily unit-tested checker.
1. Extract every numeric claim from the answer: integers, decimals, percentages, m:ss times, "4.2k"-style MMR.
2. Build the allowed set from this turn's tool results + the facts packet + the user's own message. Include derived display forms: 0.542 ↔ 54.2% ↔ 54%, 312 ↔ 5:12, 4213 ↔ 4.2k.
3. Small counting words/numbers ≤ 10 are allowed.
4. Any unverified number triggers one automatic repair turn listing the offending numbers ("remove or correct these; they are not in the data").
5. If it still fails, remove the offending sentences and mark the answer "partially verified".

Display and metrics:
- The web never shows an unverified number. Status events stream while tools run; the final answer is verified first, then streamed to the client as the answer event.
- Track the grounding pass rate in prom-client and on the admin tile.

Citations:
- The model writes [[ref:<id>]] tokens.
- The server drops any id not present in this turn's refs.
- The UI renders the surviving refs as chips that deep-link (and seek the replay for game:…@t refs).

### 4. Chat
- **POST /v1/coach/chat** (Clerk auth, SSE response). Body: {conversationId?, message (≤ 1,000 chars), pageContext?: {surface, gameId?, pulseId?, matchup?, filters?}}.
  - The server re-fetches any data the page context points at; it never trusts client-sent numbers.
- **SSE events:**
  - status {label}, e.g. "Checking your PvZ games…" (derived from tool names);
  - answer {markdown, refs[], verified};
  - usage {remainingToday};
  - error {code};
  - heartbeat comments every 15 s.
- **Transport:**
  - Disable buffering: flush headers and send X-Accel-Buffering: no.
  - On client disconnect, abort the upstream Claude stream via AbortController so tokens stop being billed.
- **`ai_conversations` collection:** {userId, title, messages (SDK content blocks, append-only), model, createdAt, updatedAt}.
  - TTL 90 days; max 20 user turns per conversation.
  - List and delete endpoints; included in GDPR export/delete.
- **System prompt** (a versioned constant, COACH_PROMPT_VERSION):
  - an expert SC2 coach voice;
  - concise (≤ 200 words unless asked);
  - lead with the single most impactful fix;
  - every claim backed by a tool result with a ref;
  - say "I don't have data on that" rather than guess;
  - no generic advice that contradicts the user's data;
  - SC2 terminology is fine;
  - never mention internal tool names.

### 5. Game review ("Coach review" on /app/game/[gameId])
- **POST /v1/coach/games/:gameId/review** builds a facts packet:
  - result, matchup, map, durations;
  - the first ~40 lines of both build orders;
  - supply-block windows and float spikes;
  - inject/chrono/MULE actual vs expected;
  - army value series at 30 s;
  - the same inputs Loss Autopsy uses;
  - the user's usual timings for this build;
  - head-to-head history with this opponent.

  It then makes one structured request with the schema {headline, verdict, keyMoments: [{t, title, detail, refs}] ≤ 3, strengths ≤ 2, fixFirst {title, detail, drill}, practiceBuild?}.
- Grounding-check the output against the packet.
- Cache results in `coach_reviews` (unique {userId, gameId, promptVersion}). Reopening is free; "Regenerate" counts against quota.
- **UI:**
  - a panel on the game page;
  - keyMoment timestamps seek the MapReplayer and timeline (?t=);
  - "Arm this as a Ghost Build" when practiceBuild maps to real build-log steps (lib/ghostBuild.ts).

### 6. Weekly Game Plan
**jobs/coachWeeklyPlanJob.js** runs hourly.
- Eligible users:
  - opted in;
  - their local Monday 07:00 has passed;
  - no plan yet for that ISO week;
  - ≥ 8 ranked games in the prior 7 days.
- For each, it builds a facts packet:
  - W-L by matchup vs the previous week;
  - MMR delta;
  - macro trend + top leaks priced in minerals;
  - worst map, nemesis, best and worst build;
  - league percentile.
- It submits a batch with custom_id = userId:isoWeek.
- The same job polls open batches (`coach_batches`) every ~10 minutes.

**Output schema:** {summary, wins[], focusAreas[≤3: {title, why, evidenceRefs, drill}], mapVeto?, goals[≤3]}.
- goals use a tiny verifiable DSL. The web checks it against the week's slim game rows with a new pure lib/coachGoals.ts:
  - winrate_in_matchup {matchup, target, minGames}
  - games_with_build {build, count}
  - macro_score_avg {matchup?, target}
  - avoid_supply_block {maxSecPerGame}
- The schema enumerates the allowed goal types; out-of-range params are rejected.

**After results arrive:**
- Validate + ground, and store in `coach_weekly_plans`.
- Emit a `coach:plan` socket event to the user:<userId> room (see lib/useUserSocket.ts).
- Show a "This week's plan" card on Today (components/dashboard/TodayView.tsx) with live goal progress.

**Opt-in** toggle in Settings; unsubscribing stops generation immediately.

### 7. Web UI
- **Entry point:** an "Ask Coach" button in the context bar (AppChrome) and the mobile More sheet opens a CoachDrawer:
  - right-side sheet on desktop, full-screen on mobile;
  - focus-trapped, Esc to close;
  - aria-live for status.
- **Suggested questions** are generated deterministically from the user's data (worst matchup, current losing streak, nemesis, biggest macro leak). No LLM call is used to make suggestions.
- **Rendering:** a restricted markdown subset (bold, italics, lists, ref chips); no raw HTML.
- **Feedback:** 👍/👎 with an optional reason → `coach_feedback` (for offline evals).
- **Sharing:** "Share this insight" → a canvas share card via the ShareCard helpers (question + first 280 characters + sc2tools.com).
- **Quota meter.**
- **Empty state** when the user has < 5 games: "Play a few games and I'll have something to say".
- **Surface-aware openers:**
  - from an opponent dossier: "How do I beat <opponent>?"
  - from Macro: "What's my most expensive habit?"
  - from a loss: "Why did I lose this?"

### 8. Evals (manual, costs money — not in CI)
- Build apps/api/scripts/coach-eval/ with a seeded fixture corpus and ~30 real questions.
- Automatic checks: grounding pass = 100%, ≥ 1 valid ref, word limit, no refusal.
- It prints the cost per question.
- Run it before changing the model, prompt or effort, and record the results in the PR.

## Tests (CI, no network)
- **Fake Anthropic client** injected through deps, with scripted streams covering:
  - tool_use → results → final;
  - parallel tools;
  - invalid tool input;
  - max_tokens mid-tool;
  - refusal;
  - unverified number → repair → pass and fail cases.
- **Budget and limits:**
  - quota and budget breaker (80% / 100% thresholds, supporter multiplier);
  - semaphore 429.
- **Transport:** SSE framing, heartbeat, and client abort cancelling upstream.
- **Grounding and refs:**
  - grounding checker unit suite (≥ 40 cases, including rounding and time formats);
  - ref validation.
- **Game-review cache.**
- **Weekly job** with a fake batch client: submit, poll, out-of-order results, expired/errored entries.
- **GDPR** export/delete covering every new collection.
- **Web vitest:** CoachDrawer states, markdown-subset sanitization, ref-chip navigation, coachGoals verification.

## Rollout
- AI_COACH_ENABLED + NEXT_PUBLIC_AI_COACH_ENABLED, default off → AI_COACH_ALLOWLIST (admins) → supporters → everyone.
- Admin tile on /admin:
  - month-to-date cost vs budget;
  - requests;
  - cache hit ratio;
  - grounding pass rate;
  - 👍 ratio;
  - top refusal categories.

## Out of scope
Voice coaching, live in-game coaching, bring-your-own API keys, coaching other users' games.

## Definition of done
- [ ] Chat, game review and weekly plan work end-to-end on real data; every number shown is verified against tool/packet data (grounding tests + an eval run attached to the PR).
- [ ] Hard spend caps enforced; costs visible to admins; disconnects stop billing.
- [ ] Consent + privacy page + GDPR coverage.
- [ ] api npm run check and web lint/typecheck/test green; CHANGELOG.md; docs/coach.md (architecture, prompts, cost model, how to change model/effort safely).

## PR slices
1. Usage/budget/quotas/consent + client wiring + fake-client test harness.
2. Tools + grounding + chat SSE + drawer.
3. Game review.
4. Weekly plan job + Today card + coachGoals.
5. Evals, admin tile, docs.
````

---

## 4. Squads + the SC2 Tools Discord app

> Clans, teams and practice groups with a **shared scouting pool** ("your teammate faced this guy 3×, he cannon rushed twice"), a live feed, and weekly leaderboards. Everything posts into the Discord servers where SC2 communities already live. Discord runs over webhooks only: no bot process, so it fits the single Starter instance.

````text
You are implementing **Squads + the SC2 Tools Discord app** for sc2tools.com (repo ReSpOnSeSC2/sc2tools). Squads are self-serve groups — clans, teams, practice partners, coaching groups, college clubs, streamer communities — with a shared scouting pool, a live activity feed and weekly leaderboards, piped into Discord servers where StarCraft communities already live. Plan first: read the files below, then post a short plan listing every file you'll add or change. Then implement in the PR slices at the end. If the code disagrees with this prompt, the code wins — adapt and explain in the PR.

## Why this exists
- sc2tools has no social layer:
  - no friends, teams, invites or comments;
  - no user-facing notifications (the only notifications are the admin inbox and coaching alerts);
  - no Discord integration.

  Every user experiences the product alone, so nobody has a reason to invite anyone.
- SC2 players organize in Discord servers. Every server that installs the app gets a steady stream of sc2tools-branded result cards and leaderboards in front of dozens or hundreds of players — the cheapest growth channel available.
- A shared scouting pool is the product reason to recruit friends: "your teammate faced this player three times — he cannon rushed twice". The more squadmates, the more intel. That is a network effect.

## Ground truth (verified)

### apps/api
- Express 4, CommonJS + JSDoc (tsc checkJs), MongoDB 6, AJV.
- Routers are buildXRouter(deps), mounted in mountRoutes() (src/app.js). Public and webhook routers must be mounted before routers that call router.use(auth). Services are built in makeServices().
- Collections in COLLECTIONS (src/config/constants.js) + src/db/connect.js; stampVersion() on writes.
- Jobs: setInterval + single-flight + jobLocks + SC2TOOLS_*_DISABLED, started in src/server.js.
- Rate limits: middleware/boundedRateLimitStore.js.
- Content moderation helper: util/contentFilter.js.
- Reports and an admin moderation queue exist for community builds (community_reports, /v1/community/admin/reports, web /admin/moderation). Extend them rather than building a second queue.
- GDPR: services/gdpr.js must list every new collection.

### Ingest hook point
- POST /v1/games (routes/games.js):
  1. upserts via GamesService.upsertWithRevision;
  2. on first insert, calls opponents.recordGame;
  3. emits games:changed / overlay:session / overlay:live.
- Trigger squad feed events and Discord posts there, after the response-critical work. Never slow down or fail ingest.

### Real-time
- Socket.IO with rooms user:<userId> (src/socket/auth.js; web hook lib/useUserSocket.ts).
- One process with the in-memory adapter — fine for this feature.

### Credentials and raw bodies
- Encrypted credential storage already exists for platform OAuth: services/platformCredentialVault.js (PLATFORM_TOKEN_ENCRYPTION_KEY). Use it for Discord webhook URLs and tokens.
- OAuth state handling exists in services/platformOauthClients.js / platform_oauth_states. Mirror those patterns.
- Raw bodies for signature checks: middleware/jsonBody.js captureSignedWebhookRawBody keeps the raw buffer only for an explicit path allowlist (Clerk, Twitch, Kick). Add the Discord interactions path to that allowlist.

### Opponent identity and live scouting
- games.opponent.pulseId is the per-opponent storage key (a toon handle).
- The opponent dossier is OpponentsService.get(userId, pulseId) (routes/opponents.js; web ProfileView under /app/opponents/[pulseId]).
- The live pre-game envelope comes from services/liveGameBroker.js (GET /v1/me/live SSE) and the overlay scouting widgets (components/overlay/widgets/ScoutingWidget.tsx).

### Web and constraints
- Next.js 15 / React 19 / Tailwind tokens / components/ui.
- Nav model: components/chrome/appNav.ts (desktop rail, mobile tab bar, More sheet).
- useApi/apiCall; GA4 gaEvent.
- One Render Starter instance → no Discord gateway websocket, no new always-on process, no Redis.
- Donation-funded. ALL DATA IS REAL. docs/engineeringexplanation.md rules. CHANGELOG.md.

## What to build

### 0. Notifications primitive (shared; if it already exists from another feature, reuse it)
- **Collection `notifications`:** {userId, kind, title, body, href, actorId?, groupKey, readAt, createdAt}; TTL 90 days; index {userId, readAt, createdAt}.
- **Endpoints:**
  - GET /v1/notifications (cursor)
  - GET /v1/notifications/unread-count
  - POST /v1/notifications/read {ids | all}
- Push `notifications:new` to user:<userId>.
- **UI:** a bell with an unread badge in the context bar (components/chrome) plus a panel; a mobile More-sheet entry; per-kind mute settings in Settings.

### 1. Squads core
- **Collections:**
  - `squads`: {slug, name (3–32), tag (2–5, [A-Z0-9]), description ≤ 280, color, race?, visibility: invite_only|request_to_join|public_listed, ownerId, memberCount, createdAt}
  - `squad_members`: {squadId, userId, role: owner|officer|member, joinedAt, sharing: {results, mmr, opponentIntel, leaderboards}}
  - `squad_invites`: {code, squadId, createdBy, expiresAt, maxUses, uses}
  - `squad_join_requests`
- **Limits** (constants): 50 members per squad; 5 squads per user; 3 squads created per user. Names and descriptions go through contentFilter.
- **Endpoints** (Clerk auth):
  - create/update/delete squad;
  - invite create/revoke; join by code;
  - join request/approve/deny;
  - leave; kick/ban; promote/demote; transfer ownership;
  - update my sharing toggles.
- **Consent:**
  - The join dialog shows each sharing toggle with a plain explanation.
  - opponentIntel is off by default and labeled "recommended".
  - Leaving a squad removes your data from every squad view immediately. Views query current consenting members; nothing is copied.

### 2. Invite links (the growth loop)
- **Public page /s/join/[code]:** squad card (name, tag, member count, combined record this week) + "Join with SC2 Tools".
  - Signed-out → Clerk sign-up with a redirect back → auto-join after onboarding (persist the code through the redirect).
- **Attribution:**
  - users.referredBy {squadId, inviterId, at};
  - a "Recruiter" count on member cards;
  - gaEvent squad_invite_view / squad_invite_signup / squad_invite_join.
- **Dynamic OG image** for invite links, so pasted links unfurl nicely in Discord. Pattern: app/p/[handle]/opengraph-image.tsx.

### 3. Squad hub /squads/[slug] (members only)
**Feed**
- Events are generated at ingest time, only for members with sharing.results on:
  - a win vs a higher-MMR opponent (> +150);
  - new peak MMR;
  - league promotion;
  - win streak ≥ 5;
  - first win with a new build;
  - long-game comeback.
- Stored in `squad_feed` {squadId, userId, kind, payload, gameId?, createdAt}:
  - payload holds numbers only, plus opponent race/MMR — never opponent names;
  - TTL 60 days; deduped per (userId, gameId, kind).
- Reactions from a small emoji set are allowed. No comments in v1.

**Weekly leaderboards**
- Reset Monday 00:00 in the squad's timezone. Results are stored at week end in `squad_weekly_results` for history.
- Categories, so everyone can win something:
  - games played;
  - MMR gained;
  - win rate (min 10 games);
  - average macro score (min 5 games);
  - longest streak.
- Only members with sharing.leaderboards appear.

**Member cards:** race, MMR (if shared), this week's W-L, main openers, last active.

**Squad scrims:** games where both players are members (match the other player's toon handle to member profiles) → internal head-to-head records.

**Squad goals** (set by owner/officer), e.g. "Everyone Diamond by season end", with live progress bars from members' data.

### 4. Squad Scouting Pool (the killer feature)
- **Opponent dossier:** when a member views /app/opponents/[pulseId], add a "Squad intel" section. For each squad the viewer belongs to, aggregate games by members with sharing.opponentIntel whose opponent.pulseId matches:
  - total games and W-L;
  - openings/strategies seen, with counts;
  - most recent date;
  - which squadmates faced them (names are fine inside the consenting squad).
- **Pre-game:** extend the live-game panel on Today and the overlay scouting widget with one line when squad intel exists, e.g. "Squad: 3 games · 2× Cannon Rush · last seen 4 days ago". Keep it behind the overlay's existing widget settings so streamers opt in.
- **Query cost:**
  - one indexed query with {userId: {$in: memberIds}, "opponent.pulseId": X};
  - check the existing indexes with explain() and add a compound index if needed;
  - cache per (squad, pulseId) for 60 s in-process;
  - never scan.

### 5. Discord app — HTTP interactions only (no gateway, no bot process)
**POST /v1/discord/interactions**
- Verify the Ed25519 signature (X-Signature-Ed25519 + X-Signature-Timestamp over timestamp + raw body) with Node's built-in crypto: crypto.verify(null, msg, publicKey, sig) with an ed25519 KeyObject. No new crypto dependency.
- Reject stale timestamps (> 5 min).
- PING → PONG.
- Anything slower than ~2 s answers with a deferred response, then edits the original message through the interaction webhook.

**scripts/discord-register-commands.js** registers global slash commands (idempotent). Commands:
- **/sc2 link** — ephemeral link to connect your Discord account (OAuth2 identify; store users.discord {id, username, linkedAt}).
- **/sc2 me** — card: current MMR, this week's W-L, streak, top opener, and a link to the public profile if the user has one.
- **/sc2 scout <name or battletag>**:
  - public SC2Pulse lookup;
  - the k-anonymous community aggregate that /community/opponents already publishes (≥ 5 users only);
  - squad intel (ephemeral) when the server is linked to a squad the caller belongs to.
- **/sc2 squad** — this week's leaderboard for the squad linked to this server.
- **/sc2 meta <matchup>** — top openers this week from the Meta Radar (services/ladderMeta.js), linking to /meta (or /guides if it exists).

**Squad ↔ channel link**
1. From the squad hub, "Connect Discord" → OAuth2 with scopes applications.commands + webhook.incoming.
2. Discord returns an incoming-webhook URL for the chosen channel.
3. Encrypt and store it via platformCredentialVault in `squad_discord_links` {squadId, guildId, channelId, webhook (encrypted), postKinds, createdBy}.

No bot permissions are needed.

**Posting**
- `discord_outbox` {squadId, kind, embed, attempts, nextAttemptAt, status}, drained by a lightweight interval job (every 30 s, single-flight) that:
  - respects Discord 429 retry_after;
  - retries with backoff;
  - disables a link after repeated 404/401 (webhook deleted) and notifies the squad owner.
- Schedule:
  - feed events are batched into a digest post, at most every 15 minutes per squad;
  - the weekly leaderboard posts on Monday;
  - promotions and new members post immediately.

**Embeds:** consistent branding, race colors from the design tokens, numbers only (no opponent names), and a link back to sc2tools.com on every post.

### 6. Public squad directory (optional, opt-in)
- /squads (public) lists squads with visibility public_listed: name, tag, member count, race mix, combined weekly record, "Request to join".
- Indexable; include them in the sitemap.

## Privacy, safety, abuse
- Sharing is per member and per data type; the defaults are documented.
- Opponent names never leave a squad. Discord posts use race + MMR only.
- Rate limits: invites 20/day; join attempts 30/hour; Discord commands per guild per minute.
- Report squad / report member → the existing moderation queue.
- Owners can kick, ban and rotate invite codes.
- Deleting your account (GDPR) removes memberships, feed items, reactions, Discord links you created, and pending outbox messages.
- Update /legal/privacy.

## Tests
- **API Jest:**
  - squad lifecycle + role-permissions matrix;
  - invite expiry, max uses, and auto-join after sign-up;
  - sharing toggles honored by every read path (feed, leaderboard, intel, Discord);
  - feed generation from ingest (idempotent, fail-soft, no opponent names);
  - leaderboard week boundaries across time zones;
  - the intel query uses an index (assert with explain() in a test on the memory server);
  - Discord signature verification (valid, invalid, stale timestamp) and PING;
  - each command with deferred follow-up (mock Discord HTTP);
  - outbox retry/backoff/disable;
  - GDPR coverage.
- **Web vitest:** invite page states, sharing-consent dialog, squad hub sections, notification bell.
- **Playwright:** /s/join/[code] renders signed-out on mobile and desktop.

## Rollout
- Flags, default off:
  - SQUADS_ENABLED / NEXT_PUBLIC_SQUADS_ENABLED;
  - DISCORD_APP_ENABLED, plus DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY, DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.
- Document Discord developer-portal setup in docs/discord.md: interactions URL, OAuth redirect, command registration.
- Start with squads; enable Discord once the outbox is proven.

## Definition of done
- [ ] Create a squad, invite a friend by link; the friend signs up and lands in the squad. The feed, leaderboard and scouting pool reflect real games, with sharing respected.
- [ ] Discord: link a channel and see a digest and the Monday leaderboard. All slash commands work, including deferred responses, with no gateway connection.
- [ ] No ingest slowdown (measure); no opponent names in any Discord payload (test).
- [ ] api check + web lint/typecheck/test + Playwright green; CHANGELOG.md; docs/squads.md and docs/discord.md.

## PR slices
1. Notifications primitive.
2. Squads core + invites + hub skeleton.
3. Feed + leaderboards + scrims + goals.
4. Scouting pool (dossier, live panel, overlay).
5. Discord interactions + commands.
6. Channel linking + outbox + digests.
7. Public directory.
````

---

## 5. Replay Review Exchange — "Stack Overflow for SC2 replays"

> Post a game with a question. Higher-league players answer with comments pinned to exact moments on your 2D replay and map. Reviewer MMR is verified from their own synced replays, helpful reviewers earn reputation, and coaches get "Book a lesson" leads. Every answered request becomes an indexable Q&A page.

````text
You are implementing the **Replay Review Exchange** for sc2tools.com (repo ReSpOnSeSC2/sc2tools). Players post a game with a question, and other players answer with comments pinned to exact moments on the replay timeline and the 2D map. Reviewers' league is verified from their own synced games, helpful reviewers earn reputation, and coaches get discovered. Plan first: read the files below, then post a short plan listing every file you'll add or change. Then implement in the PR slices at the end. If the code disagrees with this prompt, the code wins — adapt and explain in the PR.

## Why this exists
- "Can someone review my replay?" is one of the most common posts in SC2 communities (r/starcraft, race subreddits, Discord help channels). Today those requests are a file link plus a paragraph, and the answers are vague because nobody can point at a moment.
- sc2tools already combines what nobody else does:
  - a 2D map replayer with real unit sprites;
  - the build-order rail and the macro timeline;
  - deep links to a game time;
  - reviewer MMR that is verified from replays instead of self-reported.
- Every answered request is a unique, indexable page ("[PvZ] Why did my blink all-in fail?"). It turns the community into a content engine and gives high-league players and coaches a reason to visit daily.
- The site owner runs coaching. Good reviewers who are coaches get a "Book a lesson" button that feeds the existing Coaching Locker calendar.

## Ground truth (verified)

### Replay analysis UI
- Page: components/analyzer/game/GameDetailPage.tsx.
- MapReplaySection + MapReplayer: MapReplayer is a controlled component (time / onTimeChange / playing props) and a 1,800-line canvas renderer. Add a small optional prop such as onWorldClick(x, y, t) instead of editing its internals.
- The build-order rail and transport dock are in components/analyzer/game/replay/. The macro timeline components are in components/analyzer/macro/.
- Public, read-only precedent: components/public-profile/PublicReplayAnalysis.tsx.

### Access today
- Shared replay detail pages (/players/<handle>/replays/<gameId>) require sign-in (web/middleware.ts + lib/replayRouteAccess.ts).
- Public replay sharing is opt-in via users.replaySharing (routes/replays.js, publicReplays.js).
- Heavy data (buildLog, macroBreakdown, mapPlayback) lives in game_details or R2. Recorded playback may be segmented artifacts (routes/playbackArtifacts.js).
- Reuse the existing public-replay authorization logic and add a narrowly scoped grant: an open review request grants read access to that one game's analysis — nothing else from the owner.

### Moderation, GDPR, verified skill, coaching
- Moderation: util/contentFilter.js; community_reports + /v1/community/admin/reports + web /admin/moderation. Extend these; don't duplicate them.
- GDPR: services/gdpr.js must include every new collection.
- Verified skill sources: users.lastKnownMmr / lastKnownMmrRegion; per-game myMmr and opponent.leagueId on slim games rows; SC2Pulse data via services/pulseMmr.js.
- Coaching: the role-gated Coaching Locker (routes/coaching.js, services/coaching.js, web app/coaching) has coach records, published availability and bookings.

### Notifications
- If a `notifications` collection + bell already exist (from the Squads feature), reuse them.
- Otherwise build this minimal version: {userId, kind, title, body, href, readAt, createdAt}, with GET list / unread-count / mark-read and a socket push to user:<userId>.

### Stack and constraints
- Web: Next.js 15 / React 19 / Tailwind tokens / components/ui; useApi/apiCall; gaEvent. Dynamic OG precedent: app/p/[handle]/opengraph-image.tsx.
- API: Express CommonJS + JSDoc, AJV, buildXRouter(deps), makeServices(), COLLECTIONS + db/connect.js indexes, stampVersion, boundedRateLimitStore; Jest + mongodb-memory-server + supertest.
- One Render Starter instance; ALL DATA IS REAL; docs/engineeringexplanation.md; CHANGELOG.md.

## What to build

### 1. Asking for a review
- **Entry point:** "Ask for a review" on /app/game/[gameId]. Fields:
  - question (20–500 chars, required);
  - focus tags: build order, macro, scouting, army control, decision making, micro, specific timing;
  - optional time range of interest;
  - desired reviewer level: anyone / my league or higher / Masters+;
  - visibility: public board / squad only (if Squads exists) / link only.
- **Eligibility:**
  - a 1v1 game with a macro breakdown (map playback is optional but boosts ranking);
  - max 3 open requests per user and 3 new per day.
- **Privacy by default:**
  - The OPPONENT is a third party who didn't consent. Public payloads replace the opponent's name, battle tag, pulseId and toon handle with e.g. "Opponent (Zerg, ~4,100 MMR)".
  - The asker chooses to show their display name or appear as "Anonymous Protoss".
  - Chat is not extracted, so there is nothing to redact there. Keep it that way.
- **Storage:** freeze a redacted snapshot at posting time in `review_requests` {_id, userId, gameId, question, tags, matchup, map, result, durationSec, askerBand, desiredLevel, visibility, status: open|answered|closed|removed, reviewCount, helpfulCount, lastActivityAt, createdAt}.
  - Heavy analysis is served live through the scoped grant.
  - If the owner deletes the game, the request closes.

### 2. The review page — /reviews/[id]
**Access**
- Public and readable without signing in. It's a separate route: unlike /players/…/replays/…, it must not be behind the auth middleware, because the asker opted in.
- Signing in is required to comment, vote or mark helpful.

**Layout**
- Desktop: the replay (MapReplayer + build-order rail + transport) on the left or top; the question and threaded comments on the right or below.
- Mobile: the replay pins at the top and comments scroll beneath it (the macro breakdown already uses this pattern).

**Timestamped comments**
- "Comment at 5:12" captures the current replay time.
- Optional map pin (world x, y) captured with onWorldClick; optional short range (5:12–5:40).
- Each comment shows a time chip that seeks and pauses the replayer.
- Pins draw as small numbered markers on the map while the replay is near that time.
- A marker strip on the timeline shows where comments cluster.

**Comment body:** 10–2,000 chars, a safe markdown subset (no raw HTML; links nofollow ugc), one level of replies.

**Actions**
- Asker: mark comments helpful, choose one "best review", close.
- Other signed-in users: upvote. No downvotes — use Report.

**Reviewer badges** on every comment:
- Verified league/MMR band and race, computed from the reviewer's own synced ladder games (highest band in the current or previous season, with a minimum game count). "Unverified" otherwise.
- A "Coach" badge for linked Coaching Locker coaches, with a "Book a lesson" link when they have published availability.

**Anti-spam**
- Commenting requires ≥ 20 synced games.
- Rate limits: 30 comments/hour and 200/day.
- contentFilter on all text.
- Report → moderation queue; auto-hide after N distinct reports, pending admin review.
- Users can block a reviewer: their comments are hidden from the blocker, and they can't comment on the blocker's requests.

### 3. Review Board — /reviews
- Public, server-rendered feed.
- Filters: matchup, league band, focus tag, unanswered.
- Sorts: Hot (activity with age decay), New, Top.
- Cards: matchup, map thumbnail (lib/map-images.ts), result, asker band, question, age, review count, "best review" tick.
- Signed-in users also get "Requests you can help with": their race's matchups at or below their verified band.

### 4. Reputation
- **Ledger:** `review_karma_events`, idempotent via unique {commentId, kind, actorId}:
  - helpful +5;
  - best +15;
  - upvote +1 (max +10 per comment);
  - removed by moderation −20.

  Totals are materialized on the user.
- **Badges:** First Review, Helpful ×10, Mentor (50 helpful), Best Answer ×10, plus verified-league flair (e.g. "Masters Mentor").
- **Leaderboard:** a weekly reviewer leaderboard on /reviews (opt-in public name).
- **Profile:** a reviewer section on /p/[handle] when public (karma, best answers, matchups reviewed).

### 5. Notifications and sharing
- **Notifications:**
  - the asker, on a new review (grouped);
  - the reviewer, when marked helpful or best;
  - a weekly "N open requests in your matchups at your level".

  All in-app. Email only if an email provider exists, which it doesn't today.
- **Sharing:**
  - "Post to Reddit" with a prefilled title ("[PvZ] Why did my blink all-in fail? — timestamped replay review") and link;
  - Discord copy;
  - a dynamic OG image (matchup, question snippet, review count, map thumbnail).

### 6. SEO
- Quality gate: /reviews/[id] is indexable only once it has ≥ 1 helpful or best review. Before that it is noindex.
- JSON-LD:
  - QAPage: Question with answerCount; acceptedAnswer = the best review; suggestedAnswer = helpful reviews;
  - BreadcrumbList.
- Add answered reviews to the dynamic sitemap (create a dynamic sitemap if it is still static).
- Canonical URLs. Titles like "[PvZ] Why did my blink all-in fail? — Replay Review | SC2 Tools".

### 7. API (Clerk auth unless noted)
**Endpoints**
- POST /v1/reviews — create from your own gameId
- GET /v1/reviews — public board, cursor
- GET /v1/reviews/:id — public, redacted
- GET /v1/reviews/:id/analysis — public, via the scoped grant; returns the same shapes the game page uses, redacted
- POST /v1/reviews/:id/comments
- PATCH/DELETE own comment — edit window 15 min; delete leaves "[deleted]" if the comment has replies
- POST /v1/reviews/:id/comments/:cid/{helpful,best,upvote,report}
- POST /v1/reviews/:id/close
- GET /v1/me/reviews — asked / answered

**Route rules:** public routes are mounted before auth routers, rate-limited, and return Cache-Control public s-maxage=60 for board/list pages.

**Collections**
- review_requests
- review_comments {requestId, authorId, parentId?, gameTimeSec, endTimeSec?, mapPoint? {x, y}, body, upvotes, helpful, best, reportCount, status, createdAt, editedAt}
- review_karma_events
- review_blocks

Add indexes for the board sorts, per-request comment listing, and per-user history.

## Tests
- **API Jest:**
  - create eligibility and caps;
  - redaction: seed a known opponent name, battle tag, pulseId and toon handle, and assert none appear in any public response or OG payload;
  - the scoped grant: can read that game's analysis, cannot read any other game of the owner, revoked when the request closes;
  - comment rules: verification gate, rate limits, contentFilter, edit window, soft delete;
  - helpful/best/upvote idempotency and karma math;
  - report → moderation queue → auto-hide;
  - block;
  - GDPR: account deletion anonymizes authored comments to "[deleted user]" and removes requests;
  - indexability gate.
- **Web vitest:**
  - time-chip seeking (MapReplayer receives the new time);
  - pin placement from onWorldClick;
  - marker strip;
  - composer validation;
  - markdown sanitizer;
  - board filters.
- **Playwright:** a signed-out visitor opens /reviews and a review page on mobile and desktop (no horizontal scroll, replay visible, comments readable).

## Rollout
- Flags REVIEWS_ENABLED / NEXT_PUBLIC_REVIEWS_ENABLED, default off → admins → everyone.
- Seed the board at launch by asking a few high-league friends to answer the first requests. Don't fake content.

## Definition of done
- [ ] Post a request from a real game. A second account reviews it with time- and map-pinned comments, and the asker marks one best. Karma and badges update, notifications fire, and the page becomes indexable with valid QAPage JSON-LD.
- [ ] Zero opponent identity leakage (test). Signed-out viewing works; commenting requires sign-in + ≥ 20 synced games.
- [ ] api check + web lint/typecheck/test + Playwright green; CHANGELOG.md; docs/reviews.md (moderation playbook, karma rules, privacy model).

## PR slices
1. Notifications (if missing) + data model + create/list/read with redaction and the scoped grant.
2. Review page with replayer integration and timestamped/pinned comments.
3. Helpful/best/upvote, karma, badges, reviewer verification, coach badge.
4. Moderation, blocks, rate limits.
5. Board, SEO, OG images, sharing, weekly digest.
````

---

## Bonus: issues spotted while researching

All but one were verified and fixed on this branch (agent **0.17.2** plus web changes; see `CHANGELOG.md`):

- **Fixed — slim `apm` / `spq` were always null.** `replay_pipeline.py` read them from `PlayerInfo`, which has neither field. They now come from the APM curve and the macro breakdown's `raw.sq`.
- **Fixed — APM/SPM curve credited the wrong player.** `_compute_apm_curve` compared sc2reader's 0-based user id with the 1-based player slot. It now resolves the slot the way the replay engine does.
- **Fixed — Map Intel death zones were always empty.** Lost fights are now measured from each side's army-value-lost counter and placed where the user's units died.
- **Fixed — 5 of 6 Arcade badges were unearnable.** Run tracking added for Streak Hunter, Veto Sleuth, Closer and Detective. Stock Market weeks now settle, which enables Tycoon and puts real P&L on the weekly leaderboard; it had only ever received 0%.
- **Fixed — nothing linked to `/p/[handle]`.** Author pages and Settings → Profile now link to it.
- **Fixed — stale counts.** Sign-up page, README and the Arcade README now match the registries (30 widgets, 18 modes). The unused old landing page code was removed.
- **Removed — the unused optimizer simulator.** Its Build adapter UI was deliberately removed on 2026-07-11 (commit `110ddf4c`), and the library was flagged for removal then. The simulator is deleted. The balance-patch data the map replayer uses to price lost units moved to `apps/web/lib/sc2-patch/`.
