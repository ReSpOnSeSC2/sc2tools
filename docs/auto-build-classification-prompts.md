# Auto Build-Order Classification — Implementation Prompt Pack

A sequenced set of self-contained AI prompts that produce the **Auto
Build-Order Classification** feature end-to-end: fully-wired backend +
frontend, no mock data, professional UI. Paste them **in order**, one per
turn. Each prompt names the exact files to touch and the acceptance bar to
hit.

---

## What we are building (read once, top to bottom)

Today, every analysed replay gets a `myBuild` tag. Replays that don't match
any named or custom build fall into a catch-all bucket — surfaced as
**"Macro Transition (Unclassified)"** / **"Unclassified - <Race>"** in the
Python core and as a missing/default `myBuild` in the cloud. These games are
invisible to the build library's per-build analytics.

The feature scans that unclassified bucket **per matchup** (PvP, PvT, PvZ and
the Terran / Zerg equivalents), finds groups of games whose openings match
each other very closely (**minimum 5 games per group**), **auto-names** each
group, and **auto-creates a classification** so those games — and future ones
— are labelled with the new build name. It must **never** re-tag a game that
already matches an existing named build or user custom build.

### How the existing system works (ground truth — cite these in code)

- **Cloud rule engine:** `apps/api/src/services/buildRulesEvaluator.js`.
  - v3 rule shape: `{ type, name, time_lt, count? }` where `type ∈
    {before, not_before, count_max, count_exact, count_min}`.
  - `eventToken(ev)` → canonical token (`BuildStargate`, `TrainPhoenix`,
    `ResearchBlink`, `MorphBaneling`). This is the **only** correct way to
    normalise an event; reuse it, do not re-implement.
  - `UNIT_TECH_PREREQUISITES` is the anti-hallucination filter (a Phoenix only
    counts if a Stargate was started by its time). Reuse it.
  - `evaluateRules(rules, events)` → `{ pass, almost, failedRule,
    failedReason }`. All rules AND together.
- **Game shape** (from `perGameCompute.listForRulePreview`,
  `apps/api/src/services/perGameCompute.js:473`): `{ gameId, myBuild, myRace,
  oppRace, opponent, buildLog[], oppBuildLog[], events[] (parsed),
  oppEvents[], result, date, map, durationSec, macroScore, apm, spq }`.
  `events`/`oppEvents` are the parsed shape `eventToken` expects.
- **Custom build doc + validation:** `apps/api/src/validation/customBuild.js`.
  Required `slug, name, race`; `rules` max 30; rule `name` must match
  `^[A-Za-z][A-Za-z0-9]*$`; `time_lt` 1–1800. New saves stamp
  `schemaVersion: 3`.
- **Classification = the `myBuild` field on the game doc.** Tagging logic
  lives in `CustomBuildsService` (`apps/api/src/services/customBuilds.js`):
  `reclassify` (one build), `reclassifyAll` (most-specific build wins, ties by
  `updatedAt desc`), and the helpers `extractRules`, `gameMatchesBuildMatchup`,
  `filterMatchingGames`, `tagGames`. **Reuse these — the auto-classifier is a
  new producer of custom builds, not a new tagging path.**
- **Existing clustering reference (Python, legacy DB):**
  `SC2Replay-Analyzer/analytics/clustering.py` — feature vectors + auto-naming
  (`_auto_name`). Use it as a *design reference* for naming/cohesion; the cloud
  implementation is JS so it stays fully wired without a Python round-trip.
- **ML job pattern (if you ever need Python):** `apps/api/src/services/ml.js`
  + `apps/api/src/routes/ml.js` — Socket.io progress, `mlJobs` collection.
- **Router wiring:** `apps/api/src/app.js` (`makeServices` builds services,
  `mountRoutes` mounts routers with a `deps` object). Custom builds router is
  `apps/api/src/routes/customBuilds.js`, wired at `app.js:58`.
- **Frontend:** Next.js 15 / React 19 / Tailwind / SWR / Clerk. Build UI in
  `apps/web/components/builds/` (`BuildsLibrary.tsx`, `BuildCard.tsx`,
  `BuildEditorSheet.tsx`, `BuildFilterBar.tsx`, `types.ts`). Data hook:
  `apps/web/lib/clientApi.ts` (`useApi<T>()`, Clerk JWT auto-attached).
