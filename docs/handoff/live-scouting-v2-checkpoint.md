# Linked scouting and opening forecasts — 2026-10-25

The exact Wave3 `live-scouting-v2` plan item is implemented on
`codex/wave3-live-scouting-v2` in `.worktrees/wave3-guides-expansion`.
The original map706 and OBS724 branches remain preserved. The source includes
the actual main squashes through Tables727 (`e49840df`), including Scout725,
OBS724 and Token726. See ADR0045 for the deterministic sample/prior contract.

Approved player identities and cached account links resolve at most20 owned
opponent rows without upstream identity calls. Their summed record, aliases and
metadata feed the same dossier/live/native forecast; private notes stay on the
current toon. The strict owner preference `opponentScouting.groupByPlayer`
persists across list, dossier and live surfaces, with account-safe browser reads
and writes and generation-fenced cache invalidation.

The shared source is the latest50 matching owner/identity/race metadata rows,
with visibility and non-resume guards before the cap, ordered date/_id descending.
Short or invalid observations lower n without refill. A dossier whose existing
1000-row source cap prevents a complete matching source window explicitly
withholds its forecast. The optional existing public ladder prior is reversed
to their matchup against your recorded rating band, with three pseudo-games.
Recency half-life is8 observations; a known selected map weighs1.5. Top3 keep
their share of all categories and personal confidence never includes the prior.

Final local validation on integrated runtime `ffea2ea4`:

-70 API tests/9 suites and1 golden snapshot, including disposable Mongo owner,
  approved/cached identity, preference-off, bounded-window/tied-date parity,
  partial-source withholding, prior-only and cache invalidation cases.
-110 affected web tests/11 files (85+25 disjoint checks),85 Help checks/13 files,
  full web/API types and strict new-module lint.
-56 native tests/5 suites, offscreen/disposable fixtures, including posterior,
  zero-personal-history Low confidence and legacy transport/controller consumers.
-Required browser engine prebuild/smoke: bundle `604e9d4618a6414b`,223 files,
 79 pyc,1.19MiB; the final integrated Next build passes. No budget changed:
  landing214.6/215, Today230.6/240, dossier476.8/500, Dock224.5/225,
  game317/440, overlay235.6/240 kB. The full live card loads when a live packet
  exists, keeping its SSE subscription active while reducing initial Today JS.
-248 actual Chromium checks/16 reviewed captures at320/390/768/1440, light/dark,
  production CSS and real forecast/grouping/brief/Dock/overlay components with
  explicit synthetic auth/Next/API boundaries. Covers keyboard containment,
  Escape/outside/Done focus return,44px controls/no overflow, strict preference
  writes/reload/retry, held-token owner switch, auth loading/sign-out, prior-only
  n0, incomplete source withholding, and the public Dock privacy projection.
  Every browser request is restricted to a loopback fixture.

Reproduction from `apps/web`: `node tests/manual/scouting-v2-browser.cjs` after
the normal required-engine production build. The harness writes only its
`.tmp` bundle and `docs/handoff/screenshots/scouting-v2-*.png` evidence. The
actual API/math/native tests retain their independent fixtures; the browser API
does not call production. Local Next builds use loopback API and dummy Clerk
configuration, matching the existing CI build setup.

No AI/ML API, infrastructure, production query/migration/integration, installer
execution, signing, release, tag or version change occurred. Remote expected-head
CI and Vercel remain required before squash merge; the PR body records final gate
results without additional status-only source pushes.