- **Design tokens (obey exactly):** `docs/design-system.md`. Surfaces
  `#0A0E1A → #111827 → #1F2937`; race accents Terran `#3B82F6`, Zerg `#A855F7`,
  Protoss `#F59E0B`; success `#10B981`, danger `#EF4444`; text `#F1F5F9 /
  #94A3B8 / #64748B`; Inter + JetBrains Mono; radii 4/8/12/16; spacing on a
  4px grid.

### Global constraints (apply to EVERY prompt)

- **No mock/placeholder data.** Every value comes from the user's real games
  through the real services. If a path can't be wired, stop and say so.
- **No file over 800 lines.** Split into focused modules before you cross it.
- Match the file's existing style (CommonJS `"use strict"` in `apps/api`,
  TS + Tailwind in `apps/web`). JSDoc on exported functions like neighbours.
- Pure logic must be unit-testable without Mongo; put it in standalone modules.
- Don't add deps unless a prompt says so. No new ML libs — the discovery
  engine is deterministic JS.
- Wire it for real: services constructed in `makeServices`, routes mounted in
  `mountRoutes`, frontend reachable from a real screen. End each prompt by
  running the touched test suite.

---

## Prompt 1 — Signature extraction (pure module, backend)

> **Goal:** Turn a game's parsed `events` into a compact, comparable **opening
> signature** so we can group games that opened the same way.
>
> Create `apps/api/src/services/autoClassify/signature.js` (`"use strict"`,
> CommonJS). It must NOT import Mongo. Reuse
> `eventToken` and `UNIT_TECH_PREREQUISITES` from
> `../buildRulesEvaluator` — do not re-tokenise by hand.
>
> Export:
> - `extractSignature(events, { horizonSec = 480 } = {})` → an ordered array
>   of `{ token, t }` for every **tech-building** and **first-of-its-kind
>   unit** event before `horizonSec`, with hallucinated units filtered out via
>   the same prerequisite check `buildRulesEvaluator` uses. Collapse repeats of
>   the same token to their first occurrence but keep a `count` of how many
>   landed before the horizon. Drop economy/noise tokens (Nexus/CommandCenter/
>   Hatchery/Pylon/SupplyDepot/Overlord/Probe/SCV/Drone/Assimilator/Refinery/
>   Extractor) — they don't discriminate openings; define this exclusion set as
>   a named constant with a one-line rationale.
> - `signatureKey(signature)` → a stable string of the **first 6** tech tokens
>   in order (the coarse bucket key), e.g. `"BuildStargate>BuildRoboticsFacility>..."`.
> - `signatureDistance(a, b)` → a 0..1 dissimilarity combining (a) ordered
>   token overlap (normalised Levenshtein over the token sequences) and (b)
>   mean absolute timing delta on shared tokens, normalised by `horizonSec`.
>   Identical openings → 0; nothing in common → 1. Document the weighting.
>
> **Acceptance:** Add `apps/api/__tests__/autoClassifySignature.test.js` with
> hand-built event arrays proving: a real Stargate→Phoenix opening and a
> Sentry-hallucinated Phoenix produce different signatures; two stylistically
> identical openings score `distance < 0.15`; a Stargate-first vs Robo-first
> opening score `distance > 0.5`. `npm test` green in `apps/api`.

---

## Prompt 2 — Clustering the unclassified bucket (pure module, backend)

> **Goal:** Group unclassified games into tight candidate clusters of **≥ 5
> games**, deterministically, no ML deps.
>
> Create `apps/api/src/services/autoClassify/cluster.js`. Import from
> `./signature`. Export `clusterGames(games, { minGames = 5, maxDistance =
> 0.2, horizonSec = 480 } = {})`.
>
> Each input game is `{ gameId, events, result, date, map }` (already filtered
> to one matchup + perspective by the caller). Algorithm:
> 1. Compute each game's signature once.
> 2. Coarse-bucket by `signatureKey`.
> 3. Within each bucket, agglomerate by `signatureDistance ≤ maxDistance`
>    (single-linkage is fine) into sub-clusters.
> 4. Keep only sub-clusters with `≥ minGames`.
> 5. For each surviving cluster return `{ gameIds[], size, cohesion,
>    medoidGameId, representativeSignature, winRate, sampleGameIds[] }` where
>    `cohesion` = `1 - mean intra-cluster distance` (higher = tighter),
>    `medoidGameId` = the game minimising total distance to the rest, and
>    `representativeSignature` = the medoid's signature.
> 6. Sort clusters by `size desc, cohesion desc`.
>
> Pure and synchronous. **Acceptance:**
> `apps/api/__tests__/autoClassifyCluster.test.js` proves: 5 near-identical
> games form one cluster; a 6th wildly different game is excluded; a bucket of
> only 4 similar games yields **no** cluster (min-5 gate); cohesion is higher
> for a tighter group. Keep the file under 300 lines.

---

## Prompt 3 — Rule derivation + naming (pure module, backend)

> **Goal:** Convert a candidate cluster into (a) a **v3 rule set** that
> validates against `validation/customBuild.js` and round-trips through
> `evaluateRules`, and (b) a **human build name**.
>
> Create `apps/api/src/services/autoClassify/deriveBuild.js`. Reuse
> `evaluateRules` from `../buildRulesEvaluator`.
>
> Export `deriveRules(cluster, clusterGames)`:
> - From the tokens shared by **≥ 80%** of the cluster's games, emit `before`
>   rules with `time_lt` set to the cluster's **p90 timing** for that token,
>   rounded up to the next 15s, clamped to 1..1800.
> - Add one `not_before` rule for the single most discriminating *absent* tech
>   token (a token common in OTHER matchup games but rare here) when one exists
>   — this is what keeps the build from over-matching. Skip if none qualifies.
> - Cap at **6 rules** (most-discriminating first), names matching
>   `^[A-Za-z][A-Za-z0-9]*$`. **Self-check:** every game in the cluster must
>   pass `evaluateRules(rules, game.events)`; if not, relax the weakest rule
>   and retry (max 3 passes). Return `{ rules, selfMatchRate }` and require
>   `selfMatchRate ≥ 0.9` or return `null` (cluster not crisp enough to name).
>
> Export `deriveName(matchup, cluster, clusterGames)`:
> - Pattern `"<Matchup> - <Opening> into <Tech>"`, e.g.
>   `"PvZ - Stargate into Robo"`, derived from the first 1–2 tech tokens of the
>   representative signature mapped to display nouns (strip `Build/Train`
>   prefixes; map `RoboticsFacility→Robo`, `TwilightCouncil→Twilight`,
>   `Stargate→Stargate`, etc. — define the map as a constant). Append a timing
>   adjective only when distinctive (e.g. `(Fast)` when p50 of the lead tech is
>   well below the matchup median), mirroring the spirit of
>   `clustering.py:_auto_name`.
> - Return `{ name, slug }` where `slug` is the kebab-case of name + a short
>   hash of `representativeSignature` (stable across re-runs of the same
>   cluster), matching the slug pattern `^[a-zA-Z0-9._-]+$`.
>
> **Acceptance:** `apps/api/__tests__/autoClassifyDerive.test.js` proves the
> derived rules validate via `validateCustomBuild` and that **every** game in a
> fixture cluster passes `evaluateRules` with them; names are deterministic and
> collision-stable. Keep under 350 lines.

---

## Prompt 4 — AutoClassifyService: discovery + guardrails (backend)

> **Goal:** Orchestrate discovery over a user's real games, honouring every
> guardrail. This is the **dry-run brain** — it computes candidates but writes
> nothing.
>
> Create `apps/api/src/services/autoClassify.js` exporting class
> `AutoClassifyService`. Constructor takes `{ customBuilds, perGame }` (the
> already-built `CustomBuildsService` and `PerGameComputeService` instances).
>
> Method `discover(userId, { perspective = 'you', minGames = 5, maxDistance =
> 0.2 } = {})`:
> 1. Load games via `perGame.listForRulePreview(userId, { limit:
>    STATS_GAME_SCAN_CAP })` (reuse the cap the service already uses).
> 2. Load the user's existing custom builds via `customBuilds.list(userId)` and
>    pre-extract their rules with `extractRules`.
> 3. **Exclude already-classified games.** A game is in-scope only when its
>    `myBuild` is empty OR matches the unclassified set
>    `{null, '', /Macro Transition/i, /^Unclassified/i, /Default/i}` **and** it
>    does NOT satisfy any existing custom build's rules (reuse
>    `filterMatchingGames` / `evaluateRules` to test membership). Define the
>    unclassified-label matcher as an exported constant
>    `UNCLASSIFIED_LABEL_RE` with a comment citing the Python core labels.
> 4. Group in-scope games by **matchup + perspective** (derive matchup string
>    `"PvZ"` etc. from `myRace`/`oppRace` using the same letter convention as
>    the rest of the codebase).
> 5. For each matchup group: `clusterGames` → for each cluster `deriveRules` +
>    `deriveName`. Drop clusters where `deriveRules` returns `null`.
> 6. **Name-collision guard:** if a proposed name/slug already exists among the
>    user's builds (or the named catalog), suffix `" (Auto)"` / disambiguate,
>    never overwrite.
> 7. Return an array of **candidates**: `{ matchup, perspective, proposedName,
>    proposedSlug, race, vsRace, rules, gameCount, winRate, cohesion,
>    sampleGames: [{gameId, map, result, date}], selfMatchRate }`, sorted by
>    `gameCount desc`.
>
> No writes here. Keep the orchestration under 800 lines; if it grows, push the
> matchup-grouping + label helpers into
> `apps/api/src/services/autoClassify/scope.js`.
>
> **Acceptance:** `apps/api/__tests__/autoClassify.test.js` with an in-memory
> games fixture proves: a game already tagged with a real build is excluded; a
> game matching an existing custom build's rules is excluded; a 5-game lookalike
> group in the unclassified bucket becomes exactly one candidate with correct
> matchup, `gameCount: 5`, and validating rules.

---

## Prompt 5 — Apply path: create builds + reclassify (backend)

> **Goal:** Turn approved candidates into real custom builds and tag their
> games — reusing the existing tagging engine so the new labels behave exactly
> like hand-authored builds.
>
> Add to `AutoClassifyService` (`apps/api/src/services/autoClassify.js`):
>
> `apply(userId, candidates)` where each candidate is
> `{ proposedName, proposedSlug, race, vsRace, rules, perspective }` (the UI may
> have edited name/rules):
> 1. Re-validate each with `validateCustomBuild` — reject the batch with field
>    errors if any fail (no partial-garbage writes).
> 2. For each, `customBuilds.upsert(userId, { slug, name, race, vsRace, rules,
>    perspective, schemaVersion: 3, description: <generated provenance line>,
>    source: 'auto-classify' })`. Add `source` to the validation allow-list and
>    schema (optional string enum `['manual','auto-classify','import']`,
>    defaulting `manual`). **`source` is provenance metadata ONLY — it must
>    never gate behaviour.** An auto-classified build is a first-class custom
>    build: it must appear in `GET /v1/custom-builds` / the BuildsLibrary grid,
>    be editable in the BuildEditor, and be publishable to the community through
>    the existing publish flow (`isPublic` / `shareWithCommunity` +
>    `BuildPublishModal` / the `community` service) exactly like a hand-authored
>    build. Do not add any `source !== 'manual'` filter to the list, stats,
>    publish, or community code paths.
> 3. After all upserts, call `customBuilds.reclassifyAll(userId,
>    { clearUnmatched: false })` **once** so most-specific-wins ownership is
>    enforced globally — this guarantees a new auto build can't steal a game
>    that a more specific existing build owns. Return the reclassify summary
>    plus `{ created: [...slugs] }`.
> 4. **Idempotency:** upsert is keyed on `(userId, slug)` and slugs are
>    signature-stable (Prompt 3), so re-applying the same candidate updates in
>    place instead of duplicating. Add a test for this.
>
> **Acceptance:** extend `autoClassify.test.js`: applying a candidate creates a
> custom build, `reclassifyAll` tags its ≥5 games with the new name, and a
> previously-named game keeps its original tag (ownership respected).
> Re-applying the identical candidate creates 0 duplicates.

---

## Prompt 6 — API routes + wiring (backend)

> **Goal:** Expose discovery/apply over HTTP and wire the service into the app.
>
> Create `apps/api/src/routes/autoClassify.js` exporting
> `buildAutoClassifyRouter(deps)` (mirror the structure of
> `routes/customBuilds.js`: `router.use(deps.auth)`, `req.auth.userId`,
> 503 when `deps.autoClassify`/`deps.perGame` missing, `next(err)` on throw):
> - `GET /v1/auto-classify/candidates?perspective=you|opponent` → `discover(...)`.
>   Cache per `(userId, perspective, latestGameMs)` for 60s using the same
>   `latestGameDateMs` invalidation trick `customBuilds.js` already uses.
> - `POST /v1/auto-classify/apply` body `{ candidates: [...] }` →
>   `apply(...)`. Validate body shape; cap at 50 candidates per call.
>
> Wire it in `apps/api/src/app.js`: import `AutoClassifyService` in
> `makeServices`, construct it with the existing `customBuilds` + `perGame`
> service instances, add it to `deps`/services, and mount
> `buildAutoClassifyRouter` in `mountRoutes` next to the custom-builds router
> (line ~58 grouping). Follow the existing dependency-injection pattern exactly
> — do not new-up Mongo collections inside the route.
>
> **Acceptance:** `apps/api/__tests__/autoClassifyRoutes.test.js` (supertest
> against `buildApp` with a seeded in-memory store) proves: unauth → 401;
> `GET /candidates` returns the discovered shape; `POST /apply` with a returned
> candidate creates the build and 200s with a reclassify summary. Document both
> routes in `docs/community-builds-api.md` (or the API doc the repo uses).

---

## Prompt 7 — Frontend data layer + types

> **Goal:** Typed, real (no-mock) client access to the new endpoints.
>
> In `apps/web/components/builds/types.ts` add `AutoCandidate`,
> `AutoCandidateRule`, `AutoApplyResult` mirroring the API payloads exactly.
>
> In `apps/web/lib/` add `autoClassifyApi.ts`:
> - `useAutoCandidates(perspective)` — wraps the existing `useApi<...>()` SWR
>   hook against `GET /v1/auto-classify/candidates`. Surface `isLoading`,
>   `error`, `mutate`. Do NOT introduce a second fetch stack — use the same
>   Clerk-JWT `useApi` everything else uses.
> - `applyAutoCandidates(candidates)` — POSTs to `/v1/auto-classify/apply` via
>   the same authed fetch wrapper, returns the parsed result.
>
> **Acceptance:** types compile (`npm run typecheck` / `tsc --noEmit` in
> `apps/web`); the hook returns real data when pointed at a running API. No
> hard-coded sample arrays anywhere.

---

## Prompt 8 — "Auto-Discover Builds" UI (frontend, professional grade)

> **Goal:** A polished panel in the Builds library that shows discovered
> candidates and lets the user review + name + apply them. Obey
> `docs/design-system.md` tokens precisely.
>
> Create `apps/web/components/builds/AutoDiscoverPanel.tsx` (split into
> `AutoCandidateCard.tsx` + `AutoCandidateRulesPreview.tsx` if it nears 400
> lines — never exceed 800). Mount it inside `BuildsLibrary.tsx` as a collapsible
> section above the build grid, with a header **"Auto-Discover Builds"**, a
> perspective toggle (You / Opponent) reusing the existing toggle styling, and a
> "Scan now" affordance (re-`mutate`).
>
> Each candidate renders as a **card** (surface `#111827`, radius 12, 24/16
> padding) showing:
> - The proposed name as an **inline-editable** field (pencil affordance);
>   edits flow into the apply payload.
> - A matchup chip tinted by the user's race accent (Protoss `#F59E0B`, Terran
>   `#3B82F6`, Zerg `#A855F7`).
> - `gameCount` ("matched 7 games"), win-rate pill (success/danger tinted), and
>   a cohesion meter (0–100%) with a tooltip explaining "how tightly these
>   games match".
> - A **human-readable rule list** (`AutoCandidateRulesPreview`) translating
>   each v3 rule to plain English ("Stargate before 3:30", "no Robotics before
>   4:00") using JetBrains Mono for the timings — reuse/extract the rule→text
>   formatter the BuildEditor already uses if one exists; otherwise add a shared
>   `formatRule()` util and use it in both places.
> - A row of **sample replays** (map + W/L + date) linking to the existing game
>   detail view.
> - Primary **"Create build"** button + a per-card dismiss (X) that hides the
>   candidate locally for this session.
>
> States: skeleton loaders on `isLoading`; a friendly empty state ("No new
> build patterns yet — play at least 5 similar games in a matchup") when zero
> candidates; an inline error with retry on `error`. Fully keyboard-navigable;
> `aria-label`s on icon buttons; respects reduced-motion.
>
> Note: once a candidate is applied it becomes an ordinary custom build, so the
> standard build card's existing **Edit** and **Publish to community** actions
> apply to it unchanged — do not build a parallel editor/publish path for
> auto-builds.
>
> **Responsive — fully usable on mobile AND desktop (required).** This is a
> lightweight review-and-name flow, so it must work end-to-end on a phone, not
> just shrink. Use the same Tailwind breakpoint convention the rest of
> `apps/web` uses (`sm`/`md`/`lg`); match how `BuildsLibrary`/`BuildCard`
> already reflow.
> - **Layout:** candidate cards stack **single-column** on mobile (`< sm`) and
>   flow into the multi-column grid on `md+`. The panel header (title +
>   perspective toggle + "Scan now" + optional "Create all") wraps gracefully —
>   no horizontal scroll, no clipped controls — collapsing to a stacked/▾
>   layout on narrow widths.
> - **Touch:** every interactive element (name-edit pencil, Create, dismiss X,
>   perspective toggle, sample-replay links) has a **≥44×44px** touch target and
>   visible focus state. Do not hide any primary action behind hover-only — the
>   dismiss/edit affordances must be tappable, shown by default on touch.
> - **Inline rename on mobile:** tapping the name opens a real text input that
>   plays well with the mobile soft keyboard (no zoom-jank: input font ≥16px),
>   with explicit confirm/cancel controls rather than relying on blur.
> - **Content:** rule preview and sample-replay rows reflow/wrap on small
>   screens (timings in JetBrains Mono stay legible); long build names truncate
>   with an accessible full-text title/`aria-label`.
> - **No fixed pixel widths** that force horizontal scroll at 360px; test the
>   panel at 360px, 768px, and 1280px.
>
> **Acceptance:** renders real candidates from the running API; editing a name
> and clicking Create sends the edited value; no layout shift between
> loading/loaded; matches the dark theme tokens; **fully operable at 360px,
> 768px, and 1280px with no horizontal scroll and ≥44px touch targets**. Add a
> Storybook/Jest render test if the repo has the harness
> (`apps/web/components/builds/__tests__/`).

---

## Prompt 9 — Apply flow, feedback, and library refresh (frontend)

> **Goal:** Make "Create build" feel instant and trustworthy, and keep the
> library consistent afterward.
>
> Wire the card's Create (and an optional **"Create all"** bulk action in the
> panel header) to `applyAutoCandidates`. On success:
> - Toast "Created <name> — tagged <n> games" using the app's existing toast
>   system (find it; don't add a new one).
> - `mutate` the auto-candidates list (the applied one disappears) **and**
>   revalidate the build library + `/v1/custom-builds/stats` SWR keys so the new
>   build appears in the grid with real numbers immediately.
> - Optimistically remove the applied card; roll back + show an inline error
>   toast on failure (surface server field errors verbatim).
> - Disable the button + show a spinner while in flight; guard against
>   double-submit.
>
> **Mobile parity (required):** the entire apply flow works on a phone — the
> Create / "Create all" / dismiss controls are tappable (≥44px, not hover-only),
> success/error toasts render where they're visible on small screens (don't let
> them sit off-canvas or under a fixed mobile nav bar), and the optimistic card
> removal + grid refresh behave identically on touch. No full-page reloads on
> any breakpoint.
>
> **Acceptance:** creating a build from the panel makes it show up in the main
> grid without a manual refresh; the candidate list shrinks by exactly one;
> failure path restores the card and tells the user why. No full-page reloads.
> Verified working on mobile (≤768px) and desktop.

---

## Prompt 10 — Feature flag, empty-DB safety, changelog/versioning, docs

> **Goal:** Ship-safe rollout, discoverability, and a correct changelog +
> versioning pass that satisfies CI — without performing a release.
>
> **A. Feature flag + empty-DB safety**
> - Gate the Auto-Discover panel behind the repo's existing feature-flag
>   mechanism (find how a recent feature flags itself; reuse it), defaulting
>   **on** for the build owner. Backend routes stay available regardless of the
>   flag.
> - Guarantee graceful behaviour with sparse data: when no matchup has ≥5
>   lookalike unclassified games, `discover` returns `[]`, the UI shows its
>   empty state, and **zero** errors are thrown.
>
> **B. Changelog (always required)**
> - Add an entry under the `## [Unreleased]` section of `CHANGELOG.md`,
>   following the existing Keep-a-Changelog style already in that file
>   (`### Added` / `### Changed` etc.). Describe the Auto-Discover Builds
>   feature in user-facing terms (what it does, the min-5 rule, that it never
>   re-tags already-classified games). Do **not** invent a release header or
>   date — leave it under `[Unreleased]`.
>
> **C. Versioning — conditional, and CI-aware**
> This feature is **cloud-only** (`apps/api` + `apps/web`). Determine which
> case applies and act accordingly:
>
> - **If the change stays cloud-only (expected):** do **not** bump any version
>   file and do **not** create a git tag. The cloud API/web deploy through their
>   own pipeline; the suite version and installer tag are unrelated to it. The
>   `CHANGELOG.md` entry from step B is the only release-adjacent edit.
>
> - **If, and only if, this feature also ships inside the desktop
>   agent/installer:** bump the canonical suite version and keep its three
>   mirrors in sync, because `.github/workflows/version-check.yml` hard-fails
>   the PR if they diverge. Bump all three together (currently `1.4.7`):
>   1. `reveal-sc2-opponent-main/stream-overlay-backend/package.json` →
>      `"version"` (the canonical source).
>   2. `SC2Replay-Analyzer/__init__.py` → reads the canonical value; confirm it
>      resolves to the new version (no literal to edit unless the read path
>      changed).
>   3. `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/components/settings-foundation.jsx`
>      → `SETTINGS_VERSION` literal.
>
> - **If the agent's classifier/detector logic itself changed** (it should
>   **not** for this cloud feature — classification of existing and future games
>   is handled entirely cloud-side by `reclassifyAll` and the `tagSingleGame`
>   ingest hook — but verify): bump the agent version
>   `apps/agent/sc2tools_agent/__init__.py` → `__version__` (currently `0.8.8`),
>   matching the repo's `chore(release): bump agent to …` commit convention.
>
> **D. Tagging / release is OUT OF SCOPE for this prompt.** Do **not** create or
> push a `vX.Y.Z` git tag. Pushing such a tag triggers `release.yml`, which
> builds the Windows installer and publishes a public GitHub Release — a
> deliberate, human-gated step. Instead, if a version was bumped in step C, end
> your summary with an explicit note: *"Ready to release: tag `vX.Y.Z` and push
> to trigger the installer build."* and stop.
>
> **E. Docs + final pass**
> - Add a short "Auto-Discover Builds" section to the user-facing docs alongside
>   the custom-builds docs.
> - Confirm no touched file exceeds 800 lines; run the full `apps/api` and
>   `apps/web` test + typecheck suites; list any follow-ups (e.g. surfacing
>   auto-discovery in opponent scouting) without implementing them.
>
> **Acceptance:** flag toggles the panel; empty DB is silent and error-free;
> `CHANGELOG.md` has an `[Unreleased]` entry; **no** version files changed in
> the cloud-only case (and if they were, all three suite mirrors agree so
> `version-check` passes); **no** git tag created by the agent; all suites green.

---

## Suggested build order & dependencies

```
1 signature ─┐
2 cluster ───┼─> 4 discover ─> 5 apply ─> 6 routes ─> 7 client ─> 8 UI ─> 9 apply-flow ─> 10 ship
3 derive ────┘
```

Prompts 1–3 are independent pure modules (parallelisable). 4–6 are backend
integration. 7–10 are frontend + rollout. Each prompt ends green before the
next begins.

## Definition of done (whole feature)

- A user with ≥5 lookalike unclassified games in a matchup sees a named
  candidate, can rename it, and one click turns it into a real custom build
  that tags those games and all future matching ones.
- Games already owned by a named or custom build are never re-tagged.
- Re-running discovery/apply is idempotent (no duplicate builds).
- No mock data; backend and frontend fully wired; UI matches the design system;
  no file over 800 lines; all tests + typechecks green.
